/**
 * 0.4.0 宿主端回归：传输记录持久化 + 分页 + 定位复核 + 文件夹下载打包。
 *
 * 这些测试直接打真实 HTTP 路由（跟 routes.test.js 同一套挂载方式），
 * 覆盖的是「功能写完了但悄悄坏掉」的地方：
 *
 *   1. 记录落盘到 transfers.json，重启后还在，且上次没跑完的被标成中断
 *   2. /transfers 支持 family + offset/limit 分页，返回 total
 *   3. /transfers/check 能识别「本机文件已被移动」
 *   4. /reveal 对「已被移动」的记录回 400 + 明确文案（不静默成功）
 *   5. /transfers 依然不泄露本机绝对路径
 *   6. 文件夹下载默认走服务端打包（archiveFiles + task/get 轮询）
 *
 * 跑法：node --test test/transfers.test.js
 */

import { createServer, request } from 'node:http'
import { strict as assert } from 'node:assert'
import { test, describe, before, after, beforeEach } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const credentialDir = mkdtempSync(join(tmpdir(), 'mcloud-transfers-test-'))
process.env.DSH_MCLOUD_CREDENTIAL_DIR = credentialDir

const { apply, __test } = await import('../lib/index.js')

const TRANSFERS_FILE = join(credentialDir, 'transfers.json')

/**
 * 挂一个真实 HTTP 服务器，把插件路由接上去。
 *
 * 注意：这里**不登录**（凭据目录是空的），所以凡是需要网盘的操作都会报未登录 ——
 * 这也正好验证「持久化和分页不依赖登录」。
 */
function mountPlugin() {
  return new Promise((resolve) => {
    const routes = []
    let server

    const webServer = {
      host: '127.0.0.1',
      get port() { return server?.address()?.port },
      protocol: 'http:',
      register(route) {
        routes.push(route)
        return () => {}
      },
    }

    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const route = routes.find((item) => item.kind === 'exact' && item.path === pathname)
      if (!route) {
        res.writeHead(404)
        res.end()
        return
      }
      Promise.resolve(route.handler(req, res)).catch(() => {
        res.writeHead(500)
        res.end()
      })
    })

    const ctx = {
      logger: { warn() {}, info() {}, error() {} },
      tools: { register: () => () => {} },
      effect: (factory) => { factory() },
      on() {},
      inject(names, callback) {
        callback({ webServer, effect: (factory) => { factory() } })
      },
    }

    server.listen(0, '127.0.0.1', () => {
      apply(ctx, {})
      resolve({ server, routes, port: server.address().port })
    })
  })
}

function send(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers, setHost: false },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, text }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 同源写请求（带上闸需要的所有头）。 */
function post(port, path, payload) {
  const body = JSON.stringify(payload ?? {})
  return send(port, {
    method: 'POST',
    path,
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-dsh-mcloud': '1',
      'content-length': Buffer.byteLength(body),
    },
    body,
  })
}

function get(port, path) {
  return send(port, { path, headers: { host: `127.0.0.1:${port}` } })
}

// ================================================================
// 1. 持久化
// ================================================================
describe('0.4.0：传输记录持久化', () => {
  test('启动时把 transfers.json 里的历史读回来，并且不上报本机路径', async () => {
    // 先写一份「上次留下的」记录文件
    const secretPath = 'C:\\Users\\someone\\Downloads\\dsh-mcloud\\a.zip'
    writeFileSync(TRANSFERS_FILE, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      transfers: [
        {
          id: 'old-dl', kind: 'download', label: 'a.zip', phase: 'complete',
          done: 100, total: 100, state: 'done', error: null,
          startedAt: Date.now() - 10_000, finishedAt: Date.now() - 5_000,
          localPath: secretPath, parentFileId: null, parentPath: null,
        },
        {
          id: 'old-up', kind: 'upload', label: 'r.pdf', phase: 'complete',
          done: 50, total: 50, state: 'done', error: null,
          startedAt: Date.now() - 9_000, finishedAt: Date.now() - 4_000,
          localPath: null, parentFileId: 'FOLDER-X', parentPath: '/a/b',
        },
      ],
    }), 'utf8')

    const ctx = await mountPlugin()
    try {
      const res = await get(ctx.port, '/api/dsh-mcloud/transfers')
      assert.equal(res.status, 200, res.text)
      const doc = JSON.parse(res.text)
      const ids = (doc.jobs || []).map((j) => j.id).sort()
      assert.deepEqual(ids, ['old-dl', 'old-up'], '历史记录没有被读回来：' + res.text)

      // 🔴 关键：本机绝对路径绝不能出现在响应里
      assert.doesNotMatch(res.text, /someone/, '/transfers 泄露了本机路径')
      assert.doesNotMatch(res.text, /Downloads/, '/transfers 泄露了本机路径')
      assert.doesNotMatch(res.text, /localPath/, '/transfers 里出现了 localPath 字段')

      // 但「能不能定位」这个布尔要留着
      const download = doc.jobs.find((j) => j.id === 'old-dl')
      assert.equal(download.canRevealLocal, false, '本机文件已经不存在，canRevealLocal 应该是 false')

      // 分页字段
      assert.equal(typeof doc.total, 'number', '缺少 total')
      assert.equal(doc.total, 2)
    } finally {
      ctx.server.close()
    }
  })

  test('上次退出时还在 running 的任务，重启后标成「中断」而不是一直转圈', async () => {    writeFileSync(TRANSFERS_FILE, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      transfers: [{
        id: 'stuck', kind: 'upload', label: 'big.iso', phase: 'upload',
        done: 10, total: 100, state: 'running', error: null,
        startedAt: Date.now() - 60_000, finishedAt: null,
        localPath: null, parentFileId: 'F', parentPath: '/x',
      }],
    }), 'utf8')

    const ctx = await mountPlugin()
    try {
      const res = await get(ctx.port, '/api/dsh-mcloud/transfers')
      const doc = JSON.parse(res.text)
      const job = (doc.jobs || []).find((j) => j.id === 'stuck')
      assert.ok(job, '记录丢了')
      assert.equal(job.state, 'error', '上次没跑完的任务应该标成 error，实际 ' + job.state)
      assert.match(String(job.error), /中断/, '没有说明「被中断」：' + job.error)
    } finally {
      ctx.server.close()
    }
  })

  test('记录文件里有坏数据也不崩（只忽略那一条）', async () => {
    writeFileSync(TRANSFERS_FILE, JSON.stringify({
      version: 1,
      transfers: [
        { id: 'good', kind: 'download', label: 'ok.zip', state: 'done', startedAt: Date.now() },
        { kind: 'download' },             // 没有 id，跳过
        null,                              // 垃圾
        'nonsense',                        // 垃圾
      ],
    }), 'utf8')

    const ctx = await mountPlugin()
    try {
      const res = await get(ctx.port, '/api/dsh-mcloud/transfers')
      assert.equal(res.status, 200, res.text)
      const doc = JSON.parse(res.text)
      assert.ok((doc.jobs || []).some((j) => j.id === 'good'), '好记录没读回来：' + res.text)
    } finally {
      ctx.server.close()
    }
  })
})

// ================================================================
// 2. 分页 / 分家
// ================================================================
describe('0.4.0：/transfers 的 family + 分页', () => {
  let ctx
  before(async () => {
    const rows = []
    for (let i = 0; i < 25; i += 1) {
      rows.push({
        id: 'u' + i, kind: 'upload', label: `up${i}.bin`, state: 'done', phase: 'complete',
        done: 1, total: 1, startedAt: Date.now() - (1000 - i) * 1000, finishedAt: Date.now(),
        localPath: null, parentFileId: 'F' + i, parentPath: '/p',
      })
    }
    for (let i = 0; i < 5; i += 1) {
      rows.push({
        id: 'd' + i, kind: 'download', label: `down${i}.bin`, state: 'done', phase: 'complete',
        done: 1, total: 1, startedAt: Date.now() - (500 - i) * 1000, finishedAt: Date.now(),
        localPath: null, parentFileId: null, parentPath: null,
      })
    }
    writeFileSync(TRANSFERS_FILE, JSON.stringify({ version: 1, transfers: rows }), 'utf8')
    ctx = await mountPlugin()
  })
  // 只关服务器：凭据目录是几个 describe 共用的，不能在这里删掉。
  after(() => { ctx.server.close() })

  test('family=upload 只回上传记录', async () => {
    const res = await get(ctx.port, '/api/dsh-mcloud/transfers?family=upload&limit=100')
    const doc = JSON.parse(res.text)
    assert.equal(doc.total, 25, '上传记录总数不对：' + res.text)
    for (const job of doc.jobs) assert.match(job.kind, /^upload/, '混进了非上传记录：' + job.kind)
  })

  test('family=download 只回下载记录', async () => {
    const res = await get(ctx.port, '/api/dsh-mcloud/transfers?family=download&limit=100')
    const doc = JSON.parse(res.text)
    assert.equal(doc.total, 5, '下载记录总数不对：' + res.text)
    for (const job of doc.jobs) assert.match(job.kind, /^download/, '混进了非下载记录：' + job.kind)
  })

  test('offset/limit 真的分页，而且按开始时间倒序', async () => {
    const first = JSON.parse((await get(ctx.port, '/api/dsh-mcloud/transfers?family=upload&offset=0&limit=10')).text)
    const second = JSON.parse((await get(ctx.port, '/api/dsh-mcloud/transfers?family=upload&offset=10&limit=10')).text)

    assert.equal(first.jobs.length, 10)
    assert.equal(second.jobs.length, 10)
    assert.equal(first.total, 25)
    assert.equal(second.total, 25)
    assert.equal(second.offset, 10)

    const firstIds = new Set(first.jobs.map((j) => j.id))
    for (const job of second.jobs) {
      assert.ok(!firstIds.has(job.id), '两页出现了重复记录：' + job.id)
    }

    // 倒序：第一页的最旧那条，应该比第二页的最新那条还新
    const oldestOfFirst = Number(first.jobs[first.jobs.length - 1].startedAt)
    const newestOfSecond = Number(second.jobs[0].startedAt)
    assert.ok(oldestOfFirst >= newestOfSecond, '没有按开始时间倒序')
  })

  test('不会因为记录多就把整个库吐出来（默认 limit 有上限）', async () => {
    const res = await get(ctx.port, '/api/dsh-mcloud/transfers?limit=99999')
    const doc = JSON.parse(res.text)
    assert.ok(doc.jobs.length <= 200, 'limit 没有封顶：' + doc.jobs.length)
    assert.equal(doc.limit, 200, 'limit 封顶值不对')
  })
})

// ================================================================
// 3. 定位复核
// ================================================================
describe('0.4.0：定位复核（文件被移动了就显示无法定位）', () => {
  const liveFile = join(credentialDir, 'still-here.bin')

  let ctx
  before(async () => {
    writeFileSync(liveFile, 'x', 'utf8')
    writeFileSync(TRANSFERS_FILE, JSON.stringify({
      version: 1,
      transfers: [
        {
          id: 'moved-away', kind: 'download', label: 'gone.zip', state: 'done', phase: 'complete',
          done: 1, total: 1, startedAt: Date.now() - 5000, finishedAt: Date.now() - 1000,
          localPath: join(credentialDir, 'this-file-was-deleted.bin'),
          parentFileId: null, parentPath: null,
        },
        {
          id: 'still-there', kind: 'download', label: 'here.bin', state: 'done', phase: 'complete',
          done: 1, total: 1, startedAt: Date.now() - 4000, finishedAt: Date.now() - 900,
          localPath: liveFile,
          parentFileId: null, parentPath: null,
        },
      ],
    }), 'utf8')
    ctx = await mountPlugin()
  })
  after(() => { ctx.server.close() })

  test('/transfers/check 对不存在的本机文件回 canReveal:false + local-missing', async () => {
    const res = await get(ctx.port, '/api/dsh-mcloud/transfers/check?jobId=moved-away')
    assert.equal(res.status, 200, res.text)
    const doc = JSON.parse(res.text)
    assert.equal(doc.canReveal, false, '文件已经不在了，还能定位？')
    assert.equal(doc.reason, 'local-missing')
    // 依然不能泄露路径
    assert.doesNotMatch(res.text, /this-file-was-deleted/, '/transfers/check 泄露了本机路径')
  })

  test('/transfers/check 对还在的文件回 canReveal:true', async () => {
    const res = await get(ctx.port, '/api/dsh-mcloud/transfers/check?jobId=still-there')
    const doc = JSON.parse(res.text)
    assert.equal(doc.canReveal, true, '文件还在却说不能定位：' + res.text)
    assert.equal(doc.kind, 'local')
  })

  test('/transfers/check 没有 jobId → 400，不猜', async () => {
    const res = await get(ctx.port, '/api/dsh-mcloud/transfers/check')
    assert.equal(res.status, 400, res.text)
  })

  test('/reveal 对「已被移动」的记录回 400 + 明确文案，而不是静默成功', async () => {
    const res = await post(ctx.port, '/api/dsh-mcloud/reveal', { jobId: 'moved-away' })
    assert.equal(res.status, 400, res.text)
    assert.match(res.text, /无法定位/, '没有说明「无法定位」：' + res.text)
    assert.match(res.text, /移动|删除/, '没有说明原因是「被移动或删除」：' + res.text)
  })

  /**
   * 🔴 0.4.4 第 3 条的主因回归：**文件还在**时，/reveal 必须真的拿到路径。
   *
   * 老代码是 `const found = client.getJob(id); target = found.localPath` ——
   * 而 getJob 返回的 snapshot() 为了不泄露本机路径，**故意不含 localPath**。
   * 于是 target 永远是空串，每一次定位都抛「这条记录没有记下本机位置」，
   * 表现就是「下载定位无效」。
   *
   * 这条用例把「文件真的存在」这条路径走一遍：只要还能读到这个毛病，它就红。
   */
  test('文件还在时：/reveal 能取到落点并交给 explorer（不再说「没有记下本机位置」）', async () => {
    const realDir = mkdtempSync(join(tmpdir(), 'mcloud-reveal-live-'))
    // 路径里**故意带空格**：这也覆盖了 explorer 参数引号那一层
    const realFile = join(realDir, 'a b.zip')
    writeFileSync(realFile, 'x', 'utf8')

    // 造一条「本机文件还在」的记录
    writeFileSync(TRANSFERS_FILE, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      transfers: [{
        id: 'live-dl', kind: 'download', label: 'a b.zip', phase: 'complete',
        done: 1, total: 1, state: 'done', error: null,
        startedAt: Date.now() - 3000, finishedAt: Date.now() - 1000,
        localPath: realFile, parentFileId: null, parentPath: null,
      }],
    }), 'utf8')

    const live = await mountPlugin()
    try {
      const res = await post(live.port, '/api/dsh-mcloud/reveal', { jobId: 'live-dl' })

      // 关键断言 1：不能报「没有记下本机位置」
      assert.doesNotMatch(
        res.text,
        /没有记下本机位置/,
        '/reveal 取不到 localPath —— getJob 返回的是不含路径的 snapshot（老 bug 又回来了）：' + res.text,
      )
      // 关键断言 2：走通了（explorer 被拉起来了）。非 Windows 上会明确报不支持，也算「越过了取路径这一步」。
      if (process.platform === 'win32') {
        assert.equal(res.status, 200, '/reveal 没成功：' + res.text)
        const doc = JSON.parse(res.text)
        assert.equal(doc.ok, true)
        assert.equal(doc.isDirectory, false)
      } else {
        assert.match(res.text, /只支持 Windows/, '非 Windows 应该明确说不支持：' + res.text)
      }

      // 关键断言 3：路径依然不能通过任何读接口泄露出去
      // （label 里当然有文件名 —— 那是给用户看的；不能出现的是**完整路径**）
      const list = await get(live.port, '/api/dsh-mcloud/transfers')
      assert.doesNotMatch(list.text, /localPath/, '/transfers 里出现了 localPath 字段')
      assert.doesNotMatch(
        list.text,
        /mcloud-reveal-live|[A-Za-z]:\\\\Users|[A-Za-z]:\\\\/,
        '/transfers 泄露了本机绝对路径：' + list.text.slice(0, 300),
      )
    } finally {
      live.server.close()
      rmSync(realDir, { recursive: true, force: true })
    }
  })
})

// ================================================================
// 0.4.7：删除传输**记录**（不是文件）
// ----------------------------------------------------------------
// 用户原话：「注意删除的不是文件，而是记录」。
// 所以这里断言两件事：
//   1. 删完之后 /transfers 里真少了那一条；
//   2. 删除动作**完全不碰**文件 —— 本机那个文件还在，也没有任何文件操作请求。
// ================================================================
describe('0.4.7：删除传输记录，不动文件', () => {
  function seed(rows) {
    writeFileSync(TRANSFERS_FILE, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      transfers: rows,
    }), 'utf8')
  }

  test('删单条：记录消失，本机文件还在', async () => {
    const realDir = mkdtempSync(join(tmpdir(), 'mcloud-keep-file-'))
    const realFile = join(realDir, 'keep-me.zip')
    writeFileSync(realFile, 'important', 'utf8')

    seed([
      {
        id: 'dl-keep', kind: 'download', label: 'keep-me.zip', phase: 'complete',
        done: 1, total: 1, state: 'done', error: null,
        startedAt: Date.now() - 5000, finishedAt: Date.now() - 1000,
        localPath: realFile, parentFileId: null, parentPath: null,
      },
      {
        id: 'dl-other', kind: 'download', label: 'other.zip', phase: 'complete',
        done: 1, total: 1, state: 'done', error: null,
        startedAt: Date.now() - 4000, finishedAt: Date.now() - 900,
        localPath: null, parentFileId: null, parentPath: null,
      },
    ])

    const ctx = await mountPlugin()
    try {
      const res = await post(ctx.port, '/api/dsh-mcloud/transfers/remove', { jobId: 'dl-keep' })
      assert.equal(res.status, 200, res.text)
      assert.equal(JSON.parse(res.text).removed, 1)

      // 记录真的少了
      const list = JSON.parse((await get(ctx.port, '/api/dsh-mcloud/transfers')).text)
      const ids = (list.jobs || []).map((j) => j.id)
      assert.ok(!ids.includes('dl-keep'), '记录没删掉：' + JSON.stringify(ids))
      assert.ok(ids.includes('dl-other'), '把别的记录也删了：' + JSON.stringify(ids))

      // 🔴 本机文件必须还在
      assert.equal(existsSync(realFile), true, '文件被删掉了！用户要的是只删记录')
      assert.equal(readFileSync(realFile, 'utf8'), 'important', '文件内容被改动了')
    } finally {
      ctx.server.close()
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  test('一键删除：只清该 family，另一页的记录保留', async () => {
    seed([
      {
        id: 'u1', kind: 'upload', label: 'a.txt', phase: 'complete',
        done: 1, total: 1, state: 'done', error: null,
        startedAt: Date.now() - 5000, finishedAt: Date.now() - 1000,
        localPath: null, parentFileId: 'P', parentPath: null,
      },
      {
        id: 'u2', kind: 'upload', label: 'b.txt', phase: 'complete',
        done: 1, total: 1, state: 'done', error: null,
        startedAt: Date.now() - 4000, finishedAt: Date.now() - 900,
        localPath: null, parentFileId: 'P', parentPath: null,
      },
      {
        id: 'd1', kind: 'download', label: 'c.zip', phase: 'complete',
        done: 1, total: 1, state: 'done', error: null,
        startedAt: Date.now() - 3000, finishedAt: Date.now() - 800,
        localPath: null, parentFileId: null, parentPath: null,
      },
    ])

    const ctx = await mountPlugin()
    try {
      const res = await post(ctx.port, '/api/dsh-mcloud/transfers/clear', { family: 'upload' })
      assert.equal(res.status, 200, res.text)
      assert.equal(JSON.parse(res.text).removed, 2, '一键删除的数量不对：' + res.text)

      const list = JSON.parse((await get(ctx.port, '/api/dsh-mcloud/transfers')).text)
      const ids = (list.jobs || []).map((j) => j.id).sort()
      assert.deepEqual(ids, ['d1'], '只该删掉上传记录，下载记录要保留：' + JSON.stringify(ids))
    } finally {
      ctx.server.close()
    }
  })

  test('删不存在的记录 → 400，不静默成功', async () => {
    seed([])
    const ctx = await mountPlugin()
    try {
      const res = await post(ctx.port, '/api/dsh-mcloud/transfers/remove', { jobId: 'nope' })
      assert.equal(res.status, 400, res.text)
      assert.match(res.text, /找不到这条传输记录/)
    } finally {
      ctx.server.close()
    }
  })

  test('删除路由要过写接口的闸（跨站请求不能删记录）', async () => {
    seed([{
      id: 'x1', kind: 'download', label: 'x.zip', phase: 'complete',
      done: 1, total: 1, state: 'done', error: null,
      startedAt: Date.now() - 1000, finishedAt: Date.now(),
      localPath: null, parentFileId: null, parentPath: null,
    }])
    const ctx = await mountPlugin()
    try {
      const body = JSON.stringify({ jobId: 'x1' })
      const res = await send(ctx.port, {
        method: 'POST',
        path: '/api/dsh-mcloud/transfers/remove',
        headers: {
          host: `127.0.0.1:${ctx.port}`,
          origin: 'http://evil.example',
          'content-type': 'application/json',
          'x-dsh-mcloud': '1',
          'content-length': Buffer.byteLength(body),
        },
        body,
      })
      assert.equal(res.status, 403, '跨站请求居然能删记录：' + res.text)

      // 记录还在
      const list = JSON.parse((await get(ctx.port, '/api/dsh-mcloud/transfers')).text)
      assert.ok((list.jobs || []).some((j) => j.id === 'x1'), '被跨站请求删掉了')
    } finally {
      ctx.server.close()
    }
  })
})

// ================================================================
// 5. 0.4.5 第 1 条：上传记录必须能反查出**完整路径**
// ----------------------------------------------------------------
// 用户原话：「传输记录上传中无法定位上传的图片」
//
// 根因不在界面，而在宿主：上传记录里 `parentPath` 经常是 null（老记录 / 拖拽上传），
// 只有 `parentFileId`。界面拿不到层级名就只能退回根目录 ——
// 照片在 /Windows/实验/…/第一周实验结果 里，点定位却跳回 /，当然「找不到」。
//
// 修复是宿主用 BFS 反查祖先链（网盘没有「按 id 反查路径」的接口）。
// 这段逻辑不依赖凭据，所以直接拿一个假网盘结构测它本身。
// ================================================================
describe('0.4.5 第 1 条：按 fileId 反查完整路径（BFS）', () => {
  /** 造一个「能按目录列子项」的假 listFiles。 */
  function fakeListing(trees) {
    return async function listFiles(parentId) {
      const key = String(parentId || '/')
      return {
        items: (trees[key] || []).map((it) => ({
          id: it.id,
          name: it.name,
          size: 0,
          type: it.type,
          updatedAt: '',
        })),
        nextCursor: null,
      }
    }
  }

  test('能一路找到深处目录，并且 trail 带每级的真实 id（含目标自己）', async () => {
    const { resolveRemotePathBfs } = __test
    assert.equal(typeof resolveRemotePathBfs, 'function', '没有导出 resolveRemotePathBfs')

    const trees = {
      '/': [{ id: 'W', name: 'Windows', type: 'folder' }],
      W: [{ id: 'EXP', name: '实验', type: 'folder' }],
      EXP: [{ id: 'DIMG', name: '数字图像实验', type: 'folder' }],
      DIMG: [{ id: 'DEEP', name: '第一周实验结果', type: 'folder' }],
      DEEP: [{ id: 'IMG1', name: '照片.jpg', type: 'file' }],
    }

    // 传入的 parentFileId 就是「照片所在的那个目录」
    const result = await resolveRemotePathBfs('DEEP', { listFiles: fakeListing(trees) })
    assert.ok(result, '没有反查出路径（BFS 走空了）')
    assert.equal(result.path, '/Windows/实验/数字图像实验/第一周实验结果')
    assert.deepEqual(
      result.trail.map((e) => e.id),
      ['W', 'EXP', 'DIMG', 'DEEP'],
      'trail 里缺了真实 id（界面要靠它重建面包屑）：' + JSON.stringify(result.trail),
    )
    assert.deepEqual(
      result.trail.map((e) => e.name),
      ['Windows', '实验', '数字图像实验', '第一周实验结果'],
    )
  })

  test('根目录自己就直接返回 null（根不需要反查）', async () => {
    const { resolveRemotePathBfs } = __test
    const result = await resolveRemotePathBfs('/', { listFiles: fakeListing({}) })
    assert.equal(result, null)
  })

  test('找不到时返回 null，而不是抛错（调用方退回记录里的 parentPath）', async () => {
    const { resolveRemotePathBfs } = __test
    const trees = { '/': [{ id: 'A', name: '别的目录', type: 'folder' }] }
    const result = await resolveRemotePathBfs('NOT-THERE', { listFiles: fakeListing(trees) })
    assert.equal(result, null)
  })
})

// ================================================================
// 4. 记录文件夹入口 + 删除记录
// ================================================================
describe('0.4.x：记录可以删了（0.4.7 起），但只删记录', () => {
  /**
   * 0.4.0 时这里断言的是「/transfers/clear 不存在」——因为当时的设计是
   * 「记录永不删除」。0.4.7 用户明确要求加一键删除，所以这条约定被推翻了：
   * 路由重新存在，但语义被钉死成「**只删记录，不动文件**」
   * （文件那一条由「0.4.7：删除传输记录，不动文件」那组测试守着）。
   */
  test('/transfers/clear 重新存在，但只清记录', async () => {
    const ctx = await mountPlugin()
    try {
      const res = await post(ctx.port, '/api/dsh-mcloud/transfers/clear', {})
      assert.equal(res.status, 200, '一键删除路由应该可用：' + res.text)
      const doc = JSON.parse(res.text)
      assert.equal(doc.ok, true)
      assert.equal(typeof doc.removed, 'number', '应该回报删了多少条')
      assert.equal(doc.skipped, 0, '空记录表不该跳过任何东西')
    } finally {
      ctx.server.close()
    }
  })

  test('/transfers/info 只回文件名，不回绝对路径', async () => {
    const ctx = await mountPlugin()
    try {
      const res = await get(ctx.port, '/api/dsh-mcloud/transfers/info')
      assert.equal(res.status, 200, res.text)
      const doc = JSON.parse(res.text)
      assert.equal(doc.fileName, 'transfers.json')
      assert.equal(doc.path, undefined, '/transfers/info 泄露了绝对路径')
      assert.doesNotMatch(res.text, /Users|AppData|mcloud-transfers-test/, '泄露了本机路径：' + res.text)
    } finally {
      ctx.server.close()
    }
  })
})

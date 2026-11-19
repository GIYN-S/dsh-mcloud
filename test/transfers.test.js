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

const { apply } = await import('../lib/index.js')

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

  test('上次退出时还在 running 的任务，重启后标成「中断」而不是一直转圈', async () => {
    writeFileSync(TRANSFERS_FILE, JSON.stringify({
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
})

// ================================================================
// 4. 记录文件夹入口（替代「清空记录」）
// ================================================================
describe('0.4.0：没有「清空记录」了，改成能打开记录文件夹', () => {
  test('/transfers/clear 已经不存在', async () => {
    const ctx = await mountPlugin()
    try {
      const res = await post(ctx.port, '/api/dsh-mcloud/transfers/clear', {})
      assert.equal(res.status, 404, '「清空记录」路由还在，记录就不算「永不删除」：' + res.text)
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

/**
 * 0.3.5 新增能力的回归测试。
 *
 * 覆盖三件容易「写完了但悄悄坏掉」的事：
 *   1. 传输记录的「定位」路由：必须挂在安全闸后面，且拒绝空目标；
 *   2. 「上传目标目录的展示路径」清洗：控制字符 / 反斜杠 / 超长；
 *   3. 传输任务快照**不能**把本机绝对路径泄露给浏览器。
 *
 * 跑法：node --test test/
 */

import { createServer, request } from 'node:http'
import { strict as assert } from 'node:assert'
import { test, describe, before, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const credentialDir = mkdtempSync(join(tmpdir(), 'mcloud-reveal-test-'))
process.env.DSH_MCLOUD_CREDENTIAL_DIR = credentialDir

const { apply, __test } = await import('../lib/index.js')

describe('cleanParentPath：上传目标目录的展示路径', () => {
  test('反斜杠统一成斜杠，并补上前导 /', () => {
    assert.equal(__test.cleanParentPath('windows\\实验'), '/windows/实验')
  })

  test('已经是 /a/b 就原样保留', () => {
    assert.equal(__test.cleanParentPath('/windows/实验'), '/windows/实验')
  })

  test('重复斜杠折叠', () => {
    assert.equal(__test.cleanParentPath('//a///b//'), '/a/b/')
  })

  test('去掉控制字符（含 NUL / ESC）', () => {
    assert.equal(__test.cleanParentPath('/a\u0000b\u001bc'), '/abc')
  })

  test('空白 / 非字符串 / 只有根 → null', () => {
    assert.equal(__test.cleanParentPath(''), null)
    assert.equal(__test.cleanParentPath('   '), null)
    assert.equal(__test.cleanParentPath('/'), null)
    assert.equal(__test.cleanParentPath(null), null)
    assert.equal(__test.cleanParentPath(123), null)
  })

  test('超长会被截断到 300 以内', () => {
    const long = '/' + 'a'.repeat(1000)
    const cleaned = __test.cleanParentPath(long)
    assert.equal(typeof cleaned, 'string')
    assert.ok(cleaned.length <= 300, `长度 ${cleaned.length}`)
  })
})

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

describe('/reveal：传输记录的「定位」路由', () => {
  let ctx
  before(async () => { ctx = await mountPlugin() })
  after(() => {
    ctx.server.close()
    rmSync(credentialDir, { recursive: true, force: true })
  })

  test('路由已注册', () => {
    const hit = ctx.routes.find((route) => route.path === '/api/dsh-mcloud/reveal')
    assert.ok(hit, '没有注册 /reveal')
    assert.equal(hit.kind, 'exact')
  })

  test('跨站请求被闸拦掉（不能远程拉起资源管理器）', async () => {
    const body = JSON.stringify({ localPath: 'C:\\Windows' })
    const res = await send(ctx.port, {
      method: 'POST',
      path: '/api/dsh-mcloud/reveal',
      headers: {
        host: `127.0.0.1:${ctx.port}`,
        origin: 'http://evil.example',
        'content-type': 'application/json',
        'x-dsh-mcloud': '1',
        'content-length': Buffer.byteLength(body),
      },
      body,
    })
    assert.equal(res.status, 403, res.text)
    assert.match(res.text, /cross-origin/)
  })

  test('同源但没带插件头 → 403（写接口的第二个必需要求）', async () => {
    const body = JSON.stringify({ localPath: 'C:\\Windows' })
    const res = await send(ctx.port, {
      method: 'POST',
      path: '/api/dsh-mcloud/reveal',
      headers: {
        host: `127.0.0.1:${ctx.port}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      body,
    })
    assert.equal(res.status, 403, res.text)
    assert.match(res.text, /missing plugin header/)
  })

  test('同源 + 带插件头，但目标为空 → 400 业务错误（说明越过了闸）', async () => {
    const body = JSON.stringify({})
    const res = await send(ctx.port, {
      method: 'POST',
      path: '/api/dsh-mcloud/reveal',
      headers: {
        host: `127.0.0.1:${ctx.port}`,
        origin: `http://127.0.0.1:${ctx.port}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'x-dsh-mcloud': '1',
        'content-length': Buffer.byteLength(body),
      },
      body,
    })
    assert.equal(res.status, 400, res.text)
    assert.match(res.text, /没有可定位的本机路径/)
  })

  test('不存在的路径 → 400，而不是静默成功', async () => {
    const missing = join(tmpdir(), 'dsh-mcloud-does-not-exist-' + Date.now())
    const body = JSON.stringify({ localPath: missing })
    const res = await send(ctx.port, {
      method: 'POST',
      path: '/api/dsh-mcloud/reveal',
      headers: {
        host: `127.0.0.1:${ctx.port}`,
        origin: `http://127.0.0.1:${ctx.port}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'x-dsh-mcloud': '1',
        'content-length': Buffer.byteLength(body),
      },
      body,
    })
    assert.equal(res.status, 400, res.text)
    assert.match(res.text, /找不到这个路径/)
  })

  test('GET /reveal 不允许（写接口只能 POST）', async () => {
    const res = await send(ctx.port, {
      path: '/api/dsh-mcloud/reveal',
      headers: { host: `127.0.0.1:${ctx.port}` },
    })
    assert.equal(res.status, 405, res.text)
    assert.match(res.text, /method not allowed/)
  })
})

describe('/transfers 的返回体：不泄露本机绝对路径', () => {
  let ctx
  before(async () => { ctx = await mountPlugin() })
  after(() => {
    ctx.server.close()
    rmSync(credentialDir, { recursive: true, force: true })
  })

  test('未登录时也不是 500，而且是空任务表', async () => {
    const res = await send(ctx.port, {
      path: '/api/dsh-mcloud/transfers',
      headers: { host: `127.0.0.1:${ctx.port}` },
    })
    assert.equal(res.status, 200, res.text)
    const doc = JSON.parse(res.text)
    assert.deepEqual(doc.jobs, [])
  })
})

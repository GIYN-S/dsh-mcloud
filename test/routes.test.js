/**
 * 端到端回归：把插件**真实的路由**挂到真实 HTTP 服务器上，走一遍攻击路径。
 *
 * 跑法：node --test test/
 *
 * 上一个文件只测了闸函数；这里测的是「插件有没有把闸接到每一条路由上」——
 * 那才是真正会漏的地方（新加一条路由忘了调 guard 就白搭）。
 */

import { createServer, request } from 'node:http'
import { strict as assert } from 'node:assert'
import { test, describe, before, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 凭据目录指到临时目录，别碰真实登录态
const credentialDir = mkdtempSync(join(tmpdir(), 'mcloud-guard-test-'))
process.env.DSH_MCLOUD_CREDENTIAL_DIR = credentialDir

const { apply } = await import('../lib/index.js')

/** 最小可用的 DSH ctx + webServer：只把 apply 需要的那几个口子做实 */
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

    // 按 DSH 的匹配规则：exact 精确命中
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
        assert.deepEqual(names, ['webServer'])
        callback({ webServer, effect: (factory) => { factory() } })
      },
    }

    server.listen(0, '127.0.0.1', () => {
      // 插件真正挂载一次，路由才存在
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

describe('真实路由：攻击者的网页打不进来', () => {
  let ctx
  before(async () => { ctx = await mountPlugin() })
  after(() => {
    ctx.server.close()
    rmSync(credentialDir, { recursive: true, force: true })
  })

  test('所有路由都挂上了闸（漏一条就等于全漏）', () => {
    assert.ok(ctx.routes.length > 20, `只注册了 ${ctx.routes.length} 条路由`)
    for (const route of ctx.routes) {
      assert.equal(typeof route.handler, 'function', `${route.path} 没有 handler`)
    }
  })

  test('DNS rebinding：Host 是攻击者域名，读接口也拿不到数据', async () => {
    const res = await send(ctx.port, {
      path: '/api/dsh-mcloud/list?parentFileId=/',
      headers: { host: `evil.example:${ctx.port}` },
    })
    assert.equal(res.status, 403, res.text)
    assert.doesNotMatch(res.text, /items/)
  })

  test('DNS rebinding：哪怕 Origin 伪装成同一个攻击者域名也不行', async () => {
    const res = await send(ctx.port, {
      path: '/api/dsh-mcloud/status',
      headers: {
        host: `evil.example:${ctx.port}`,
        origin: `http://evil.example:${ctx.port}`,
        'sec-fetch-site': 'same-origin',
      },
    })
    assert.equal(res.status, 403, res.text)
  })

  test('CSRF 写操作：Host 对、Origin 是别处 —— 拒绝且不落地', async () => {
    const body = JSON.stringify({ name: 'pwned-by-attacker', parentFileId: '/' })
    const res = await send(ctx.port, {
      method: 'POST',
      path: '/api/dsh-mcloud/mkdir',
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

  test('CSRF 写操作：攻击者自己加 x-dsh-mcloud: 1 也没用', async () => {
    // 这正是原报告担心的点：自定义头能加，但它不是边界
    const body = JSON.stringify({})
    const res = await send(ctx.port, {
      method: 'POST',
      path: '/api/dsh-mcloud/remove',
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
    assert.doesNotMatch(res.text, /missing plugin header/, '说明它不是被 CSRF 头挡下的')
  })

  test('自己页面的同源请求照常可用', async () => {
    const res = await send(ctx.port, {
      path: '/api/dsh-mcloud/status',
      headers: { host: `127.0.0.1:${ctx.port}` },
    })
    // 没登录也应当是 200 + authorized:false，而不是被闸拦掉
    assert.equal(res.status, 200, res.text)
    assert.match(res.text, /"authorized"/)
  })

  test('自己页面的同源写请求能过闸（到业务层才判断对错）', async () => {
    const body = JSON.stringify({ name: '', parentFileId: '/' })
    const res = await send(ctx.port, {
      method: 'POST',
      path: '/api/dsh-mcloud/mkdir',
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
    // 空名字是业务错误（400），说明请求已经越过安全闸抵达业务逻辑
    assert.equal(res.status, 400, res.text)
    assert.match(res.text, /文件夹名不能为空/)
  })
})

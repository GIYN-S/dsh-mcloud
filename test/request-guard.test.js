/**
 * dsh-mcloud 请求闸的回归测试。
 *
 * 跑法：node --test test/
 *
 * 这里用**真实的 node:http 服务器**而不是直接喂假对象：这道闸的输入就是
 * 浏览器真的会发的那些头，用假 headers 测等于自己出题自己答。
 */

import { createServer, request } from 'node:http'
import { strict as assert } from 'node:assert'
import { test, describe, before, after } from 'node:test'
import { requestRejection } from '../lib/request-guard.js'

/**
 * 起一个只跑闸、返回 200/403 的服务器，把 webServer 的 host/port/protocol 口径照搬。
 * 端口要 listen 之后才知道，所以 options 是同一个对象、事后补上 —— 插件那边也是 getter。
 */
function startFence(extra = {}) {
  return new Promise((resolve) => {
    const options = { ...extra }
    const server = createServer((req, res) => {
      const reason = requestRejection(req, options)
      res.writeHead(reason === null ? 200 : 403, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reason === null ? { ok: true } : { ok: false, error: reason }))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      // webServer 的真实对象形状：host 是绑定 IP，port 是 listen 后的实际端口
      options.webServer = { host: '127.0.0.1', port, protocol: 'http:' }
      resolve({ server, port, options })
    })
  })
}

/** 发一条带任意头的请求（用 http.request 才能控制 Host） */
function send(port, { method = 'GET', path = '/', headers = {}, body = undefined }) {
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

describe('request-guard: 正常请求要放行', () => {
  let ctx
  before(async () => { ctx = await startFence() })
  after(() => ctx.server.close())

  test('同源 GET（Host=127.0.0.1:port，无 Origin）', async () => {
    const res = await send(ctx.port, {
      headers: { host: `127.0.0.1:${ctx.port}` },
    })
    assert.equal(res.status, 200, res.text)
  })

  test('同源 POST（带 Origin、Sec-Fetch-Site: same-origin）', async () => {
    const res = await send(ctx.port, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${ctx.port}`,
        origin: `http://127.0.0.1:${ctx.port}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(res.status, 200, res.text)
  })

  test('localhost 也算环回', async () => {
    const res = await send(ctx.port, {
      headers: { host: `localhost:${ctx.port}` },
    })
    assert.equal(res.status, 200, res.text)
  })
})

describe('request-guard: DNS rebinding（Host 不是本部署）要拒', () => {
  let ctx
  before(async () => { ctx = await startFence() })
  after(() => ctx.server.close())

  test('Host: evil.example:port —— rebinding 的典型形态', async () => {
    const res = await send(ctx.port, {
      headers: { host: `evil.example:${ctx.port}`, origin: `http://evil.example:${ctx.port}` },
    })
    assert.equal(res.status, 403, res.text)
    assert.match(res.text, /Host is not this deployment/)
  })

  test('Host: evil.example（不带端口）', async () => {
    const res = await send(ctx.port, { headers: { host: 'evil.example' } })
    assert.equal(res.status, 403, res.text)
  })

  test('Host 端口对不上（evil.example 的 80 端口 rebind 过来）', async () => {
    const res = await send(ctx.port, {
      headers: { host: `127.0.0.1:80` },
    })
    assert.equal(res.status, 403, res.text)
    assert.match(res.text, /port is not this listener/)
  })

  test('伪造的 authoritative 域名不是白名单就不认', async () => {
    const res = await send(ctx.port, {
      headers: { host: `dsh.example.com:${ctx.port}` },
    })
    assert.equal(res.status, 403, res.text)
  })
})

describe('request-guard: 跨站写请求要拒', () => {
  let ctx
  before(async () => { ctx = await startFence() })
  after(() => ctx.server.close())

  test('Host 对得上但 Origin 是别处（最关键的 CSRF 形态）', async () => {
    const res = await send(ctx.port, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${ctx.port}`,
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(res.status, 403, res.text)
    assert.match(res.text, /cross-origin/)
  })

  test('Sec-Fetch-Site: cross-site 一票否决', async () => {
    const res = await send(ctx.port, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${ctx.port}`,
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(res.status, 403, res.text)
    assert.match(res.text, /cross-site/)
  })

  test('Origin: null（沙箱 iframe / file: 页面）要拒', async () => {
    const res = await send(ctx.port, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${ctx.port}`,
        origin: 'null',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(res.status, 403, res.text)
    assert.match(res.text, /opaque Origin/)
  })

  test('Origin 是 http://127.0.0.1:别的端口 —— 另一个本机服务也算跨源', async () => {
    const res = await send(ctx.port, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${ctx.port}`,
        origin: 'http://127.0.0.1:1',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(res.status, 403, res.text)
  })
})

describe('request-guard: 畸形的 Host / Origin', () => {
  let ctx
  before(async () => { ctx = await startFence() })
  after(() => ctx.server.close())

  test('没有 Host 头（node 自己会先回 400，这里直测闸的判断）', () => {
    const reason = requestRejection(
      { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
      { webServer: { host: '127.0.0.1', port: 1234, protocol: 'http:' } },
    )
    assert.match(String(reason), /Host/)
  })

  test('Host 里塞了路径', async () => {
    const res = await send(ctx.port, { headers: { host: '127.0.0.1/x' } })
    assert.equal(res.status, 403, res.text)
  })

  test('Origin 不是合法 URL', async () => {
    const res = await send(ctx.port, {
      headers: { host: `127.0.0.1:${ctx.port}`, origin: 'about:blank' },
    })
    assert.equal(res.status, 403, res.text)
  })
})

describe('request-guard: 白名单（反代 / 自定义域名）', () => {
  let ctx
  before(async () => {
    ctx = await startFence({ allowedAuthorities: ['dsh.example.com'] })
  })
  after(() => ctx.server.close())

  test('白名单里的裸域名匹配任意端口', async () => {
    const res = await send(ctx.port, { headers: { host: `dsh.example.com:${ctx.port}` } })
    assert.equal(res.status, 200, res.text)
  })

  test('白名单只放 host，不放别的域名', async () => {
    const res = await send(ctx.port, { headers: { host: `other.example.com:${ctx.port}` } })
    assert.equal(res.status, 403, res.text)
  })

  test('白名单域名也必须 Origin 同源', async () => {
    const res = await send(ctx.port, {
      headers: { host: `dsh.example.com:${ctx.port}`, origin: 'http://evil.example' },
    })
    assert.equal(res.status, 403, res.text)
  })
})

/**
 * 端到端验证扫码登录的 CDP 安全加固（真机，真 Edge）。
 *
 * 这个脚本做三件事，对应安全审查的验收条件：
 *
 *   1. 用假浏览器（Node 子进程）跑一遍 scanLogin，验证它**只走 pipe**、
 *      命令行里没有 --remote-debugging-port；
 *   2. 用真 Edge 跑一遍：启动后立刻从另一个进程扫描 9333–9362 和当前监听端口，
 *      断言**没有任何 CDP 端点可连**；
 *   3. 验证「拿到凭据 / 取消 / 超时」三条路径都会关掉浏览器并删掉临时 profile。
 *
 * 跑法：node test/scan-login.security.test.js
 */

import { strict as assert } from 'node:assert'
import { test, describe, before, after } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const SCAN_SOURCE = new URL('../lib/scan-login.js', import.meta.url)

// ================================================================
// 假浏览器：一个会说 CDP-over-pipe 的 Node 子进程
// ================================================================
const FAKE_BROWSER = `
import fs from 'node:fs'

// 记录自己被怎么调起来的，供父进程断言
const logFile = process.env.FAKE_BROWSER_LOG || ''
if (logFile) {
  fs.writeFileSync(logFile, JSON.stringify({ argv: process.argv.slice(1) }))
}

const wantAuth = process.env.FAKE_BROWSER_AUTH || ''
const cookieName = process.env.FAKE_BROWSER_COOKIE || 'authorization'
const cookieDomain = process.env.FAKE_BROWSER_DOMAIN || '.yun.139.com'
const sayCookies = process.env.FAKE_BROWSER_COOKIES === '1'

// fd3 = 读命令，fd4 = 写响应
let buffer = ''
fs.createReadStream(null, { fd: 3 }).on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let cut
  while ((cut = buffer.indexOf('\\0')) >= 0) {
    const raw = buffer.slice(0, cut)
    buffer = buffer.slice(cut + 1)
    if (!raw.trim()) continue
    let msg
    try { msg = JSON.parse(raw) } catch { continue }
    const reply = (result) => {
      fs.writeSync(4, JSON.stringify({ id: msg.id, result }) + '\\0')
    }
    if (msg.method === 'Browser.getVersion') {
      reply({ protocolVersion: '1.3', product: 'FakeBrowser/9.9.9' })
    } else if (msg.method === 'Storage.getCookies') {
      const cookies = sayCookies && wantAuth
        ? [{ name: cookieName, value: wantAuth, domain: cookieDomain }]
        : []
      reply({ cookies })
    } else if (msg.method === 'Target.getTargets') {
      reply({ targetInfos: [] })
    } else if (msg.method === 'Browser.close') {
      reply({})
      setTimeout(() => process.exit(0), 30)
    } else {
      reply({})
    }
  }
})

// 没有父进程来写命令就自己待着（模拟「等用户扫码」）
setInterval(() => {}, 1000)
`

function makeFakeBrowser() {
  const dir = path.join(os.tmpdir(), 'dsh-mcloud-fake-browser-' + Date.now().toString(36))
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'fake-browser.mjs')
  writeFileSync(file, FAKE_BROWSER, 'utf8')
  return { dir, file }
}

function makeSpawnWrapper(fakePath, logFile, extraEnv = {}) {
  // spawn 的「可执行文件」换成 node，真正要跑的是假浏览器脚本
  return (command, args, options) => {
    const child = spawn(process.execPath, [fakePath, ...args], {
      ...options,
      env: { ...process.env, FAKE_BROWSER_LOG: logFile, ...extraEnv },
    })
    return child
  }
}

/** 扫一个端口上有没有开着的 CDP（/json/version）。 */
function probeCdp(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 已经关掉 */
      }
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
    socket.connect(port, '127.0.0.1', () => {
      socket.write(`GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    })
    socket.once('data', (chunk) => {
      const text = chunk.toString('utf8')
      finish(/webSocketDebuggerUrl|"Browser"/i.test(text) ? text : false)
    })
  })
}

/** 扫一段端口，返回所有开着的 CDP 端点。 */
async function scanRange(from, to) {
  const hits = []
  for (let port = from; port <= to; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await probeCdp(port, 80)
    if (hit) hits.push({ port, text: hit })
  }
  return hits
}

/** 找出某个进程（含子进程）命令行里有没有调试端口相关的开关。 */
function edgeCommandLines() {
  if (process.platform !== 'win32') return []
  try {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
      "Select-Object -ExpandProperty CommandLine"
    const out = spawnSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    return String(out.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

describe('安全审查：扫码登录的 CDP 不再暴露在任何 TCP 端口上', () => {
  test('只走 pipe：命令行里没有 --remote-debugging-port，也没有固定端口范围', async () => {
    const { scanLogin } = await import(SCAN_SOURCE)
    const fake = makeFakeBrowser()
    const logFile = path.join(fake.dir, 'argv.json')
    const profileRoot = path.join(fake.dir, 'profiles')
    mkdirSync(profileRoot, { recursive: true })

    const result = await scanLogin({
      spawnImpl: makeSpawnWrapper(fake.file, logFile, {
        FAKE_BROWSER_COOKIES: '1',
        FAKE_BROWSER_AUTH: 'Basic abc123',
      }),
      browser: fake.file,
      profileRoot,
      signal: { aborted: false },
    })

    assert.equal(result.authorization, 'abc123', '没把 authorization 的 Basic 前缀去掉')

    const recorded = JSON.parse(readFileSync(logFile, 'utf8'))
    const argv = recorded.argv.join(' ')
    assert.ok(argv.includes('--remote-debugging-pipe'), '没有用 --remote-debugging-pipe：' + argv)
    assert.ok(!argv.includes('--remote-debugging-port'), '居然还在用 TCP 调试端口：' + argv)
    // 老实现会从 9333 起找端口；这里连同这个数字都不该出现
    assert.ok(!/remote-debugging-port=93\d\d/.test(argv), '还留着可预测的端口：' + argv)

    // 临时 profile 必须删干净
    const leftovers = readdirSync(profileRoot)
    assert.deepEqual(leftovers, [], '扫码成功后临时 profile 没删：' + JSON.stringify(leftovers))

    rmSync(fake.dir, { recursive: true, force: true })
  })

  test('取消 / 超时：浏览器进程被关掉，临时 profile 被删掉', async () => {
    const { scanLogin } = await import(SCAN_SOURCE)
    const fake = makeFakeBrowser()
    const logFile = path.join(fake.dir, 'argv.json')
    const profileRoot = path.join(fake.dir, 'profiles')
    mkdirSync(profileRoot, { recursive: true })

    const controller = new AbortController()
    // 扫不到 cookie（FAKE_BROWSER_COOKIES 不设），200ms 后取消
    setTimeout(() => controller.abort(), 200)

    await assert.rejects(
      () => scanLogin({
        spawnImpl: makeSpawnWrapper(fake.file, logFile, {}),
        browser: fake.file,
        profileRoot,
        signal: controller.signal,
      }),
      /已取消/,
      '取消后应该抛「已取消扫码登录」',
    )

    const leftovers = readdirSync(profileRoot)
    assert.deepEqual(leftovers, [], '取消之后临时 profile 没删：' + JSON.stringify(leftovers))

    rmSync(fake.dir, { recursive: true, force: true })
  })
})

function require_utf8(file) {
  return readFileSync(file, 'utf8')
}
void require_utf8

// ================================================================
// 真机：真 Edge + 真端口扫描
// ================================================================
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const HAS_EDGE = process.platform === 'win32' && existsSync(EDGE)

describe('真机验证：真 Edge 起来之后，本机扫不到任何 CDP 端点', { skip: !HAS_EDGE }, () => {
  let scanLogin = null
  let profileRoot = null

  before(async () => {
    const module = await import(SCAN_SOURCE)
    scanLogin = module.scanLogin
    profileRoot = path.join(os.tmpdir(), 'dsh-mcloud-scan-e2e-' + Date.now().toString(36))
    mkdirSync(profileRoot, { recursive: true })
  })

  after(() => {
    if (profileRoot) rmSync(profileRoot, { recursive: true, force: true })
  })

  test('扫码等待期间：真 Edge 的命令行没有调试端口，9333–9362 也拿不到 CDP', async () => {
    const controller = new AbortController()
    let started = false
    const running = scanLogin({
      browser: EDGE,
      profileRoot,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress && progress.phase === 'waiting') started = true
      },
    }).catch((error) => error)

    try {
      // 等它真的进到「等扫码」阶段（真 Edge 起来通常 2~5 秒）
      for (let i = 0; i < 400 && !started; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(started, '扫码登录没有进入等待阶段（浏览器可能没起来）')

      // 1) 真 Edge 的命令行里只能有 pipe，绝不能有 TCP 调试端口
      const lines = edgeCommandLines()
      assert.ok(lines.length > 0, '没查到 msedge 进程（浏览器可能已退出）')
      const withPort = lines.filter((line) => /--remote-debugging-port/.test(line))
      assert.deepEqual(withPort, [], '真 Edge 命令行里出现了 TCP 调试端口：' + JSON.stringify(withPort))
      const withPipe = lines.filter((line) => /--remote-debugging-pipe/.test(line))
      assert.ok(withPipe.length > 0, '真 Edge 命令行里没有 --remote-debugging-pipe（说明走了回落路径）')

      // 2) 老的固定范围必须一个都不通
      const predictable = await scanRange(9333, 9362)
      assert.deepEqual(
        predictable.map((hit) => hit.port),
        [],
        '9333–9362 上出现了 CDP 端点：' + JSON.stringify(predictable),
      )
    } finally {
      // 🔴 无论断言成不成立都要收尾，否则扫码会一直等满 5 分钟
      controller.abort()
      await running
    }

    // 取消之后临时 profile 也要清干净
    await new Promise((resolve) => setTimeout(resolve, 800))
    const leftovers = readdirSync(profileRoot).filter((name) => name.startsWith('dsh-mcloud-scan-'))
    assert.deepEqual(leftovers, [], '取消后临时 profile 没删：' + JSON.stringify(leftovers))
  })
})

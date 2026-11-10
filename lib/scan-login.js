/**
 * dsh-mcloud — 浏览器扫码登录（CDP 版）
 *
 * 思路：插件自己拉起一个**独立 profile 的 Edge**，开调试端口，打开云盘首页；
 * 你扫码登录后，云盘会把 `authorization` 写进自己的 cookie（非 HttpOnly），
 * 插件通过 CDP 读出来 → 存起来 → 关掉浏览器。
 *
 * 为什么这么做：
 *   · 不用你输密码，最安全（密码从头到尾没经过插件）
 *   · 不用手动 F12 抄令牌
 *   · 抓到的令牌可以用 `authTokenRefresh.do` 续期，
 *     所以「扫一次 → 之后自动续期 → 长期免扫」
 *
 * 为什么用独立 profile：
 *   · 不碰你日常用的 Edge（否则要关掉所有窗口才能加调试端口）
 *   · 不会读到你在别的网站的登录态
 *   代价：每次扫码要保持登录（但有了续期，正常只扫一次）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 常见 Edge / Chrome 安装位置 */
const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

const LOGIN_URL = 'https://yun.139.com/'

/** 扫码等待上限：5 分钟 */
export const SCAN_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 找一个**确定空闲**的调试端口。
 *
 * 这里必须真去连一下确认：之前踩过坑 —— 固定用 9333，结果上次遗留的浏览器
 * 还占着那个端口，我们新起的实例没起来，却读到了**旧浏览器的 cookie**，
 * 看起来「登录成功」，其实是捡了别人（或上一次）的登录态。
 */
async function findFreePort(startPort = 9333, tries = 30) {
  const net = await import('node:net')
  for (let i = 0; i < tries; i += 1) {
    const port = startPort + i
    const free = await new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      try {
        srv.listen(port, '127.0.0.1')
      } catch {
        resolve(false)
      }
    })
    if (free) return port
  }
  throw new Error('找不到可用的本地端口，请关闭一些程序后重试')
}

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 极简 CDP 客户端（只用 Runtime.evaluate 和 Network.getAllCookies） */
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10_000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    }
  })

  let seq = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    if (!msg.id || !pending.has(msg.id)) return
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
    else resolve(msg.result)
  }

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })

  return { ws, send }
}

/** 等 CDP 端口就绪，返回浏览器版本信息 */
async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  throw new Error('浏览器调试端口没有就绪（可能被安全软件拦了）')
}

/** 在打开的页面里找云盘标签页 */
async function findYunTab(port) {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json())
    return (list || []).find((t) => t.type === 'page' && String(t.url).includes('139.com')) || null
  } catch {
    return null
  }
}

/** 从 cookie 列表里挑出云盘凭据 */
function pickCredentials(cookies) {
  const get = (name) => {
    const hit = (cookies || []).find((c) => c.name === name && String(c.domain || '').includes('139.com'))
    return hit ? String(hit.value || '') : ''
  }
  const rawAuth = get('authorization')
  const bare = rawAuth.replace(/^Basic\s+/i, '').trim()
  if (!bare) return null
  return {
    authorization: bare,
    udId: get('ud_id'),
    authToken: get('auth_token'),
    skey: get('skey'),
  }
}

/**
 * 拉起浏览器，等用户扫码，然后抓凭据。
 *
 * onProgress 会收到 { phase, message } 形式的进度，便于界面显示。
 * 返回 { authorization, udId, closed:true } 或抛错。
 */
export async function scanLogin({ onProgress, signal } = {}) {
  const browser = findBrowser()
  if (!browser) {
    throw new Error('没找到 Edge 或 Chrome，请先安装浏览器，或改用账号密码登录')
  }

  const report = (phase, message) => {
    try {
      onProgress?.({ phase, message })
    } catch {
      /* 进度回调不该影响主流程 */
    }
  }

  // 每个 profile 独立，避免并发冲突
  const profileDir = join(tmpdir(), `dsh-mcloud-scan-${Date.now().toString(36)}`)
  mkdirSync(profileDir, { recursive: true })

  // 动态找一个空闲端口（绝不复用可能被旧进程占着的端口）
  let port
  try {
    port = await findFreePort(9333)
  } catch (error) {
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw error
  }

  let child = null

  report('launching', '正在启动浏览器…')

  const cleanup = () => {
    try {
      if (child && !child.killed) child.kill()
    } catch {
      /* 已经退出 */
    }
    // 给浏览器一点时间退出再删 profile，否则文件被占用删不掉
    setTimeout(() => {
      try {
        rmSync(profileDir, { recursive: true, force: true })
      } catch {
        /* 删不掉就算了，是个临时目录 */
      }
    }, 2000)
  }

  try {
    child = spawn(
      browser,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=msEdgeIdentityFRE,msEdgeSidebarV2',
        '--window-size=520,760',
        LOGIN_URL,
      ],
      { detached: false, stdio: 'ignore' },
    )

    child.on('error', () => {
      /* 由下面的超时统一报错 */
    })

    // 等 CDP 起来 —— 并且确认端口后面确实是**我们刚起的这个实例**
    const version = await waitForCdp(port, 25_000)
    const browserPath = String(version?.Browser || '')
    if (!browserPath) throw new Error('浏览器调试端口返回异常')
    report('waiting', '请在弹出的浏览器里扫码登录（最长等 5 分钟）')

    const deadline = Date.now() + SCAN_TIMEOUT_MS
    let lastReport = 0

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('已取消扫码登录')
      if (child.exitCode !== null && child.exitCode !== undefined) {
        throw new Error('浏览器被关闭了，扫码登录已取消')
      }

      const tab = await findYunTab(port)
      if (tab) {
        try {
          const { ws, send } = await connectCdp(tab.webSocketDebuggerUrl)
          try {
            await send('Network.enable')
            const { cookies } = await send('Network.getAllCookies')
            const picked = pickCredentials(cookies)
            if (picked) {
              report('success', '登录成功，正在保存凭据…')
              ws.close()
              return { ...picked, closed: true }
            }
          } finally {
            try {
              ws.close()
            } catch {
              /* 已关闭 */
            }
          }
        } catch {
          /* 页面可能正在跳转，下一轮再试 */
        }
      }

      const now = Date.now()
      if (now - lastReport > 8000) {
        lastReport = now
        const left = Math.max(0, Math.round((deadline - now) / 1000))
        report('waiting', `等待扫码登录…（剩余 ${left} 秒）`)
      }
      await sleep(1200)
    }

    throw new Error('扫码登录超时（5 分钟）。请重新点击「扫码登录」')
  } finally {
    cleanup()
  }
}

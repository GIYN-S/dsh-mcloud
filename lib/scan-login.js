/**
 * dsh-mcloud — 浏览器扫码登录（CDP 版）
 *
 * 思路：插件自己拉起一个**独立 profile 的 Edge**，打开云盘首页；
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
 *
 * ================================================================
 * 🔴 0.4.4 安全加固：CDP 不再监听任何 TCP 端口
 * ================================================================
 *
 * 0.4.3 及以前用的是 `--remote-debugging-port=<端口>`，端口从 9333 起顺序找空闲的
 * （9333–9362，**可预测**），而且整个扫码窗口（最长 5 分钟）端口一直开着、
 * CDP 本身**没有任何鉴权**。这意味着：
 *
 *   本机上任何能访问 127.0.0.1 的网页或程序，只要扫一遍 9333–9362，
 *   就能拿到 webSocketDebuggerUrl、连上 CDP、读走 139 的登录凭据
 *   （authorization / ud_id / auth_token / skey），进而冒用这个账号的云盘。
 *   浏览器的 Origin 检查只是兜底，根因是「CDP 裸露在可探测的端口上」。
 *
 * 所以现在改成 **`--remote-debugging-pipe`**：CDP 走 stdin/stdout 之外的两个
 * 继承句柄（fd 3 / fd 4，NUL 分隔的 JSON），**根本不监听 TCP** ——
 * 没有端口可探测，也就没有可被本机其它进程抢的入口。
 *
 * 实测（真实 Edge 158 / Windows）：
 *   · fd3 = 宿主 → 浏览器（写命令）；
 *   · fd4 = 浏览器 → 宿主（读响应）；
 *   · 句柄只属于我们 spawn 出来的那个进程，别的进程拿不到。
 *
 * 万一 pipe 起不来（很老的浏览器），才回落到端口模式，且必须同时满足：
 *   · 端口由 `listen(0)` 让系统随机分配（不再从 9333 起、不再可预测）；
 *   · `--remote-allow-origins` 只放行 `http://127.0.0.1:<port>`；
 *   · 连接前校验 `<profile>/DevToolsActivePort` 里的端口与 ws 路径
 *     （这个文件只在我们自己的临时 profile 里），确认对面是**本次刚起的实例**；
 *   · 连上后再发一次 Browser.getVersion 复核。
 *
 * 另外，凭据一拿到就立刻关浏览器、删临时 profile —— 不再等到 5 分钟超时。
 * 取消 / 超时 / 出错也一样保证关端口、删目录。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
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

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 可被 signal 打断的 sleep（取消扫码时别卡在 1.2 秒的等待里）。 */
function sleepUnlessAborted(ms, signal) {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        signal.removeEventListener?.('abort', finish)
      } catch {
        /* 有的实现没有 removeEventListener */
      }
      resolve()
    }
    const timer = setTimeout(finish, ms)
    try {
      signal.addEventListener?.('abort', finish)
    } catch {
      /* 没有 addEventListener 就退化成普通 sleep */
    }
  })
}

/**
 * CDP over pipe。
 *
 * 浏览器端约定：从 fd3 读我们的命令、往 fd4 写响应，每条消息以 `\0` 结尾。
 * 这里只管「发一条、等它那条的 id 回来」，事件（没有 id 的消息）直接丢掉。
 */
function openPipeSession(writable, readable) {
  let seq = 0
  let buffer = ''
  const pending = new Map()
  const listeners = new Set()
  let closed = false

  function failAll(error) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  readable.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let cut = buffer.indexOf('\0')
    while (cut >= 0) {
      const raw = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 1)
      cut = buffer.indexOf('\0')
      if (!raw.trim()) continue
      let message
      try {
        message = JSON.parse(raw)
      } catch {
        continue
      }
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id)
        pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)))
        else entry.resolve(message.result)
        continue
      }
      // 事件：只有 attach/detach 这类我们关心的才转发
      if (message.method) {
        for (const listener of listeners) {
          try {
            listener(message)
          } catch {
            /* 监听器自己的问题不该影响主流程 */
          }
        }
      }
    }
  })
  readable.on('error', (error) => failAll(error))
  readable.on('close', () => {
    closed = true
    failAll(new Error('浏览器调试通道已关闭'))
  })

  function send(method, params = {}, sessionId) {
    if (closed) return Promise.reject(new Error('浏览器调试通道已关闭'))
    return new Promise((resolve, reject) => {
      const id = ++seq
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, 15_000)
      pending.set(id, { resolve, reject, timer })
      try {
        writable.write(JSON.stringify(payload) + '\0')
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  return {
    send,
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      closed = true
      failAll(new Error('已关闭'))
      for (const stream of [readable, writable]) {
        try {
          stream.destroy()
        } catch {
          /* 已经关掉 */
        }
      }
    },
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
 * 通过 pipe 读一次 cookie。
 *
 * 优先浏览器级 `Storage.getCookies`（一次就拿到整个浏览器的 cookie，不依赖
 * 有没有 attach 到正确页面）；拿不到再用「attach 到云盘那个标签页 + Network.getAllCookies」。
 */
async function readCookies(session, state) {
  const attempts = []
  attempts.push(async () => {
    const result = await session.send('Storage.getCookies')
    return Array.isArray(result?.cookies) ? result.cookies : []
  })
  attempts.push(async () => {
    const targets = await session.send('Target.getTargets')
    const page = (targets?.targetInfos || []).find(
      (t) => t.type === 'page' && String(t.url || '').includes('139.com'),
    )
    if (!page) return []
    let sessionId = state.sessions.get(page.targetId)
    if (!sessionId) {
      const attached = await session.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
      sessionId = attached?.sessionId || ''
      if (!sessionId) return []
      state.sessions.set(page.targetId, sessionId)
      // 页面还在跳转时 Network.enable 可能失败：失败不影响后面重试
      try {
        await session.send('Network.enable', {}, sessionId)
      } catch {
        /* 下一轮再试 */
      }
    }
    const result = await session.send('Network.getAllCookies', {}, sessionId)
    return Array.isArray(result?.cookies) ? result.cookies : []
  })

  for (const attempt of attempts) {
    try {
      const cookies = await attempt()
      if (cookies.length > 0) return cookies
    } catch {
      /* 换下一种办法 */
    }
  }
  return []
}

/**
 * 回落到端口模式时用：系统随机分配一个空闲端口。
 *
 * 0.4.3 是从 9333 起顺序试 30 个 —— 范围固定、可枚举，本机任何程序扫一遍就能找到。
 * 现在交给内核分配（listen(0)），拿到的端口不可预测。
 */
function findRandomPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? Number(address.port) : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('没能分配到本地端口'))
      })
    })
  })
}

/** 端口模式的极简 CDP 客户端（只在 pipe 不可用时使用）。 */
async function connectWebSocket(wsUrl) {
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
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (!message.id || !pending.has(message.id)) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++seq
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, 15_000)
      pending.set(id, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify(payload))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  return { send, close: () => { try { ws.close() } catch { /* 已关闭 */ } } }
}

/**
 * 端口模式：等 `<profile>/DevToolsActivePort` 出现，并且确认端口是我们挑的那个。
 *
 * 这个文件由浏览器写在**我们自己的临时 profile** 里，内容是
 * `<port>\n<browser-ws-path>`。它证明「这个端口后面就是本次刚启动的实例」，
 * 而不是上次遗留的某个浏览器（0.3.x 踩过「3 秒就登录成功，其实读到旧实例 cookie」）。
 */
async function waitForDevToolsPort(profileDir, expectedPort, timeoutMs, signal) {
  const file = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('已取消扫码登录')
    try {
      const text = readFileSync(file, 'utf8')
      const [portLine, pathLine] = String(text).split(/\r?\n/)
      const port = Number(portLine)
      const wsPath = String(pathLine || '').trim()
      if (port > 0 && wsPath) {
        if (expectedPort && port !== expectedPort) {
          throw new Error('调试端口不是本次启动的实例（可能被其它进程占用）')
        }
        return { port, wsPath }
      }
    } catch (error) {
      if (error instanceof Error && /不是本次启动的实例/.test(error.message)) throw error
      /* 文件还没写出来 */
    }
    await sleepUnlessAborted(250, signal)
  }
  throw new Error('浏览器调试通道没有就绪（可能被安全软件拦了）')
}

/**
 * 拉起浏览器，等用户扫码，然后抓凭据。
 *
 * onProgress 会收到 { phase, message } 形式的进度，便于界面显示。
 * 返回 { authorization, udId, closed:true } 或抛错。
 *
 * options（全部可省，主要给测试注入用）：
 *   spawnImpl   替换 child_process.spawn
 *   browser     指定浏览器可执行文件
 *   profileRoot 临时 profile 的父目录
 */
export async function scanLogin({ onProgress, signal, ...options } = {}) {
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
  const browser = typeof options.browser === 'string' && options.browser
    ? options.browser
    : findBrowser()
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
  const profileRoot = typeof options.profileRoot === 'string' && options.profileRoot
    ? options.profileRoot
    : tmpdir()
  const profileDir = join(profileRoot, `dsh-mcloud-scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(profileDir, { recursive: true })

  let child = null
  let session = null
  let cleaned = false

  /**
   * 收尾：关浏览器 + 删临时 profile。
   *
   * 🔴 这里是「暴露时间」的收口点。0.4.3 只在 finally 里 kill + 2 秒后删目录，
   * 而且拿到凭据后还要走完 finally 才关 —— 顺序上没错，但端口模式下
   * 「kill 之后进程真正退出」和「端口真正释放」之间还有窗口。
   *
   * 0.4.4 真机踩到的两个坑：
   *   · `child.kill()` 在 Windows 上**只杀父进程**，Edge 的渲染/GPU 子进程还活着，
   *     它们会把 profile 目录锁住 → rmSync 一直 EPERM/EBUSY，profile 留了下来；
   *   · 删目录只重试 5 次（约 1 秒）不够，子进程退出要一两秒。
   *
   * 所以现在：先优雅 `Browser.close`（带超时），再 `taskkill /T /F` 收整棵进程树，
   * 然后等进程真退出，最后删目录重试到 ~6 秒。
   */
  async function cleanup() {
    if (cleaned) return
    cleaned = true

    if (session) {
      // 优雅关闭：让浏览器自己退，profile 锁也会正常释放。超时就别等了。
      try {
        await Promise.race([session.send('Browser.close'), sleep(2000)])
      } catch {
        /* 浏览器可能已经自己关了 */
      }
      try {
        session.close()
      } catch {
        /* 已关闭 */
      }
      session = null
    }

    const pid = child && typeof child.pid === 'number' ? child.pid : 0
    const alive = () => Boolean(child) && (child.exitCode === null || child.exitCode === undefined)

    if (alive() && pid > 0 && process.platform === 'win32') {
      // Windows：必须连子进程一起收，否则 profile 目录被占着删不掉。
      try {
        await new Promise((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          killer.once('error', resolve)
          killer.once('exit', resolve)
        })
      } catch {
        /* 回落到下面的 child.kill() */
      }
    }
    if (alive()) {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
    }

    // 等进程真的走掉，否则 Windows 上 profile 里的文件还被占着
    const exitDeadline = Date.now() + 5000
    while (alive() && Date.now() < exitDeadline) {
      await sleep(100)
    }

    // 删目录：Windows 上占用释放有延迟，给到 ~6 秒
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        rmSync(profileDir, { recursive: true, force: true })
        return
      } catch {
        await sleep(200)
      }
    }
  }

  const browserArgs = (extra) => [
    ...extra,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeIdentityFRE,msEdgeSidebarV2',
    '--window-size=520,760',
    LOGIN_URL,
  ]

  try {
    report('launching', '正在启动浏览器…')

    /**
     * 首选 pipe：CDP 走继承句柄，**不监听任何 TCP 端口**。
     * stdio 第 3、4 位（数组下标 3/4）交给浏览器当控制通道：
     *   下标 3 → 浏览器读（我们写命令）
     *   下标 4 → 浏览器写（我们读响应）
     */
    try {
      child = spawnImpl(browser, browserArgs(['--remote-debugging-pipe']), {
        detached: false,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      })
      child.on?.('error', () => {
        /* 由下面的超时统一报错 */
      })
      const writable = child.stdio?.[3]
      const readable = child.stdio?.[4]
      if (!writable || !readable) throw new Error('没拿到 CDP 管道句柄')
      const pipeSession = openPipeSession(writable, readable)
      // 复核一句：对面真的是浏览器，而不是一个起不来的空壳
      const version = await pipeSession.send('Browser.getVersion')
      if (!version || typeof version.product !== 'string') {
        pipeSession.close()
        throw new Error('浏览器调试通道返回异常')
      }
      session = pipeSession
    } catch {
      // pipe 不可用：把这次拉起的进程收掉（等它真退出，别和下面的实例抢 profile），
      // 再走加固过的端口模式。
      try {
        if (child && child.exitCode === null) child.kill()
      } catch {
        /* 已经退出 */
      }
      const killDeadline = Date.now() + 3000
      while (child && child.exitCode === null && child.exitCode !== undefined && Date.now() < killDeadline) {
        await sleep(100)
      }
      child = null
    }

    if (!session) {
      /**
       * 回落路径：随机端口 + 只放行本机来源 + 校验 DevToolsActivePort。
       * 只在 pipe 真的起不来时才走到这里。
       */
      const port = await findRandomPort()
      report('launching', '正在启动浏览器（兼容模式）…')
      child = spawnImpl(browser, browserArgs([
        `--remote-debugging-port=${port}`,
        // 只放行这一个本机来源，别的 Origin 一律拒绝
        `--remote-allow-origins=http://127.0.0.1:${port}`,
      ]), { detached: false, stdio: 'ignore' })
      child.on?.('error', () => {
        /* 由下面的超时统一报错 */
      })

      const active = await waitForDevToolsPort(profileDir, port, 25_000, signal)
      const ws = await connectWebSocket(`ws://127.0.0.1:${active.port}${active.wsPath}`)
      const version = await ws.send('Browser.getVersion')
      if (!version || typeof version.product !== 'string') {
        ws.close()
        throw new Error('浏览器调试端口返回异常')
      }
      session = ws
    }

    report('waiting', '请在弹出的浏览器里扫码登录（最长等 5 分钟）')

    const deadline = Date.now() + SCAN_TIMEOUT_MS
    let lastReport = 0
    const state = { sessions: new Map() }

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('已取消扫码登录')
      if (child && child.exitCode !== null && child.exitCode !== undefined) {
        throw new Error('浏览器被关闭了，扫码登录已取消')
      }

      const cookies = await readCookies(session, state)
      const picked = pickCredentials(cookies)
      if (picked) {
        report('success', '登录成功，正在保存凭据…')
        // 凭据到手就立刻收尾（关浏览器 + 清 profile），不再等 5 分钟超时。
        await cleanup()
        return { ...picked, closed: true }
      }

      const now = Date.now()
      if (now - lastReport > 8000) {
        lastReport = now
        const left = Math.max(0, Math.round((deadline - now) / 1000))
        report('waiting', `等待扫码登录…（剩余 ${left} 秒）`)
      }
      await sleepUnlessAborted(1200, signal)
    }

    throw new Error('扫码登录超时（5 分钟）。请重新点击「扫码登录」')
  } finally {
    // 成功路径已经 cleanup 过（cleaned=true 时这里是空操作）；
    // 取消 / 超时 / 出错都靠这里保证端口关闭、临时 profile 删掉。
    await cleanup()
  }
}

// 给测试用：只导出纯函数 / 内部实现，不导出任何凭据。
export const __test = { pickCredentials, findRandomPort }

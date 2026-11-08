/**
 * dsh-mcloud — Host half（宿主端）
 *
 * 把「中国移动云盘 / 139」接进 DeepSeek Harness：
 *   · 工具（ctx.tools.register）：容量、列目录、搜索、下载直链、新建/改名/移动/删除
 *   · HTTP 路由（/api/dsh-mcloud/*）：给会话页那个「移动云盘」标签面板用
 *   · 凭据：Windows 走当前用户 DPAPI 加密，存在 ~/.dsh-mcloud/
 *
 * 协议说明：官方没有公开 MCP，这里按社区逆向出来的 personal_new（新的个人盘）接口实现，
 * 主要参考 OpenList 的 drivers/139（AGPL-3.0）与 cloud_driver_sdk 的 Yun139。
 * 关键点：
 *   · 请求要带 Mcloud-Sign：对「实际发出的 JSON 字符串」做 encodeURIComponent → 逐字符排序 →
 *     base64 → md5(b64) + md5(ts:rand) → 再 md5 取大写。签名和 body 必须来自同一个字符串。
 *   · Authorization: Basic <base64("pc:账号:authToken|...|到期毫秒")>
 *   · 业务 host 要先问 /user/route/qryRoutePolicy 拿，失败再回落到 personal-kd-njs。
 *
 * 写入类操作全部默认要过 Harness 审批。
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  createWriteStream,
} from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, basename, dirname } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import {
  PART_BATCH,
  UPLOAD_CONTENT_TYPE,
  buildPartInfos,
  partSizeFor,
  putParts,
  sha256File,
  streamToFile,
} from './transfer.js'

export const name = 'dsh-mcloud'
export const inject = ['tools']

// ------------------------------------------------------------------ 常量

const USER_HOST = 'https://user-njs.yun.139.com'
const FALLBACK_PERSONAL_HOST = 'https://personal-kd-njs.yun.139.com/hcy'
const REFRESH_URL = 'https://aas.caiyun.feixin.10086.cn:443/tellin/authTokenRefresh.do'
const WRITE_HEADER = 'x-dsh-mcloud'
const REQUEST_TIMEOUT_MS = 25_000

/** 瞬时网络故障的重试策略（移动云盘偶发 ECONNRESET / 超时 / 5xx） */
const MCLOUD_RETRY_ATTEMPTS = 3
const MCLOUD_RETRY_DELAY_MS = 400

/**
 * 目录分页大小。
 * 实测（同一个 100 项的目录，各测 3 次取中位数）：
 *   pageSize= 10 →  1353 ms
 *   pageSize= 20 →  6631 ms
 *   pageSize= 30 → 13692 ms
 *   pageSize= 50 → 16088 ms
 *   pageSize=100 → 25311 ms（还会超时/ECONNRESET）
 * 这个接口对「一次要多少条」极度敏感，几乎是二次方恶化。
 * 所以只请求 10 项 —— 首屏要的是「快」，剩下的靠「加载更多」。
 */
const LIST_PAGE_SIZE = 10

/**
 * 目录列表缓存。点文件夹「慢」的很大一部分原因是每次进出都重新拉一遍，
 * 而移动云盘对同一目录的重复请求还会限流。缓存 60 秒，任何写操作都会清掉。
 */
const LIST_CACHE_TTL_MS = 60_000
const LIST_CACHE_MAX = 200

const ROOT_ID = '/'
const MB = 1024 * 1024

const DEFAULT_CREDENTIAL_DIR = process.env.DSH_MCLOUD_CREDENTIAL_DIR
  ? resolve(process.env.DSH_MCLOUD_CREDENTIAL_DIR)
  : join(homedir(), '.dsh-mcloud')

/**
 * 老版本（插件还叫 dsh-mobile-cloud 时）把凭据存在这里。
 * 新目录没有凭据时回落到它，免得升级后用户还得重新授权一次。
 */
const LEGACY_CREDENTIAL_DIRS = [
  process.env.DSH_MOBILE_CLOUD_CREDENTIAL_DIR
    ? resolve(process.env.DSH_MOBILE_CLOUD_CREDENTIAL_DIR)
    : join(homedir(), '.dsh-mobile-cloud'),
]

/** 「下载到本地」不填路径时的默认落地目录 */
const DEFAULT_DOWNLOAD_DIR = join(homedir(), 'Downloads', 'dsh-mcloud')

const TOOL_PREFIX = 'mcloud_'
const WRITE_TOOL_NAMES = new Set([
  TOOL_PREFIX + 'mkdir',
  TOOL_PREFIX + 'rename',
  TOOL_PREFIX + 'move',
  TOOL_PREFIX + 'remove',
  // 上传会改网盘内容；下载会往本机磁盘写文件（路径是模型给的），都值得确认一下
  TOOL_PREFIX + 'upload',
  TOOL_PREFIX + 'upload_folder',
  TOOL_PREFIX + 'download',
  TOOL_PREFIX + 'download_folder',
])

const windows = process.platform === 'win32'

// ------------------------------------------------------------------ 小工具

function unwrapConfig(raw) {
  if (!raw || typeof raw !== 'object') return {}
  if (raw.config && typeof raw.config === 'object') return raw.config
  return raw
}

function md5(input) {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

function randomString(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/** 对应 Go 的 time.Now().Format("2006-01-02 15:04:05")，本地时间 */
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * Mcloud-Sign 算法。
 * 注意 encodeURIComponent 与 OpenList 那个辅助函数等价（Go 侧是把 QueryEscape 的
 * + %21 %27 %28 %29 %2A 再改回原字符），所以这里直接用 encodeURIComponent。
 */
function calcSign(bodyString, timestamp, randStr) {
  const encoded = encodeURIComponent(bodyString)
  const sorted = encoded.split('').sort().join('')
  const b64 = Buffer.from(sorted, 'utf8').toString('base64')
  const mixed = md5(b64) + md5(`${timestamp}:${randStr}`)
  return md5(mixed).toUpperCase()
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampPageSize(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return LIST_PAGE_SIZE
  return Math.min(Math.max(Math.trunc(n), 1), 100)
}

/** 极简 LRU：Map 的插入顺序就是访问顺序，超量就删最旧的。 */
function createCache(ttlMs, maxEntries) {
  const map = new Map()
  return {
    get(key) {
      const hit = map.get(key)
      if (!hit) return null
      if (Date.now() - hit.at > ttlMs) {
        map.delete(key)
        return null
      }
      // 命中就挪到末尾（最近使用）
      map.delete(key)
      map.set(key, hit)
      return hit.value
    },
    set(key, value) {
      map.set(key, { at: Date.now(), value })
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value
        map.delete(oldest)
      }
    },
    clear() {
      map.clear()
    },
    get size() {
      return map.size
    },
  }
}

/**
 * undici 的 fetch 失败只会说 "fetch failed"，真正的原因（ECONNRESET / ENOTFOUND /
 * ETIMEDOUT…）藏在 error.cause 里。把它挖出来，用户才看得懂到底怎么了。
 */
function describeFetchError(error) {
  if (!error) return '未知网络错误'
  const cause = error.cause
  if (cause) {
    const code = cause.code || cause.errno
    const detail = cause.message || ''
    if (code && detail) return `${code}：${detail}`
    if (code) return String(code)
    if (detail) return detail
  }
  return errorMessage(error)
}

/**
 * 判断「重试也没用」的错误，别白等：
 * 授权过期、参数不合法、文件不存在这类都得用户动手，重试纯浪费时间。
 */
function isPermanentError(error) {
  if (!error) return true
  if (error.name === 'AbortError') return true
  const message = errorMessage(error)
  if (/授权已过期|还没有授权|不是合法|结构不对|参数不合法|不存在|没有权限|已取消/.test(message)) return true
  return false
}

/**
 * 账号脱敏。移动云盘这边没有能查昵称的接口（试过 /user/info 等，全是「资源不存在」），
 * 而 Authorization 里带的账号就是一个手机号，所以面板默认只显示脱敏串。
 */
function maskAccount(value) {
  if (!value) return null
  const text = String(value)
  // 手机号：只露前 3 位和后 2 位，中间全隐藏
  if (/^\d{11}$/.test(text)) {
    return `${text.slice(0, 3)}${'*'.repeat(6)}${text.slice(-2)}`
  }
  if (text.includes('@')) {
    const at = text.indexOf('@')
    const name = text.slice(0, at)
    const domain = text.slice(at)
    const head = name.slice(0, Math.min(2, name.length))
    return `${head}${'*'.repeat(Math.max(1, name.length - head.length))}${domain}`
  }
  if (text.length <= 5) return '*'.repeat(text.length)
  return `${text.slice(0, 3)}${'*'.repeat(text.length - 5)}${text.slice(-2)}`
}

// ------------------------------------------------------------------ 凭据

function dpapi(input, decrypt = false) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
    '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    `$result = [Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($bytes, $null, $scope)`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join('; ')
  const executable = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: input.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  })
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error('Windows 无法访问凭据存储（DPAPI 调用失败）')
  }
  return Buffer.from(result.stdout.trim(), 'base64')
}

function createCredentialStore(directory, legacyDirectories = []) {
  const fileName = windows ? 'authorization.dpapi' : 'authorization.json'
  const file = join(directory, fileName)

  /** 把某个文件解成凭据；解不开就返回 null。 */
  function readFrom(target) {
    let bytes
    try {
      bytes = readFileSync(target)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    try {
      const text = (windows ? dpapi(bytes, true) : bytes).toString('utf8')
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed.authorization !== 'string' || !parsed.authorization) return null
      return {
        authorization: parsed.authorization,
        userDomainId: typeof parsed.userDomainId === 'string' ? parsed.userDomainId : '',
      }
    } catch {
      // 存储坏了就当没授权，别把整个插件拖死
      return null
    }
  }

  return {
    file,
    read() {
      // 先看新位置
      const current = readFrom(file)
      if (current) return current
      // 再看旧位置（插件改名前叫 dsh-mobile-cloud）
      for (const legacyDir of legacyDirectories) {
        const legacy = readFrom(join(legacyDir, fileName))
        if (legacy) return legacy
      }
      return null
    },
    write(value) {
      const payload = Buffer.from(JSON.stringify(value), 'utf8')
      const stored = windows ? dpapi(payload) : payload
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, randomUUID())
      try {
        writeFileSync(temporary, stored, { mode: 0o600, flag: 'wx' })
        renameSync(temporary, file)
      } finally {
        rmSync(temporary, { force: true })
      }
    },
    clear() {
      rmSync(file, { force: true })
      // 老位置也一起清掉，否则「清除授权」看起来没生效
      for (const legacyDir of legacyDirectories) {
        rmSync(join(legacyDir, fileName), { force: true })
      }
    },
  }
}

// ------------------------------------------------------------------ Authorization 解析 / 刷新

function decodeAuthorization(authorization) {
  let decoded
  try {
    decoded = Buffer.from(authorization, 'base64').toString('utf8')
  } catch {
    throw new Error('Authorization 不是合法的 base64')
  }
  const firstColon = decoded.indexOf(':')
  const secondColon = firstColon < 0 ? -1 : decoded.indexOf(':', firstColon + 1)
  if (firstColon < 0 || secondColon < 0) {
    throw new Error('Authorization 结构不对，应该是 base64 的 pc:账号:令牌')
  }
  const account = decoded.slice(firstColon + 1, secondColon)
  const tokenPart = decoded.slice(secondColon + 1)
  const fields = tokenPart.split('|')
  const expiration = fields.length >= 4 ? Number(fields[3]) : Number.NaN
  return { account, tokenPart, expiration: Number.isFinite(expiration) ? expiration : null }
}

function readXmlField(xml, tag) {
  const matched = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i').exec(xml)
  return matched ? matched[1] : ''
}

// ------------------------------------------------------------------ 原生文件对话框

const PICKER_TIMEOUT_MS = 5 * 60 * 1000

function powershellPath() {
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

// 弹系统对话框踩过的坑，一次说清：
//
// 1) **对话框会比浏览器低，用户看不见**。Windows 前台锁定规则不允许后台进程抢焦点，
//    SetForegroundWindow 直接返回 False。做法：对话框一出来就 SetWindowPos(HWND_TOPMOST)
//    顶上去；因为 ShowDialog 是模态的，得靠 WinForms Timer 在模态消息循环里抢。
//    （实测 z 序：修复前「对话框 54 / DSH 45」，修复后「对话框 13 / DSH 57」。）
// 2) **千万别给对话框传一个 1x1 的 helper 窗体当 owner**。WinForms 会把对话框
//    **居中到 owner 上**，owner 在 (0,0) 就导致对话框被挤到屏幕左上角、大半在屏幕外
//    —— 用户看到的就是「左上角一块白色长方形」，而且完全不像正常的文件对话框。
//    所以这里**不加 owner**：ShowDialog() 让系统自己居中。
//    （实测：RECT L=220 T=161 W=664 H=572，1536x864 屏幕上完全可见。）
// 3) **定时器要耐心**。早期版本只找 6 秒，机器一忙对话框还没出来就放弃了，
//    于是「第一次能弹、后面点几次才出来」。现在最多找 60 秒，出现后再顶住约 3 秒。
// 4) **路径不能用管道明文回传**。PowerShell 写管道用控制台代码页（国区 GBK），
//    Node 按 UTF-8 解会乱码 —— 文件名一带中文就废。所以用 base64（纯 ASCII）。
const PICKER_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -Namespace MC -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder s, int n);
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
'@

$script:me = [uint32][System.Diagnostics.Process]::GetCurrentProcess().Id
$script:TOPMOST = [IntPtr]::new([int64](-1))
$script:FLAGS = 0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0040

function Set-MyTopmost([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return }
  [void][MC.Win]::SetWindowPos($h, $script:TOPMOST, 0, 0, 0, 0, $script:FLAGS)
  $fg = [MC.Win]::GetForegroundWindow()
  $fgPid = 0
  $fgTid = [MC.Win]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $curTid = [MC.Win]::GetCurrentThreadId()
  $attached = $false
  if ($fgTid -ne 0 -and $fgTid -ne $curTid) {
    $attached = [MC.Win]::AttachThreadInput($curTid, $fgTid, $true)
  }
  try {
    [void][MC.Win]::SetForegroundWindow($h)
  } finally {
    if ($attached) { [void][MC.Win]::AttachThreadInput($curTid, $fgTid, $false) }
  }
}

# 本进程当前开着的那个 #32770 对话框（OpenFileDialog / FolderBrowserDialog 都是这个类）
function Get-MyDialog {
  $script:hit = [IntPtr]::Zero
  $cb = [MC.Win+EnumProc]{
    param([IntPtr]$h, [IntPtr]$l)
    $p = 0
    [void][MC.Win]::GetWindowThreadProcessId($h, [ref]$p)
    if ($p -eq $script:me) {
      $sb = New-Object System.Text.StringBuilder 64
      [void][MC.Win]::GetClassNameW($h, $sb, 64)
      if ($sb.ToString() -eq '#32770') { $script:hit = $h; return $false }
    }
    return $true
  }
  [void][MC.Win]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:hit
}

$script:ticks = 0
$script:pushed = 0
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 150
$script:timer.Add_Tick({
  $script:ticks = $script:ticks + 1
  $h = Get-MyDialog
  if ($h -ne [IntPtr]::Zero) {
    Set-MyTopmost $h
    $script:pushed = $script:pushed + 1
    if ($script:pushed -ge 20) { $script:timer.Stop() }
  } elseif ($script:ticks -ge 400) {
    $script:timer.Stop()
  }
})
$script:timer.Start()

$emit = { param($p) [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))) }
`

const PICKER_FILES = `${PICKER_PRELUDE}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.AutoUpgradeEnabled = $true
$d.Title = '选择要上传到移动云盘的文件（可多选）'
$d.Multiselect = $true
$d.CheckFileExists = $true
$r = $d.ShowDialog()
$script:timer.Stop()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) {
  foreach ($f in $d.FileNames) { & $emit $f }
}
`

const PICKER_FOLDER = `${PICKER_PRELUDE}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '选择要上传到移动云盘的文件夹'
$d.ShowNewFolderButton = $false
$r = $d.ShowDialog()
$script:timer.Stop()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { & $emit $d.SelectedPath }
`

/**
 * 弹系统原生的「打开文件 / 选择文件夹」对话框，返回选中的真实路径。
 * 走的是宿主端进程，所以拿到的是磁盘真实路径 —— 上传时直接从磁盘流式读，
 * 不用把文件内容先搬到浏览器再搬回来。
 */
function pickLocalPaths(mode) {
  if (!windows) {
    return Promise.reject(new Error('原生文件对话框目前只支持 Windows，请直接手填路径'))
  }
  const script = mode === 'folder' ? PICKER_FOLDER : PICKER_FILES
  return new Promise((resolvePick, rejectPick) => {
    const child = spawn(powershellPath(), ['-NoProfile', '-STA', '-Command', script], {
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      rejectPick(new Error('等待选择超时（5 分钟）'))
    }, PICKER_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPick(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !stdout.trim()) {
        rejectPick(new Error(`对话框异常退出（code=${code}）：${stderr.trim().slice(0, 300) || '无输出'}`))
        return
      }
      const paths = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return Buffer.from(line, 'base64').toString('utf8')
          } catch {
            return line // 万一不是 base64，原样返回也好过直接丢掉
          }
        })
        .filter(Boolean)
      resolvePick(paths)
    })
  })
}

/** 递归列出本地目录，用来做「上传整个文件夹」 */
async function walkLocal(dir, prefix, tree, depth = 0) {
  if (depth > 32) throw new Error('本地目录层级过深，已中止')
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    const relative = prefix ? join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      tree.dirs.push(relative)
      await walkLocal(full, relative, tree, depth + 1)
    } else if (entry.isFile()) {
      let size = 0
      try {
        size = statSync(full).size
      } catch {
        continue // 读不到就跳过，别让一个坏文件毁掉整次上传
      }
      tree.files.push({ local: full, relative, size })
    }
  }
}

// ------------------------------------------------------------------ 客户

function createClient(store, logger, config) {
  let credential = store.read()
  let host = null
  let quirkNoUserDomainId = false

  function current() {
    return credential
  }

  function update(next) {
    credential = next
    store.write(next)
    quirkNoUserDomainId = false
  }

  function forget() {
    credential = null
    store.clear()
  }

  function assertAuthorized() {
    if (!credential?.authorization) {
      throw new Error('还没有授权。先在「移动云盘」面板里粘贴 Authorization，或在变量里跑 dsh-mcloud 授权流程。')
    }
    return credential
  }

  /** 令牌快到期（<15 天）就换新的，跟 OpenList 一个判断 */
  async function ensureFresh() {
    const value = assertAuthorized()
    const info = decodeAuthorization(value.authorization)
    if (info.expiration !== null) {
      const remaining = info.expiration - Date.now()
      if (remaining < 0) throw new Error('授权已过期，请重新粘贴 Authorization')
      if (remaining > 15 * 24 * 60 * 60 * 1000) return value
    }
    const body =
      `<root><token>${info.tokenPart}</token><account>${info.account}</account><clienttype>656</clienttype></root>`
    const response = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const xml = await response.text()
    if (readXmlField(xml, 'return') !== '0') {
      throw new Error(`刷新授权失败：${readXmlField(xml, 'desc') || xml.slice(0, 200)}`)
    }
    const token = readXmlField(xml, 'token')
    if (!token) throw new Error('刷新授权失败：返回里没有 token')
    const next = {
      authorization: Buffer.from(`pc:${info.account}:${token}`, 'utf8').toString('base64'),
      userDomainId: value.userDomainId,
    }
    update(next)
    logger?.info?.('mobile-cloud: 授权已自动续期')
    return next
  }

  function buildHeaders(bodyString, personal) {
    const timestamp = formatTimestamp()
    const randStr = randomString(16)
    const sign = calcSign(bodyString, timestamp, randStr)
    const base = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      authorization: `Basic ${assertAuthorized().authorization}`,
      'mcloud-channel': '1000101',
      'mcloud-client': '10701',
      'mcloud-sign': `${timestamp},${randStr},${sign}`,
      'mcloud-version': '7.14.0',
      'x-deviceinfo': '||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||',
      'x-huawei-channelsrc': '10000034',
      'x-inner-ntwk': '2',
      'x-m4c-caller': 'PC',
      'x-m4c-src': '10002',
      'x-svctype': '1',
    }
    if (!personal) {
      return {
        ...base,
        'cms-device': 'default',
        origin: 'https://yun.139.com',
        referer: 'https://yun.139.com/w/',
        'inner-hcy-router-https': '1',
      }
    }
    return {
      ...base,
      caller: 'web',
      'cms-device': 'default',
      'mcloud-route': '001',
      'x-yun-api-version': 'v1',
      'x-yun-app-channel': '10000034',
      'x-yun-channel-source': '10000034',
      'x-yun-client-info':
        '||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||dW5kZWZpbmVk||',
      'x-yun-module-type': '100',
      'x-yun-svc-type': '1',
    }
  }

  /**
   * 发一个带签名的请求。
   * 签名和 body 一定来自同一个字符串 —— 这是这个接口唯一容易踩的坑。
   *
   * 网络层带重试：移动云盘偶发 ECONNRESET / 超时 / 5xx，以前一抖就把
   * 「fetch failed」原样抛给界面（目录加载不出来、删除失败都是它）。
   * 只对**瞬时错误**重试；业务错误（success:false）立即抛出，不浪费用户时间。
   */
  async function call(url, payload, { personal = true, signal } = {}) {
    const bodyString = JSON.stringify(payload ?? {})
    const headers = buildHeaders(bodyString, personal)

    let lastError = null
    for (let attempt = 1; attempt <= MCLOUD_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: bodyString,
          signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })

        // 5xx / 429 属于「待会儿再试可能就好」，值得重试
        if ((response.status >= 500 || response.status === 429) && attempt < MCLOUD_RETRY_ATTEMPTS) {
          lastError = new Error(`移动云盘暂时不可用（HTTP ${response.status}）`)
          await sleep(MCLOUD_RETRY_DELAY_MS * attempt)
          continue
        }

        const text = await response.text()
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error(`移动云盘返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}`)
        }
        if (json && json.success === false) {
          // 业务错误：重试没用，直接抛。
          throw new Error(json.message || json.code || '移动云盘拒绝了这次请求')
        }
        return json
      } catch (error) {
        lastError = error
        if (isPermanentError(error) || attempt >= MCLOUD_RETRY_ATTEMPTS) {
          // 三次都失败：把真正的原因翻出来，别只给一句 "fetch failed"。
          if (/fetch failed/i.test(errorMessage(error))) {
            throw new Error(`连不上移动云盘（已重试 ${attempt} 次）：${describeFetchError(error)}`)
          }
          throw error
        }
        logger?.warn?.(`mobile-cloud: 第 ${attempt} 次请求失败，准备重试（${describeFetchError(error)}）`)
        await sleep(MCLOUD_RETRY_DELAY_MS * attempt)
      }
    }
    throw lastError ?? new Error('移动云盘请求失败')
  }

  function personalUrl(pathname) {
    if (!host) throw new Error('移动云盘 host 还没解析出来')
    return host + pathname
  }

  async function resolveHost() {
    const value = assertAuthorized()
    const account = decodeAuthorization(value.authorization).account
    try {
      const json = await call(
        `${USER_HOST}/user/route/qryRoutePolicy`,
        {
          userInfo: { userType: 1, accountType: 1, accountName: account },
          modAddrType: 1,
        },
        { personal: false },
      )
      const list = json?.data?.routePolicyList
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item?.modName === 'personal' && typeof item.httpsUrl === 'string' && item.httpsUrl) {
            host = item.httpsUrl.replace(/\/+$/, '')
            logger?.info?.(`mobile-cloud: 个人云 host = ${host}`)
            return host
          }
        }
      }
    } catch (error) {
      logger?.warn?.(`mobile-cloud: 路由查询失败，回落到默认 host（${errorMessage(error)}）`)
    }
    host = FALLBACK_PERSONAL_HOST
    return host
  }

  async function ensureHost() {
    if (!host) await resolveHost()
    return host
  }

  async function withHostRetry(operation) {
    await ensureHost()
    try {
      return await operation()
    } catch (error) {
      // host 可能是过期的路由，重解析一次再试
      const message = errorMessage(error)
      if (/host|404|not found|权限|无效/i.test(message)) {
        host = null
        await ensureHost()
        return await operation()
      }
      throw error
    }
  }

  // ---------------------------------------------------------- 具体接口

  const listCache = createCache(LIST_CACHE_TTL_MS, LIST_CACHE_MAX)

  async function listFiles(parentFileId, cursor = '', pageSize = LIST_PAGE_SIZE, { force = false } = {}) {
    const key = `${parentFileId || ROOT_ID}|${cursor || ''}|${clampPageSize(pageSize)}`
    if (!force) {
      const cached = listCache.get(key)
      if (cached) return cached
    }
    const result = await withHostRetry(async () => {
      // ⚠️ 不要带 imageThumbnailStyleList！
      // 实测：100 张图的目录带上它，服务端 3 秒直接 ECONNRESET；不带它虽然也要 6 秒但能成功。
      // 而且本插件的界面根本不显示缩略图 —— 纯纯的无谓负担。
      const json = await call(personalUrl('/file/list'), {
        orderBy: 'updated_at',
        orderDirection: 'DESC',
        pageInfo: { pageCursor: cursor || '', pageSize: clampPageSize(pageSize) },
        parentFileId: parentFileId || ROOT_ID,
      })
      const items = Array.isArray(json?.data?.items) ? json.data.items : []
      return {
        items: items.map((item) => ({
          id: String(item.fileId ?? ''),
          name: String(item.name ?? ''),
          size: Number(item.size ?? 0),
          type: String(item.type ?? '').toLowerCase() === 'folder' ? 'folder' : 'file',
          updatedAt: String(item.updatedAt ?? ''),
          thumbnail: null,
        })),
        nextCursor: json?.data?.nextPageCursor ? String(json.data.nextPageCursor) : null,
      }
    })
    listCache.set(key, result)
    return result
  }

  /** 任何会改动网盘内容的操作之后，缓存一律作废（宁可多拉一次，也不能给旧数据）。 */
  function invalidateListings() {
    listCache.clear()
  }

  async function getDownloadUrl(fileId) {
    return withHostRetry(async () => {
      const json = await call(personalUrl('/file/getDownloadUrl'), { fileId })
      const data = json?.data ?? {}
      if (data.cdnSwitch && data.cdnUrl) return String(data.cdnUrl)
      if (data.url) return String(data.url)
      if (data.cdnUrl) return String(data.cdnUrl)
      throw new Error('移动云盘没有返回下载直链')
    })
  }

  async function makeDir(parentFileId, dirName) {
    try {
      return await withHostRetry(() =>
        call(personalUrl('/file/create'), {
          parentFileId: parentFileId || ROOT_ID,
          name: dirName,
          description: '',
          type: 'folder',
          fileRenameMode: 'force_rename',
        }),
      )
    } finally {
      invalidateListings()
    }
  }

  async function renameNode(fileId, nextName) {
    try {
      return await withHostRetry(() =>
        call(personalUrl('/file/update'), { fileId, name: nextName, description: '' }),
      )
    } finally {
      invalidateListings()
    }
  }

  async function moveNodes(fileIds, toParentFileId) {
    try {
      return await withHostRetry(() =>
        call(personalUrl('/file/batchMove'), {
          fileIds: fileIds.map(String),
          toParentFileId: toParentFileId || ROOT_ID,
        }),
      )
    } finally {
      invalidateListings()
    }
  }

  async function removeNodes(fileIds) {
    try {
      return await withHostRetry(() =>
        call(personalUrl('/recyclebin/batchTrash'), { fileIds: fileIds.map(String) }),
      )
    } finally {
      invalidateListings()
    }
  }

  /** 确保父目录下有个叫 name 的文件夹，返回它的 id。已存在就复用，不重复创建。 */
  async function ensureFolder(parentFileId, name) {
    const parent = parentFileId || ROOT_ID
    const findExisting = async () => {
      let cursor = ''
      do {
        const page = await listFiles(parent, cursor)
        const hit = page.items.find((item) => item.type === 'folder' && item.name === name)
        if (hit) return hit.id
        cursor = page.nextCursor || ''
      } while (cursor)
      return null
    }

    const existing = await findExisting()
    if (existing) return existing

    const created = await withHostRetry(() =>
      call(personalUrl('/file/create'), {
        parentFileId: parent,
        name,
        description: '',
        type: 'folder',
        fileRenameMode: 'force_rename',
      }),
    )
    const id = created?.data?.fileId
    if (id) return String(id)

    // 有些响应不回 id，再列一次兜底
    const after = await findExisting()
    if (after) return after
    throw new Error(`建好文件夹「${name}」之后没能拿到它的 ID`)
  }

  // ---------------------------------------------------------- 传输（上传 / 下载）

  const jobs = new Map()

  function accountOf() {
    return decodeAuthorization(assertAuthorized().authorization).account
  }

  function snapshot(job) {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      phase: job.phase,
      done: job.done,
      total: job.total,
      state: job.state,
      error: job.error,
      result: job.result,
      currentFile: job.currentFile ?? null,
      fileCount: job.fileCount ?? null,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }
  }

  /** 起一个后台传输任务。job.promise 给工具用（可以 await 到结束） */
  function startJob(kind, label, runner) {
    const job = {
      id: randomUUID().slice(0, 8),
      kind,
      label,
      phase: 'prepare',
      done: 0,
      total: 0,
      state: 'running',
      error: null,
      result: null,
      startedAt: Date.now(),
      finishedAt: null,
      controller: new AbortController(),
    }
    job.signal = job.controller.signal
    jobs.set(job.id, job)

    // 顺手清掉半小时前就结束的任务，别让 Map 无限长
    for (const [id, old] of jobs) {
      if (old.state !== 'running' && Date.now() - (old.finishedAt ?? old.startedAt) > 30 * 60 * 1000) {
        jobs.delete(id)
      }
    }

    job.promise = (async () => {
      try {
        const result = await runner(job)
        job.state = 'done'
        job.result = result ?? null
        return result
      } catch (error) {
        job.state = 'error'
        job.error = errorMessage(error)
        throw error
      } finally {
        job.finishedAt = Date.now()
      }
    })()
    // 面板只轮询不用 await，这里兜一下避免 unhandled rejection
    job.promise.catch(() => {})
    return job
  }

  function getJob(id) {
    const job = jobs.get(id)
    return job ? snapshot(job) : null
  }

  function listJobs() {
    return [...jobs.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, 20)
      .map(snapshot)
  }

  function cancelJob(id) {
    const job = jobs.get(id)
    if (!job || job.state !== 'running') return false
    job.controller.abort()
    return true
  }

  /**
   * 上传本地文件。流程见 transfer.js 顶部的注释。
   * 注意：整个文件只流式读一遍算哈希，分片也是流式 PUT，不把文件读进内存。
   */
  async function uploadFile(localPath, parentFileId, nameOverride, job) {
    // 单文件任务是「这个任务就是这个文件」，所以它负责维护 total / phase；
    // 文件夹任务由 uploadFolder 统一管进度，子文件不要抢。
    const solo = job.kind === 'upload'
    const stats = statSync(localPath)
    if (!stats.isFile()) throw new Error(`不是一个文件：${localPath}`)
    const size = stats.size
    const fileName = String(nameOverride || basename(localPath))
    const partInfos = buildPartInfos(size, partSizeFor(size))

    // 每个文件对进度的贡献恒等于它的字节数 —— 不管是真传了、秒传了，
    // 还是服务端压根没给分片地址。否则 total（按本地文件大小算出来的）
    // 永远对不上 done，进度条就卡在中间到不了 100%。
    const startDone = job.done
    const settle = () => {
      const gained = job.done - startDone
      if (gained < size) job.done += size - gained
    }

    if (solo) {
      job.total = size
      job.phase = 'hash'
    }
    const contentHash = await sha256File(localPath)
    if (job.signal.aborted) throw new Error('已取消')

    if (solo) job.phase = 'create'
    const created = await withHostRetry(() =>
      call(personalUrl('/file/create'), {
        contentHash,
        contentHashAlgorithm: 'SHA256',
        contentType: UPLOAD_CONTENT_TYPE,
        parallelUpload: false,
        partInfos: partInfos.slice(0, PART_BATCH),
        size,
        parentFileId: parentFileId || ROOT_ID,
        name: fileName,
        type: 'file',
        fileRenameMode: 'auto_rename',
      }),
    )

    const task = created?.data ?? {}
    if (task.exist === true || task.rapidUpload === true) {
      settle() // 秒传：字节没走网络，但这个文件确实「传完了」
      return {
        dedup: true,
        fileId: task.fileId ?? null,
        name: task.fileName ?? fileName,
        size,
        message: '网盘里已有完全相同的内容，服务端直接秒传，没有真的传数据。',
      }
    }

    const fileId = task.fileId
    const uploadId = task.uploadId
    if (!fileId || !uploadId) {
      throw new Error('创建上传任务失败：服务端没返回 fileId / uploadId')
    }

    if (solo) job.phase = 'upload'
    const account = accountOf()
    await putParts(partInfos, task.partInfos, localPath, (n) => {
      job.done += n
    }, job.signal)

    // 超过 100 个分片要分批取上传地址
    for (let index = PART_BATCH; index < partInfos.length; index += PART_BATCH) {
      const batch = partInfos.slice(index, index + PART_BATCH)
      const more = await withHostRetry(() =>
        call(personalUrl('/file/getUploadUrl'), {
          fileId,
          uploadId,
          partInfos: batch,
          commonAccountInfo: { account, accountType: 1 },
        }),
      )
      await putParts(partInfos, more?.data?.partInfos, localPath, (n) => {
        job.done += n
      }, job.signal)
    }

    if (solo) job.phase = 'complete'
    await withHostRetry(() =>
      call(personalUrl('/file/complete'), {
        contentHash,
        contentHashAlgorithm: 'SHA256',
        fileId,
        uploadId,
      }),
    )

    settle()
    invalidateListings()

    return {
      dedup: false,
      fileId,
      name: task.fileName ?? fileName,
      size,
      parts: partInfos.length,
    }
  }

  /** 上传整个本地文件夹：远端按同样结构建好（同名文件夹直接复用） */
  async function uploadFolder(localPath, parentFileId, job) {
    const stats = statSync(localPath)
    if (!stats.isDirectory()) throw new Error(`不是一个文件夹：${localPath}`)

    job.phase = 'scan'
    const tree = { dirs: [], files: [] }
    await walkLocal(localPath, '', tree)
    job.total = tree.files.reduce((sum, file) => sum + file.size, 0)
    job.fileCount = tree.files.length
    if (job.signal.aborted) throw new Error('已取消')

    const rootName = basename(localPath)
    const rootId = await ensureFolder(parentFileId || ROOT_ID, rootName)
    const idMap = new Map([['', rootId]])

    job.phase = 'create'
    for (const dir of tree.dirs) {
      if (job.signal.aborted) throw new Error('已取消')
      job.currentFile = dir
      const parentRel = dirname(dir)
      const parentRemote = idMap.get(parentRel === '.' ? '' : parentRel) ?? rootId
      idMap.set(dir, await ensureFolder(parentRemote, basename(dir)))
    }

    job.phase = 'upload'
    for (const file of tree.files) {
      if (job.signal.aborted) throw new Error('已取消')
      job.currentFile = file.relative
      const parentRel = dirname(file.relative)
      const parentRemote = idMap.get(parentRel === '.' ? '' : parentRel) ?? rootId
      await uploadFile(file.local, parentRemote, basename(file.relative), job)
    }
    job.currentFile = null
    invalidateListings()
    return { rootId, name: rootName, files: tree.files.length, bytes: job.done }
  }

  /**
   * 给「拖拽上传」用：拖进来的文件浏览器只给字节、不给真实路径，
   * 所以先把请求体落到临时文件，走完正常上传流程再删掉。
   */
  async function uploadFromTempPath(tempPath, parentFileId, name, job) {
    try {
      return await uploadFile(tempPath, parentFileId, name, job)
    } finally {
      rmSync(tempPath, { force: true })
    }
  }

  /** 把网盘文件流式下载到本地路径（先写 .part-xxx 再改名，失败不留半个文件） */
  async function downloadFile(fileId, localPath, job) {
    const url = await getDownloadUrl(fileId)
    const response = await fetch(url, { redirect: 'follow', signal: job.signal })
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0
    // 文件夹模式下 total 已经是整棵树的合计，别被单个文件覆盖
    if (total && !job.total) job.total = total

    job.phase = 'download'
    await streamToFile(response.body, localPath, (bytes) => {
      job.done += bytes
    }, job.signal)
    return { localPath, bytes: job.done }
  }

  /**
   * 递归列出一棵目录树。
   * 移动云盘没有「打包下载」的公开端点（OpenList 的驱动遇到目录直接 NotFile），
   * 所以文件夹下载只能先把树走一遍，再逐个文件下。
   */
  async function collectFolder(folderId, prefix, out, depth = 0) {
    if (depth > 32) throw new Error('目录层级过深，可能在打转，已中止')
    let cursor = ''
    do {
      const page = await listFiles(folderId, cursor)
      for (const item of page.items) {
        if (item.type === 'folder') {
          await collectFolder(item.id, join(prefix, item.name), out, depth + 1)
        } else {
          out.push({ fileId: item.id, relative: join(prefix, item.name), size: item.size })
        }
      }
      cursor = page.nextCursor || ''
    } while (cursor)
  }

  async function downloadFolder(folderId, localDir, job) {
    job.phase = 'scan'
    const files = []
    await collectFolder(folderId, '', files)
    job.total = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
    job.fileCount = files.length
    job.phase = 'download'

    if (!files.length) {
      mkdirSync(localDir, { recursive: true })
      return { localDir, files: 0, bytes: 0, message: '这个文件夹是空的。' }
    }

    for (const file of files) {
      if (job.signal.aborted) throw new Error('已取消')
      job.currentFile = file.relative
      await downloadFile(file.fileId, join(localDir, file.relative), job)
    }
    job.currentFile = null
    return { localDir, files: files.length, bytes: job.done }
  }

  async function getQuota() {
    const value = assertAuthorized()
    // 注意：OpenList 在没有 userDomainId 时直接拒绝查询，但那是它自己的保守判断，
    // 接口本身未必校验。所以这里照样发出去，让上游自己决定。
    const json = await call(
      `${USER_HOST}/user/disk/quota/detail`,
      { userDomainId: value.userDomainId || '' },
      { personal: false },
    )
    const data = json?.data ?? {}
    const totalBytes = Number(data.diskSize ?? 0) * MB
    const freeBytes = Number(data.freeDiskSize ?? 0) * MB
    if (!totalBytes) {
      throw new Error(
        value.userDomainId
          ? '容量接口没返回 diskSize'
          : '容量接口返回空（大概率确实需要 userDomainId）：请在面板「用户域 ID」里填 Cookie 的 ud_id',
      )
    }
    return {
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
    }
  }

  async function status() {
    const value = credential
    let account = null
    let expiresAt = null
    let quota = null
    let quotaError = null
    if (value?.authorization) {
      try {
        const info = decodeAuthorization(value.authorization)
        account = info.account
        expiresAt = info.expiration
        await ensureFresh()
      } catch (error) {
        quotaError = errorMessage(error)
      }
      if (!quotaError) {
        try {
          quota = await getQuota()
        } catch (error) {
          quotaError = errorMessage(error)
        }
      }
      try {
        await ensureHost()
      } catch {
        /* host 解析失败不影响状态展示 */
      }
    }
    return {
      ok: true,
      authorized: Boolean(value?.authorization),
      // 只给脱敏版：完整账号（手机号）不出这个接口，免得随手 F12 就能看到。
      accountMasked: maskAccount(account),
      expiresAt,
      userDomainId: value?.userDomainId ?? null,
      credentialPath: store.file,
      quota,
      quotaError,
      host,
      defaultDownloadDir: DEFAULT_DOWNLOAD_DIR,
      storageType: 'personal_new',
    }
  }

  async function authorize(authorization, userDomainId) {
    const cleaned = String(authorization ?? '').trim().replace(/^Basic\s+/i, '')
    if (!cleaned) throw new Error('Authorization 不能为空')
    const info = decodeAuthorization(cleaned)
    update({ authorization: cleaned, userDomainId: String(userDomainId ?? '').trim() })
    host = null
    await ensureHost()
    let quota = null
    let quotaError = null
    try {
      quota = await getQuota()
    } catch (error) {
      quotaError = errorMessage(error)
    }
    return { accountMasked: maskAccount(info.account), quota, quotaError }
  }

  return {
    status,
    authorize,
    forget,
    listFiles,
    getDownloadUrl,
    makeDir,
    renameNode,
    moveNodes,
    removeNodes,
    getQuota,
    startJob,
    getJob,
    listJobs,
    cancelJob,
    ensureFolder,
    uploadFile,
    uploadFolder,
    uploadFromTempPath,
    downloadFile,
    downloadFolder,
    isAuthorized: () => Boolean(credential?.authorization),
  }
}

// ------------------------------------------------------------------ 工具定义

const outputSpec = {
  schema: {
    type: 'object',
    properties: {
      content: { type: 'array', items: {} },
      structuredContent: {},
    },
    required: ['content'],
    additionalProperties: false,
  },
  render(_args, result) {
    return result.content.map((block) =>
      block.type === 'text' ? block : { type: 'text', text: `[移动云盘返回 ${block.type} 内容]` },
    )
  },
}

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function humanSize(bytes) {
  const n = Number(bytes) || 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${index === 0 ? value : value.toFixed(1)} ${units[index]}`
}

function toolDefinitions(client) {
  return [
    {
      name: TOOL_PREFIX + 'quota',
      description: '查询中国移动云盘（139）的容量使用情况：总量、已用、剩余。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const quota = await client.getQuota()
        if (!quota) {
          return textResult(
            '拿不到容量：当前凭据里没有 userDomainId(ud_id)。请在「移动云盘」面板补上 Cookie 里的 ud_id 再试。',
          )
        }
        return textResult(
          `总容量 ${humanSize(quota.totalBytes)}｜已用 ${humanSize(quota.usedBytes)}｜剩余 ${humanSize(quota.freeBytes)}`,
        )
      },
    },
    {
      name: TOOL_PREFIX + 'list',
      description:
        '列出中国移动云盘某个目录下的文件和文件夹。parentFileId 用 "/" 表示根目录，从结果里拿子目录的 id 继续深入。',
      parameters: {
        type: 'object',
        properties: {
          parentFileId: { type: 'string', description: '目录 ID，根目录为 "/"' },
          cursor: { type: 'string', description: '分页游标，首页留空' },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const page = await client.listFiles(args?.parentFileId || ROOT_ID, args?.cursor || '')
        if (!page.items.length) return textResult('这个目录是空的。')
        const lines = page.items.map((item) => {
          const kind = item.type === 'folder' ? '文件夹' : '文件'
          const size = item.type === 'folder' ? '' : ` ${humanSize(item.size)}`
          return `- [${kind}] ${item.name}${size} (id=${item.id})`
        })
        const more = page.nextCursor ? `\n\n还有下一页，cursor=${page.nextCursor}` : ''
        return textResult(`共 ${page.items.length} 项：\n${lines.join('\n')}${more}`)
      },
    },
    {
      name: TOOL_PREFIX + 'search',
      description: '在中国移动云盘里按文件名关键词搜索（会翻若干页目录，最多 10 页）。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '文件名关键词' },
          parentFileId: { type: 'string', description: '从哪个目录开始搜，默认根目录 "/"' },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
      async execute(args) {
        const keyword = String(args?.keyword ?? '').trim()
        if (!keyword) return textResult('请给出关键词。')
        const queue = [args?.parentFileId || ROOT_ID]
        const matches = []
        let pages = 0
        while (queue.length && pages < 10) {
          const current = queue.shift()
          let cursor = ''
          do {
            const page = await client.listFiles(current, cursor)
            pages += 1
            for (const item of page.items) {
              if (item.name.includes(keyword)) matches.push({ ...item, parent: current })
              if (item.type === 'folder') queue.push(item.id)
            }
            cursor = page.nextCursor || ''
          } while (cursor && pages < 10)
        }
        if (!matches.length) return textResult(`没找到文件名包含「${keyword}」的内容。`)
        const lines = matches.map(
          (item) => `- ${item.type === 'folder' ? '📁' : '📄'} ${item.name} (id=${item.id}, 在 ${item.parent})`,
        )
        return textResult(`找到 ${matches.length} 项：\n${lines.join('\n')}`)
      },
    },
    {
      name: TOOL_PREFIX + 'download_link',
      description: '拿到中国移动云盘里某个文件的下载直链（302/CDN 地址，有时效）。',
      parameters: {
        type: 'object',
        properties: { fileId: { type: 'string', description: '文件 ID' } },
        required: ['fileId'],
        additionalProperties: false,
      },
      async execute(args) {
        const url = await client.getDownloadUrl(String(args?.fileId ?? ''))
        return textResult(url)
      },
    },
    {
      name: TOOL_PREFIX + 'mkdir',
      description: '在中国移动云盘里新建文件夹。',
      parameters: {
        type: 'object',
        properties: {
          parentFileId: { type: 'string', description: '父目录 ID，根目录为 "/"' },
          name: { type: 'string', description: '新文件夹名字' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async execute(args) {
        const dirName = String(args?.name ?? '').trim()
        if (!dirName) return textResult('文件夹名不能为空。')
        await client.makeDir(args?.parentFileId || ROOT_ID, dirName)
        return textResult(`已创建文件夹「${dirName}」。`)
      },
    },
    {
      name: TOOL_PREFIX + 'rename',
      description: '重命名中国移动云盘里的文件或文件夹。',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件/文件夹 ID' },
          name: { type: 'string', description: '新名字' },
        },
        required: ['fileId', 'name'],
        additionalProperties: false,
      },
      async execute(args) {
        const nextName = String(args?.name ?? '').trim()
        if (!nextName) return textResult('新名字不能为空。')
        await client.renameNode(String(args?.fileId ?? ''), nextName)
        return textResult(`已改名为「${nextName}」。`)
      },
    },
    {
      name: TOOL_PREFIX + 'move',
      description: '把一个或多个文件/文件夹移动到另一个目录（移动前请先确认目标 ID）。',
      parameters: {
        type: 'object',
        properties: {
          fileIds: { type: 'array', items: { type: 'string' }, description: '要移动的 ID 列表' },
          toParentFileId: { type: 'string', description: '目标目录 ID，根目录为 "/"' },
        },
        required: ['fileIds', 'toParentFileId'],
        additionalProperties: false,
      },
      async execute(args) {
        const ids = Array.isArray(args?.fileIds) ? args.fileIds.map(String) : []
        if (!ids.length) return textResult('fileIds 不能为空。')
        await client.moveNodes(ids, args?.toParentFileId || ROOT_ID)
        return textResult(`已移动 ${ids.length} 项。`)
      },
    },
    {
      name: TOOL_PREFIX + 'remove',
      description: '把文件/文件夹移入移动云盘回收站（不是永久删除，可在回收站恢复）。',
      parameters: {
        type: 'object',
        properties: {
          fileIds: { type: 'array', items: { type: 'string' }, description: '要删除的 ID 列表' },
        },
        required: ['fileIds'],
        additionalProperties: false,
      },
      async execute(args) {
        const ids = Array.isArray(args?.fileIds) ? args.fileIds.map(String) : []
        if (!ids.length) return textResult('fileIds 不能为空。')
        await client.removeNodes(ids)
        return textResult(`已把 ${ids.length} 项移入回收站。`)
      },
    },
    {
      name: TOOL_PREFIX + 'upload',
      timeoutMs: 6 * 60 * 60 * 1000,
      description:
        '把一个本地文件上传到中国移动云盘（自动分片、支持秒传）。localPath 是运行 DSH 这台机器上的绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          localPath: { type: 'string', description: '本地文件绝对路径' },
          parentFileId: { type: 'string', description: '传到哪个目录，根目录为 "/"' },
          name: { type: 'string', description: '可选：上传后的文件名' },
        },
        required: ['localPath'],
        additionalProperties: false,
      },
      async execute(args) {
        const localPath = String(args?.localPath ?? '').trim()
        if (!localPath) return textResult('localPath 不能为空。')
        const job = client.startJob('upload', basename(localPath), (active) =>
          client.uploadFile(localPath, args?.parentFileId, args?.name, active),
        )
        const result = await job.promise
        return textResult(
          result.dedup
            ? `「${result.name}」命中秒传（网盘里已有完全相同的内容），没有真的传数据。`
            : `已上传「${result.name}」（${humanSize(result.size)}，${result.parts} 个分片）。`,
        )
      },
    },
    {
      name: TOOL_PREFIX + 'upload_folder',
      timeoutMs: 6 * 60 * 60 * 1000,
      description:
        '把一个本地文件夹整个上传到中国移动云盘，远端会按同样的目录结构建好（同名文件夹复用，不会重复创建）。',
      parameters: {
        type: 'object',
        properties: {
          localPath: { type: 'string', description: '本地文件夹绝对路径' },
          parentFileId: { type: 'string', description: '传到哪个目录，根目录为 "/"' },
        },
        required: ['localPath'],
        additionalProperties: false,
      },
      async execute(args) {
        const localPath = String(args?.localPath ?? '').trim()
        if (!localPath) return textResult('localPath 不能为空。')
        const job = client.startJob('upload-folder', basename(localPath), (active) =>
          client.uploadFolder(localPath, args?.parentFileId, active),
        )
        const result = await job.promise
        return textResult(
          `已把文件夹「${result.name}」上传到网盘（${result.files} 个文件，${humanSize(result.bytes)}）。`,
        )
      },
    },
    {
      name: TOOL_PREFIX + 'download',
      timeoutMs: 6 * 60 * 60 * 1000,
      description: '把移动云盘里的一个文件下载到本地磁盘（流式写入，先写临时文件再改名）。',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件 ID' },
          localPath: { type: 'string', description: '本地保存路径，要含文件名' },
        },
        required: ['fileId', 'localPath'],
        additionalProperties: false,
      },
      async execute(args) {
        const fileId = String(args?.fileId ?? '').trim()
        const localPath = String(args?.localPath ?? '').trim()
        if (!fileId || !localPath) return textResult('fileId 和 localPath 都不能为空。')
        const job = client.startJob('download', basename(localPath), (active) =>
          client.downloadFile(fileId, localPath, active),
        )
        const result = await job.promise
        return textResult(`已下载到 ${result.localPath}（${humanSize(result.bytes)}）。`)
      },
    },
    {
      name: TOOL_PREFIX + 'download_folder',
      timeoutMs: 6 * 60 * 60 * 1000,
      description:
        '递归下载整个文件夹到本地。移动云盘没有打包下载接口，这里是逐个文件下载、在本地还原目录结构，所以文件多会比较慢。',
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: '文件夹 ID' },
          localPath: { type: 'string', description: '本地保存目录' },
        },
        required: ['folderId', 'localPath'],
        additionalProperties: false,
      },
      async execute(args) {
        const folderId = String(args?.folderId ?? '').trim()
        const localPath = String(args?.localPath ?? '').trim()
        if (!folderId || !localPath) return textResult('folderId 和 localPath 都不能为空。')
        const job = client.startJob('download-folder', basename(localPath), (active) =>
          client.downloadFolder(folderId, localPath, active),
        )
        const result = await job.promise
        return textResult(
          `已把整个文件夹下载到 ${result.localDir}（${result.files} 个文件，${humanSize(result.bytes)}）。`,
        )
      },
    },
  ]
}

// ------------------------------------------------------------------ 路由

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolveBody) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolveBody({ invalid: true })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = chunks.length ? Buffer.concat(chunks).toString('utf8') : ''
      if (!text.trim()) return resolveBody({ value: {} })
      try {
        resolveBody({ value: JSON.parse(text) })
      } catch {
        resolveBody({ invalid: true })
      }
    })
    req.on('error', () => resolveBody({ invalid: true }))
  })
}

function createRoutes(client) {
  const base = '/api/dsh-mcloud'

  function guard(req, res) {
    if (!isLoopback(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      return false
    }
    return true
  }

  function guardWrite(req, res) {
    if (!guard(req, res)) return false
    if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return false
    }
    if (req.headers[WRITE_HEADER] !== '1') {
      writeJson(res, 403, { ok: false, error: 'missing plugin header' })
      return false
    }
    return true
  }

  async function post(req, res, run) {
    const body = await readJsonBody(req)
    if (body.invalid) return writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
    try {
      const result = await run(body.value ?? {})
      writeJson(res, result?.ok === false ? 400 : 200, { ok: true, ...(result ?? {}) })
    } catch (error) {
      writeJson(res, 400, { ok: false, error: errorMessage(error) })
    }
  }

  return [
    {
      kind: 'exact',
      path: `${base}/status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          writeJson(res, 200, await client.status())
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${base}/auth`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          if (typeof value.authorization !== 'string') {
            throw new Error('authorization 必须是字符串')
          }
          const result = await client.authorize(value.authorization, value.userDomainId ?? '')
          return { accountMasked: result.accountMasked, quota: result.quota, quotaError: result.quotaError }
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/auth/clear`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async () => {
          client.forget()
          return {}
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/list`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const parentFileId = url.searchParams.get('parentFileId') || ROOT_ID
          const cursor = url.searchParams.get('cursor') || ''
          const pageSize = url.searchParams.get('pageSize')
          // refresh=1 强制绕过缓存（「刷新」按钮和写操作之后用）
          const force = url.searchParams.get('refresh') === '1'
          const page = await client.listFiles(parentFileId, cursor, pageSize ?? LIST_PAGE_SIZE, { force })
          writeJson(res, 200, { ok: true, parentFileId, ...page })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: errorMessage(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${base}/link`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const url = await client.getDownloadUrl(String(value.fileId ?? ''))
          return { url }
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/mkdir`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const dirName = String(value.name ?? '').trim()
          if (!dirName) throw new Error('文件夹名不能为空')
          await client.makeDir(String(value.parentFileId || ROOT_ID), dirName)
          return {}
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/rename`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const nextName = String(value.name ?? '').trim()
          if (!nextName) throw new Error('新名字不能为空')
          await client.renameNode(String(value.fileId ?? ''), nextName)
          return {}
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/move`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const ids = Array.isArray(value.fileIds) ? value.fileIds.map(String) : []
          if (!ids.length) throw new Error('fileIds 不能为空')
          await client.moveNodes(ids, String(value.toParentFileId || ROOT_ID))
          return {}
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/remove`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const ids = Array.isArray(value.fileIds) ? value.fileIds.map(String) : []
          if (!ids.length) throw new Error('fileIds 不能为空')
          await client.removeNodes(ids)
          return {}
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/transfers`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const jobId = url.searchParams.get('jobId')
          if (jobId) {
            const job = client.getJob(jobId)
            if (!job) return writeJson(res, 404, { ok: false, error: 'job not found' })
            return writeJson(res, 200, { ok: true, job })
          }
          writeJson(res, 200, { ok: true, jobs: client.listJobs() })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${base}/upload`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const localPath = String(value.localPath ?? '').trim()
          if (!localPath) throw new Error('localPath 不能为空')
          // 先确认文件真在、能读，别等任务跑起来才报错
          const stats = statSync(localPath)
          if (!stats.isFile()) throw new Error(`不是一个文件：${localPath}`)
          const job = client.startJob('upload', String(value.name || basename(localPath)), (active) =>
            client.uploadFile(localPath, value.parentFileId, value.name, active),
          )
          job.total = stats.size
          return { jobId: job.id }
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/pick`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const mode = value.mode === 'folder' ? 'folder' : 'files'
          const paths = await pickLocalPaths(mode)
          return { paths, cancelled: paths.length === 0 }
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/upload-folder`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const localPath = String(value.localPath ?? '').trim()
          if (!localPath) throw new Error('localPath 不能为空')
          const stats = statSync(localPath)
          if (!stats.isDirectory()) throw new Error(`不是一个文件夹：${localPath}`)
          const job = client.startJob('upload-folder', basename(localPath), (active) =>
            client.uploadFolder(localPath, value.parentFileId, active),
          )
          return { jobId: job.id }
        })
      },
    },
    {
      // 拖拽上传：body 是文件原始字节，不是 JSON，所以不能走 post() 助手
      kind: 'exact',
      path: `${base}/upload-body`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (req.headers[WRITE_HEADER] !== '1') {
          writeJson(res, 403, { ok: false, error: 'missing plugin header' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const rawName = url.searchParams.get('name') || 'upload.bin'
        const name = basename(rawName).replace(/[\\/:*?"<>|]/g, '_') || 'upload.bin'
        const parentFileId = url.searchParams.get('parentFileId') || ROOT_ID
        const tempPath = join(tmpdir(), `dsh-mcloud-${randomUUID()}-${name}`)
        try {
          await pipeline(req, createWriteStream(tempPath))
        } catch (error) {
          rmSync(tempPath, { force: true })
          writeJson(res, 500, { ok: false, error: `接收上传数据失败：${errorMessage(error)}` })
          return
        }
        const job = client.startJob('upload', name, (active) =>
          client.uploadFromTempPath(tempPath, parentFileId, name, active),
        )
        writeJson(res, 200, { ok: true, jobId: job.id, name })
      },
    },
    {
      kind: 'exact',
      path: `${base}/download`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const fileId = String(value.fileId ?? '').trim()
          if (!fileId) throw new Error('fileId 不能为空')
          const localPath =
            String(value.localPath ?? '').trim() || join(DEFAULT_DOWNLOAD_DIR, fileId)
          const job = client.startJob('download', basename(localPath), (active) =>
            client.downloadFile(fileId, localPath, active),
          )
          return { jobId: job.id, localPath }
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/download-folder`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const folderId = String(value.folderId ?? '').trim()
          if (!folderId) throw new Error('folderId 不能为空')
          const localDir =
            String(value.localPath ?? '').trim() || join(DEFAULT_DOWNLOAD_DIR, folderId)
          const job = client.startJob('download-folder', basename(localDir), (active) =>
            client.downloadFolder(folderId, localDir, active),
          )
          return { jobId: job.id, localDir }
        })
      },
    },
    {
      // 「上传文件夹」走浏览器的 webkitdirectory 时，浏览器只给相对路径，
      // 所以要按相对路径逐层把远端目录建出来，再把文件塞进对应目录。
      kind: 'exact',
      path: `${base}/mkdir-path`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const parentFileId = String(value.parentFileId || ROOT_ID)
          const parts = String(value.path ?? '')
            .split(/[\\/]+/)
            .map((part) => part.trim())
            .filter((part) => part && part !== '.' && part !== '..')
          if (!parts.length) throw new Error('path 不能为空')
          let current = parentFileId
          for (const part of parts) {
            current = await client.ensureFolder(current, part)
          }
          return { fileId: current }
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/transfer/cancel`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const cancelled = client.cancelJob(String(value.jobId ?? ''))
          return { cancelled }
        })
      },
    },
  ]
}

// ------------------------------------------------------------------ apply

export function apply(ctx, rawConfig) {
  const config = unwrapConfig(rawConfig)
  const credentialDir = typeof config.credentialDir === 'string' && config.credentialDir
    ? resolve(config.credentialDir)
    : DEFAULT_CREDENTIAL_DIR

  // 用户自己指定了目录就不用回落；否则允许读旧版本留下的凭据。
  const legacyDirs = typeof config.credentialDir === 'string' && config.credentialDir
    ? []
    : LEGACY_CREDENTIAL_DIRS

  let store
  try {
    store = createCredentialStore(credentialDir, legacyDirs)
  } catch (error) {
    ctx.logger?.warn?.(`mcloud: 凭据目录不可用（${errorMessage(error)}）`)
    store = createCredentialStore(DEFAULT_CREDENTIAL_DIR, legacyDirs)
  }

  const client = createClient(store, ctx.logger, config)

  // ---- 工具
  try {
    const disposers = []
    for (const definition of toolDefinitions(client)) {
      try {
        const dispose = ctx.tools.register({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          output: outputSpec,
          timeoutMs: definition.timeoutMs ?? 60_000,
          execute: (args, execution) => definition.execute(args ?? {}, execution),
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        ctx.logger?.warn?.(`mobile-cloud: 工具 ${definition.name} 注册失败（${errorMessage(error)}）`)
      }
    }
    ctx.effect(
      () => () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch {
            /* 已经卸过了 */
          }
        }
      },
      'dsh-mcloud: tools',
    )

    // 写入类工具一律走审批（跟百度网盘插件同一套闸）
    if (config.enableWrites !== false) {
      ctx.on('tools/pre-execute', async (execution, next) => {
        const decision = await next()
        if (decision?.kind === 'allow' && WRITE_TOOL_NAMES.has(execution?.name)) {
          return { kind: 'ask', reason: '这是移动云盘上会改动内容的操作，确认一下再执行。' }
        }
        return decision
      })
    }
  } catch (error) {
    ctx.logger?.warn?.(`mobile-cloud: 工具注册整体失败（${errorMessage(error)}）`)
  }

  // ---- HTTP 路由
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const routes = createRoutes(client)
      const disposers = routes.map((route) => webCtx.webServer.register(route))
      webCtx.effect(
        () => () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* 已经卸过了 */
            }
          }
        },
        'dsh-mcloud: routes',
      )
    })
  } catch (error) {
    ctx.logger?.warn?.(`mobile-cloud: 路由注册失败（${errorMessage(error)}）`)
  }
}

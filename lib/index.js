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
  existsSync,
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
import { loginWithPassword } from './login.js'
import { scanLogin } from './scan-login.js'
import { requestRejection } from './request-guard.js'

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
 *
 * ⚠️ 这里的数据修正过一次。早期测出来的结论是「pageSize 越大越慢，几乎二次方恶化」
 * （10 → 1.3s，100 → 25s），于是定成了 10。但后来在真实的大目录
 * （手机图片，几百上千张）上重测，结果完全不同：
 *
 *   pageSize= 10 →  218 ms   每 100 项约 2180 ms
 *   pageSize= 30 →  248 ms   每 100 项约  827 ms
 *   pageSize= 50 →  296 ms   每 100 项约  592 ms
 *   pageSize=100 →  451 ms   每 100 项约  451 ms
 *
 * 也就是说：**瓶颈是每次请求的固定开销，不是条目数**。
 * 一次多拿几十条几乎不要钱，但每页只拿 10 条就要多跑好几倍的往返。
 *
 * 取 50：相比 10 把「单位成本」降到 1/3.7，同时给单次响应留了余量
 * （某些目录条目体积大时，100 档的尾部延迟会更明显）。
 */
const LIST_PAGE_SIZE = 50

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

/**
 * 传输记录持久化文件（0.4.0）。
 *
 * 用户要求「传输记录永不删除」，所以记录必须落盘，不能只活在内存里 ——
 * 否则 DSH 一重启、插件一重载，历史就全没了。
 *
 * 跟凭据同目录（~/.dsh-mcloud/），那里本来就只有本机当前用户能读，
 * 而且已经排除在发布产物之外（见 .gitignore）。
 *
 * ⚠️ 这个文件里**有本机绝对路径**（下载落点，用来「在资源管理器里定位」）。
 * 它只在宿主侧读写，绝不经过 HTTP 返回给浏览器 —— 接口只回布尔 canRevealLocal。
 */
const TRANSFERS_FILE_NAME = 'transfers.json'
/** 记录格式版本：以后字段变了可以据此迁移，不用猜。 */
const TRANSFERS_VERSION = 1
/** 单条记录保留的字段（写盘时用这个白名单，别把 AbortController 之类抄进去）。 */
const TRANSFER_PERSIST_FIELDS = [
  'id',
  'kind',
  'label',
  'phase',
  'done',
  'total',
  'state',
  'error',
  'startedAt',
  'finishedAt',
  'currentFile',
  'fileCount',
  'dedup',
  // 定位线索
  'localPath',
  'parentFileId',
  'parentPath',
  'fileId',
  'name',
]

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

/**
 * 清洗「上传目标目录的展示路径」。
 *
 * 只用来给「传输记录 → 定位」时的面包屑提供一级名字，所以：
 *   · 去掉控制字符和 Windows 非法字符；
 *   · 统一成 `/a/b` 的形状；
 *   · 太长就截断（防止有人塞一整个字符串进来撑爆界面）。
 * 绝不当成真实路径使用 —— 网盘一切按 fileId 定位。
 */
function cleanParentPath(value) {
  if (typeof value !== 'string') return null
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '/')
    .trim()
  if (!text) return null
  const normalized = ('/' + text.replace(/^\/+/, '')).replace(/\/{2,}/g, '/').slice(0, 300)
  return normalized === '/' ? null : normalized
}

/**
 * 路径穿越防护（0.5.2）。
 *
 * 云端返回的文件名是**外部数据**，`String(item.name ?? '')` 原样用进
 * `join(prefix, name)` 之后，`../../evil.txt`、`..\\..\\evil.txt`、
 * `/tmp/evil.txt`、`C:\\Windows\\evil.txt`、`\\\\server\\share\\evil.txt`
 * 都能把「文件夹下载 → 逐个文件回落」写到目标目录之外。
 *
 * 服务端大概率会拦斜杠，但代码层不能依赖它 —— 所以这里做两道：
 *
 *   isInside(baseDir, target)  纯判断：resolve 之后必须仍在 baseDir 里
 *   safeJoin(baseDir, relative) 拼路径 + 校验，越界返回 null（调用方记为失败）
 *
 * 细节：
 *   · `path.resolve` 会把 `..`、`.`、重复分隔符、末尾斜杠全归一；
 *   · 判断用 `resolved.startsWith(root + sep)`，**必须是 root + 分隔符**前缀，
 *     否则 `/a/bc` 会被误判成 `/a/b` 里面；
 *   · Windows 上盘符 / UNC 也是 resolve 的一部分，`C:\Windows\x` 在
 *     `D:\dl` 里 resolve 出来直接就是 `C:\Windows\x`，前缀对不上；
 *   · 大小写：Windows 文件系统不区分大小写，比较前统一转小写。
 */
function isInside(baseDir, target) {
  const root = resolve(String(baseDir))
  const full = resolve(String(target))
  const sep = process.platform === 'win32' ? '\\' : '/'
  const a = process.platform === 'win32' ? root.toLowerCase() : root
  const b = process.platform === 'win32' ? full.toLowerCase() : full
  if (a === b) return true
  return b.startsWith(a.endsWith(sep) ? a : a + sep)
}

/**
 * 把「相对路径」安全地拼到 baseDir 下。
 *
 * 越界（含 `..`、绝对路径、盘符、UNC、或者名字里有分隔符爬到上级）一律返回 null，
 * 由调用方记成一条失败并继续下别的文件 —— **绝不静默改名**，也绝不写到外面。
 */
function safeJoin(baseDir, relative) {
  const base = String(baseDir ?? '')
  if (!base) return null
  // 空相对路径 = baseDir 自己
  const rel = relative === undefined || relative === null ? '' : String(relative)
  if (rel === '') return resolve(base)
  // 先粗略挡掉明显越界的形态（resolve 也能挡，但这里能给出更早的判断）
  // 分隔符归一后再看有没有 `..` 段；绝对路径 / 盘符 / UNC 交给 isInside 兜底。
  const normalized = rel.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '..') return null
  }
  const full = resolve(base, rel)
  if (!isInside(base, full)) return null
  return full
}

/**
 * 把云端给的名字摘成**纯文件名**（0.5.2）。
 *
 * 只去掉路径成分，不做「越界判定」—— 那是 safeJoin 的活。这里处理：
 *   · 任何目录分隔符之后的部分（`a/b`、`a\\b` → `b`）
 *   · 前导的点（`..`、`.hidden` 里的 `..` 段）
 *   · Windows 盘符 / UNC 前缀
 *   · 控制字符与 Windows 非法字符 `<>:"|?*`
 * 结果为空就用 fallback。
 */
function safeFileName(value, fallback = 'download') {
  let text = String(value ?? '')
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]/g, '')
  text = text.replace(/[<>:"|?*]/g, '_')
  text = text.replace(/\\/g, '/')
  const parts = text.split('/')
  text = parts[parts.length - 1] || ''
  // 去掉纯点名的残留（`.` / `..`）
  if (/^\.+$/.test(text)) text = ''
  text = text.trim()
  return text || fallback
}

/**
 * 「相对路径」的越界过滤（0.5.2）。
 *
 * 用来处理云端目录项的**名字**：名字里带路径分隔符、绝对路径、盘符、UNC，
 * 或者拼起来爬到上级（`..`）的，一律返回 null —— 调用方记成失败并跳过。
 *
 * 做法是拿一个假根把拼好的相对路径 resolve 一遍，再切回相对形式：
 * 这样不用手写「几段 ..」的判断，交给 path.resolve 归一更可靠。
 */
const COLLECT_ROOT = process.platform === 'win32' ? 'C:\\__mcloud_collect_root__' : '/__mcloud_collect_root__'

function safeRelativeName(parentRelative, rawName) {
  const name = typeof rawName === 'string' ? rawName : String(rawName ?? '')
  if (name === '') return null
  const normalizedName = name.replace(/\\/g, '/')
  // 绝对路径 / 盘符 / UNC 一律不接受
  if (normalizedName.startsWith('/') || /^[A-Za-z]:/.test(normalizedName)) return null
  const parent = typeof parentRelative === 'string' ? parentRelative.replace(/\\/g, '/') : ''
  const next = parent ? parent + '/' + normalizedName : normalizedName
  const joined = safeJoin(COLLECT_ROOT, next)
  if (joined === null) return null
  const rootResolved = resolve(COLLECT_ROOT)
  const sep = process.platform === 'win32' ? '\\' : '/'
  if (joined === rootResolved) return ''
  const prefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep
  if (!joined.startsWith(prefix)) return null
  return joined.slice(prefix.length).replace(/\\/g, '/')
}

/**
 * explorer.exe 定位参数的**边界校验**（0.5.2）。
 *
 * 0.4.4 为了处理带空格的路径，改成了 `windowsVerbatimArguments: true` +
 * 自己加双引号。verbatim 模式下 Node **完全不做转义**，引号就是唯一的边界 ——
 * 所以路径里一旦出现 `"`，就能闭合引号、往 explorer 的命令行里多塞参数。
 *
 * Windows 文件名本身禁止 `"`，真实路径不可能带它；这里不做「转义 / 双写""
 * 这种绕法，**直接拒绝**是最稳的。顺带也拒掉换行和控制字符 ——
 * 它们在命令行里同样是边界破坏者。
 */
function assertLocatablePath(value) {
  const text = String(value ?? '')
  if (text === '') throw new Error('没有可定位的本机路径')
  if (text.includes('"')) {
    throw new Error('路径里含有双引号，无法安全地交给资源管理器')
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error('路径里含有换行或控制字符，无法安全地交给资源管理器')
  }
  return text
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
  // 认证/授权类错误：重试一百次也没用，必须让用户重新登录
  if (/认证失败|暂无权限|授权已过期|还没有授权|不是合法|结构不对|参数不合法|不存在|没有权限|已取消|登录失败/.test(message)) {
    return true
  }
  return false
}

/**
 * 账号脱敏。移动云盘这边没有能查昵称的接口（试过 /user/info 等，全是「资源不存在」），
 * 而 Authorization 里带的账号就是一个手机号，所以面板默认只显示脱敏串。
 *
 * 0.5.2：按用户要求改成**只保留后四位**（`********1234`）。
 * 以前是「前 3 后 2」（形如 `138******00`），但前 3 位能定位到号段，
 * 用户明确要求「手机号只显示后四位」，这里就只留后四位。
 * ⚠️ 脱敏必须做在**服务端返回的这一层**，界面隐藏不算数（F12 就能看到）。
 */
function maskAccount(value) {
  if (!value) return null
  const text = String(value)
  // 手机号：只露后 4 位，前面全部隐藏
  if (/^\d{11}$/.test(text)) {
    return `${'*'.repeat(text.length - 4)}${text.slice(-4)}`
  }
  if (text.includes('@')) {
    const at = text.indexOf('@')
    const name = text.slice(0, at)
    const domain = text.slice(at)
    const head = name.slice(0, Math.min(2, name.length))
    return `${head}${'*'.repeat(Math.max(1, name.length - head.length))}${domain}`
  }
  if (text.length <= 5) return '*'.repeat(text.length)
  return `${'*'.repeat(text.length - 4)}${text.slice(-4)}`
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
        // 只有用户主动勾选「保存密码」时才有；明文密码同样走 DPAPI 加密落盘
        savedAccount: typeof parsed.savedAccount === 'string' ? parsed.savedAccount : '',
        savedPassword: typeof parsed.savedPassword === 'string' ? parsed.savedPassword : '',
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
 * 选「下载目录」专用的对话框。
 *
 * 和上传那个分开：文案不同，而且这里允许「新建文件夹」——
 * 用户选下载目录时往往是想就地建一个，不给这个按钮反而别扭。
 */
const PICKER_DOWNLOAD_DIR = `${PICKER_PRELUDE}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '选择文件下载到本地的目录'
$d.ShowNewFolderButton = $true
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
  const script =
    mode === 'download-dir' ? PICKER_DOWNLOAD_DIR : mode === 'folder' ? PICKER_FOLDER : PICKER_FILES
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

// ------------------------------------------------------------------ 本机定位

/**
 * 在系统文件管理器里定位一个本机路径（「传输记录 → 定位」用）。
 *
 * 🔴 0.4.4 修的就是这里 —— 用户报「下载定位无效 / 点定位打不开文件资源管理器」。
 *
 * 老写法是 `spawn('explorer.exe', ['/select,' + p])`，**默认 quoted 模式**。
 * Node 在 Windows 上拼命令行时会把「含空格」的每个参数再包一层引号，
 * 于是 `/select,C:\a b\x.txt` 变成 `"/select,C:\a b\x.txt"` ——
 * explorer 看到的是「一个带引号的斜杠命令」，认不出来，就退化成打开「文档」。
 * 也就是说：**只要路径里有一个空格，定位就失效**，而下载目录名/文件名太常见了。
 *
 * 实测（真实 explorer.exe，用窗口标题判断落在哪个目录）：
 *
 *   | 写法                                              | 带空格的路径 |
 *   | ---                                               | ---          |
 *   | `[ '/select,' + p ]`（默认 quoting，老代码）        | ❌ 打开「文档」 |
 *   | `[ '/select,', p ]`（两个参数，默认 quoting）        | ✅          |
 *   | `[ '/select,' + p ]` + windowsVerbatimArguments    | ✅          |
 *   | `[ '/select,"' + p + '"' ]` + windowsVerbatimArguments | ✅ 最稳 |
 *
 * 现在统一用**verbatim + 自己加引号**：命令行长什么样完全由我们决定，
 * 不依赖 Node 的 quoting 规则，空格 / 逗号 / 中文 / `&` 都验证过。
 *
 * 🔴 0.5.2：verbatim 模式下 Node **不做任何转义**，引号就是唯一边界，
 * 所以 `value` 里出现 `"` 就能闭合引号往命令行里塞参数。这里在拼之前
 * 调 assertLocatablePath() 直接拒绝（Windows 文件名禁 `"`，不需要绕）。
 *
 * 目录（下载文件夹任务）就只打开目录本身，不做 /select。
 * 路径不存在时当作失败抛出去，让界面报「文件可能已被移动」。
 */
function explorerLocateArgs(value, isDirectory) {
  // 双引号 / 控制字符会破坏 verbatim 命令行边界 —— 直接拒绝，不做转义。
  const safe = assertLocatablePath(value)
  const quoted = `"${safe}"`
  return {
    args: isDirectory ? [quoted] : [`/select,${quoted}`],
    options: { windowsVerbatimArguments: true },
  }
}

function revealLocalPath(target) {
  const value = typeof target === 'string' ? target.trim() : ''
  if (!value) throw new Error('没有可定位的本机路径')
  // ⚠️ 先校验命令行边界，再碰文件系统：含 " 或控制字符的路径直接拒绝，
  // 绝不走到 spawn（explorerLocateArgs 里还有一道，两处都兜着）。
  assertLocatablePath(value)
  if (!existsSync(value)) throw new Error(`本机上找不到这个路径：${value}`)

  let isDirectory = false
  try {
    isDirectory = statSync(value).isDirectory()
  } catch (error) {
    throw new Error(`读取路径失败：${errorMessage(error)}`)
  }

  if (!windows) {
    throw new Error('本地文件定位目前只支持 Windows')
  }

  // 用 spawn 而不是 spawnSync：explorer 自己会立刻返回，不用等它寿终正寝。
  const { args, options } = explorerLocateArgs(value, isDirectory)
  try {
    const child = spawn('explorer.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      ...options,
    })
    child.on('error', () => {
      /* 界面拿不到这个回调，错误记录在下面 try 之外也不影响主流程 */
    })
    child.unref()
  } catch (error) {
    throw new Error(`打开资源管理器失败：${errorMessage(error)}`)
  }
  return { path: value, isDirectory }
}

// ------------------------------------------------------------------ 网盘路径反查

/**
 * 按 fileId 反查它在网盘里的**完整路径**（0.4.5 第 1 条）。
 *
 * 为什么需要它：上传记录只记了 `parentFileId`，而 `parentPath` 在很多记录里是 null
 * （老记录 / 拖拽上传 / 服务端没回名字）。界面拿不到层级名就只能退回根目录 ——
 * 照片明明在 `/Windows/实验/.../第一周实验结果` 里，点「定位」却跳回 `/`，
 * 用户看到的就是「传输记录里定位不到上传的图片」。
 *
 * 网盘**没有**「按 id 反查路径」的接口（试过 `/file/getPath`、`/file/path`，
 * 全是「资源不存在」），所以只能自己从根往下找：
 *
 *   · BFS 逐层展开，一层的目录并发地问（默认 8 个一批）；
 *   · 每一层都检查「目标 id 是不是当前目录的子项」，是就立刻返回整条 trail；
 *   · 限制深度（默认 6 层）和目录数，网络抖动时也只是「查不到」，不会卡死。
 *
 * 🔴 trail **包含目标这一级**。调用方传的是 `parentFileId`（文件所在的目录），
 * 它要的路径末级就是那个目录本身。早先漏掉自己那一级，界面就会少铺一层、
 * 又掉回上一级 —— 那正是「定位不到」的症状。
 *
 * 返回 `{ path: '/Windows/实验/第一周实验结果', trail: [{ id, name }, ...] }` 或 `null`。
 * 提取成顶层纯函数是为了能单测（不用造一套凭据去测 BFS）。
 */
async function resolveRemotePathBfs(targetFileId, options = {}) {
  const wanted = String(targetFileId ?? '').trim()
  if (!wanted || wanted === ROOT_ID) return null
  const lister = typeof options.listFiles === 'function' ? options.listFiles : null
  if (!lister) return null

  const pageSize = Math.max(1, Math.min(200, Number(options.pageSize) || LIST_PAGE_SIZE))
  const maxDepth = Math.max(1, Math.min(12, Number(options.maxDepth) || 6))
  const concurrency = Math.max(1, Math.min(16, Number(options.concurrency) || 8))

  /** 列出某个目录下的全部子项（自动翻页，最多 6 页防打转）。 */
  async function childrenOf(parentId) {
    const out = []
    let cursor = ''
    let pages = 0
    do {
      const page = await lister(parentId, cursor, pageSize, { force: true })
      const items = page && Array.isArray(page.items) ? page.items : []
      for (const item of items) out.push(item)
      cursor = (page && page.nextCursor) || ''
      pages += 1
    } while (cursor && pages < 6)
    return out
  }

  let frontier = [{ id: ROOT_ID, trail: [] }]
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next = []
    for (let start = 0; start < frontier.length; start += concurrency) {
      const slice = frontier.slice(start, start + concurrency)
      const results = await Promise.all(slice.map(async (node) => {
        try {
          return { node, kids: await childrenOf(node.id) }
        } catch {
          return { node, kids: [] }
        }
      }))
      for (const { node, kids } of results) {
        for (const kid of kids) {
          const trail = node.trail.concat([{ id: kid.id, name: kid.name }])
          if (kid.id === wanted) {
            return { path: '/' + trail.map((entry) => entry.name).join('/'), trail }
          }
          if (kid.type === 'folder') next.push({ id: kid.id, trail })
        }
      }
    }
    if (!next.length) break
    frontier = next
  }
  return null
}

// 给测试用：只导出纯函数，不导出任何凭据/客户端。
export const __test = {
  cleanParentPath,
  explorerLocateArgs,
  resolveRemotePathBfs,
  // 0.5.2 安全加固：路径穿越 + 命令行边界
  safeJoin,
  isInside,
  safeFileName,
  safeRelativeName,
  assertLocatablePath,
  COLLECT_ROOT,
  maskAccount,
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
      throw new Error('还没有登录。请打开「移动云盘」面板，用扫码或账号密码登录。')
    }
    return credential
  }

  /** 令牌快到期（<15 天）就换新的，跟 OpenList 一个判断 */
  async function ensureFresh() {
    const value = assertAuthorized()
    const info = decodeAuthorization(value.authorization)
    if (info.expiration !== null) {
      const remaining = info.expiration - Date.now()
      if (remaining < 0) throw new Error('登录已过期，请重新登录')
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

  /**
   * 传输任务表（内存）。
   *
   * 0.4.0 起它不再只是「最近半小时的临时状态」：
   *   · 记录**永不自动删除**（用户明确要求）；
   *   · 每次状态变化都落盘到 ~/.dsh-mcloud/transfers.json，
   *     DSH 重启后历史还在；
   *   · 「清空记录」路由已经去掉 —— 界面上只留「打开记录所在目录」。
   */
  const jobs = new Map()

  /** 落盘用的文件路径。凭据目录可配置，所以这里跟着 store.file 走。 */
  const transfersFile = typeof store?.file === 'string' && store.file
    ? join(dirname(store.file), TRANSFERS_FILE_NAME)
    : join(DEFAULT_CREDENTIAL_DIR, TRANSFERS_FILE_NAME)

  /** 节流：任务跑的时候进度回调很密，不能每个字节都写一次盘。 */
  let persistTimer = null
  let persistAt = 0
  const PERSIST_MIN_INTERVAL_MS = 1500

  function persistSnapshotOf(job) {
    const row = {}
    for (const field of TRANSFER_PERSIST_FIELDS) {
      const value = job[field]
      row[field] = value === undefined ? null : value
    }
    return row
  }

  /** 真正写盘：先写临时文件再改名，中途崩了也不会留下半个 JSON。 */
  function writeTransfersFile() {
    try {
      const rows = [...jobs.values()]
        .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
        .map(persistSnapshotOf)
      const payload = {
        version: TRANSFERS_VERSION,
        savedAt: Date.now(),
        transfers: rows,
      }
      const text = JSON.stringify(payload)
      const temporary = `${transfersFile}.tmp-${randomUUID().slice(0, 8)}`
      writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, transfersFile)
    } catch (error) {
      // 落盘失败不该影响传输本身：记录还在内存里，用户这次仍看得见。
      logger?.warn?.(`mobile-cloud: 传输记录写盘失败（${errorMessage(error)}）`)
    }
  }

  /**
   * 请求落盘。
   *
   * 任务结束时立刻写（final=true），跑的过程中最多每 1.5 秒写一次 ——
   * 大文件传输时进度回调一秒几十次，不节流会把磁盘写爆。
   */
  function schedulePersist(final = false) {
    if (final) {
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      persistAt = Date.now()
      writeTransfersFile()
      return
    }
    const now = Date.now()
    const wait = Math.max(0, PERSIST_MIN_INTERVAL_MS - (now - persistAt))
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistAt = Date.now()
      writeTransfersFile()
    }, wait)
  }

  /**
   * 启动时把历史记录读回来。
   *
   * ⚠️ 读回来的记录里可能有 `state: 'running'` —— 那是上次 DSH 退出时正在传的任务，
   * 现在它肯定已经死了。必须把它们标成 error（「上次退出时中断」），
   * 否则界面上会永远挂着一条「传输中」的假记录，还会让轮询空转。
   */
  function loadPersistedTransfers() {
    let raw
    try {
      raw = readFileSync(transfersFile, 'utf8')
    } catch {
      return // 第一次跑，没有文件，正常
    }
    let doc
    try {
      doc = JSON.parse(raw)
    } catch (error) {
      logger?.warn?.(`mobile-cloud: 传输记录文件损坏，已忽略（${errorMessage(error)}）`)
      return
    }
    const rows = Array.isArray(doc?.transfers) ? doc.transfers : Array.isArray(doc) ? doc : []
    let recovered = 0
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !row.id) continue
      const job = {
        id: String(row.id),
        kind: String(row.kind ?? 'download'),
        label: String(row.label ?? ''),
        phase: String(row.phase ?? 'complete'),
        done: Number(row.done) || 0,
        total: Number(row.total) || 0,
        state: String(row.state ?? 'done'),
        error: row.error ?? null,
        result: null,
        startedAt: Number(row.startedAt) || Date.now(),
        finishedAt: Number(row.finishedAt) || Number(row.startedAt) || Date.now(),
        currentFile: row.currentFile ?? null,
        fileCount: row.fileCount ?? null,
        dedup: row.dedup === true,
        localPath: typeof row.localPath === 'string' && row.localPath ? row.localPath : null,
        parentFileId:
          row.parentFileId === undefined || row.parentFileId === null || row.parentFileId === ''
            ? null
            : String(row.parentFileId),
        parentPath: typeof row.parentPath === 'string' && row.parentPath ? row.parentPath : null,
        fileId: typeof row.fileId === 'string' && row.fileId ? row.fileId : null,
        name: typeof row.name === 'string' && row.name ? row.name : null,
        controller: null,
        signal: null,
      }
      if (job.state === 'running') {
        job.state = 'error'
        job.error = '上次退出 DSH 时这个任务还没跑完，已经被中断。'
        recovered += 1
      }
      jobs.set(job.id, job)
    }
    if (recovered > 0) schedulePersist(true)
    if (jobs.size) logger?.info?.(`mobile-cloud: 已恢复 ${jobs.size} 条传输记录`)
  }

  loadPersistedTransfers()

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
      // 0.3.5 「传输记录 → 定位」要用：
      //   · 下载任务记本机落点，好在资源管理器里选中它；
      //   · 上传任务记远端父目录 id + 展示用路径，好让面板跳过去。
      //
      // ⚠️ **localPath 不出这个接口**。它是本机绝对路径，带 Windows 用户名
      // （C:\Users\<名字>\Downloads\...），没有理由发给浏览器 —— 界面点「定位」时
      // 只发 jobId，由宿主自己去任务表里取真实路径。
      //
      // 0.4.0：这个布尔现在**真是查了一遍文件在不在**（用户要求「文件移动了位置
      // 就显示无法定位」）。以前只看「有没有记下 localPath」，于是文件早被移走/删掉，
      // 界面上那个「定位」按钮照样亮着，点了才报错。existsSync 很快（同步 stat），
      // 每条记录一次，分页 30 条也就 30 次 stat，可以接受。
      canRevealLocal: Boolean(job.localPath) && existsSync(job.localPath),
      /**
       * 「这条记录当初有没有记下本机落点」—— 只回布尔，不回路径。
       *
       * 有了它，界面才能把两种情况分开：
       *   · hasLocalPath=false        → 老记录，压根没位置，**不显示**「定位」按钮；
       *   · hasLocalPath=true 但
       *     canRevealLocal=false      → 记过位置、但文件已经被移走/删掉 →
       *                                 **仍然显示**按钮，点它明确告诉用户「无法定位」。
       *
       * 用户原话：「如果用户下载和上传的文件移动了位置那就显示无法定位」——
       * 要的是**看得见这个结论**，而不是按钮凭空消失让人以为坏了。
       */
      hasLocalPath: Boolean(job.localPath),
      parentFileId: job.parentFileId ?? null,
      parentPath: job.parentPath ?? null,
      // 0.4.0：上传记录的「定位」要知道它到底传成了哪个文件，
      // 才能在网盘里复核「这个文件还在不在原来的位置」。
      fileId: job.fileId ?? null,
      name: job.name ?? null,
      dedup: job.dedup === true,
    }
  }

  /**
   * 起一个后台传输任务。job.promise 给工具用（可以 await 到结束）。
   *
   * meta 是「这条记录以后怎么被定位到」的线索：
   *   { localPath }    下载落点（本机路径）
   *   { parentFileId } 上传目标目录（网盘 fileId）
   */
  function startJob(kind, label, runner, meta) {
    const extra = meta && typeof meta === 'object' ? meta : {}
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
      localPath: typeof extra.localPath === 'string' && extra.localPath ? extra.localPath : null,
      parentFileId:
        extra.parentFileId === undefined || extra.parentFileId === null || extra.parentFileId === ''
          ? null
          : String(extra.parentFileId),
      // 展示用的目录路径（例如 /windows/实验），只用来给面包屑当一级名字。
      parentPath: typeof extra.parentPath === 'string' && extra.parentPath ? extra.parentPath : null,
    }
    job.signal = job.controller.signal
    jobs.set(job.id, job)
    schedulePersist(true)

    job.promise = (async () => {
      try {
        const result = await runner(job)
        job.state = 'done'
        job.result = result
        // 把「这条记录以后怎么被定位」的结论也留下来：
        //   · 上传：远端 fileId / 最终文件名（用来判断它还在不在原地）
        //   · 下载：本机落点已经在 localPath 里
        if (result && typeof result === 'object') {
          if (typeof result.fileId === 'string' && result.fileId) job.fileId = result.fileId
          if (typeof result.name === 'string' && result.name) job.name = result.name
          if (result.dedup === true) job.dedup = true
          // 文件夹下载：把顶层落点记成目录（定位时直接打开它）
          if (typeof result.rootId === 'string' && result.rootId) job.fileId = result.rootId
          if (typeof result.localDir === 'string' && result.localDir) job.localPath = result.localDir
        }
        return result
      } catch (error) {
        job.state = 'error'
        job.error = errorMessage(error)
        throw error
      } finally {
        job.finishedAt = Date.now()
        job.currentFile = null
        schedulePersist(true)
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

  /**
   * 取一条任务记下的本机落点（**只在宿主内部用**，绝不经过 HTTP）。
   *
   * 🔴 0.4.4 修的就是这里 —— 用户报「下载定位无效」的**主因**。
   *
   * `/reveal` 原来是这么写的：
   *
   *     const found = client.getJob(id)          // ← getJob 返回 snapshot()
   *     target = String(found.localPath ?? '')   // ← snapshot 里**故意没有** localPath
   *     if (!target) throw new Error('这条记录没有记下本机位置')
   *
   * 而 snapshot 为了不把本机绝对路径发给浏览器，是**不含 localPath** 的
   * （见 snapshot 里那段注释）。于是 target 永远是空串，
   * 每一次「定位」都必抛「这条记录没有记下本机位置」——
   * 看起来就像「定位完全没反应 / 无效」，而且跟文件在不在、路径有没有空格都无关。
   *
   * 所以这里单独开一个宿主内部用的取值函数：路径不出接口，只在这个函数和
   * revealLocalPath 之间传递。`/transfers` 返回的仍然是不含路径的 snapshot。
   */
  function getJobLocalTarget(id) {
    const job = jobs.get(String(id ?? ''))
    if (!job) return null
    const value = typeof job.localPath === 'string' ? job.localPath.trim() : ''
    if (!value) return null
    return { localPath: value, kind: jobFamily(job.kind) }
  }

  /** 任务表按 kind 分类：'upload' 家族 / 'download' 家族。 */
  function jobFamily(kind) {
    const value = String(kind ?? '')
    if (value.startsWith('upload')) return 'upload'
    if (value.startsWith('download')) return 'download'
    return 'other'
  }

  /**
   * 列传输记录（0.4.0：永不删除 + 支持按上传/下载分页）。
   *
   * params:
   *   family  'upload' | 'download' | ''（全部）
   *   offset  跳过多少条（按 startedAt 倒序后）
   *   limit   取多少条，默认 50，上限 200
   *
   * 返回里带 total，界面据此显示「共 N 条」并能翻页。
   */
  function listJobs(params = {}) {
    const family = params.family === 'upload' || params.family === 'download' ? params.family : ''
    const limitRaw = Number(params.limit)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 50
    const offsetRaw = Number(params.offset)
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.trunc(offsetRaw) : 0

    let rows = [...jobs.values()].sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
    if (family) rows = rows.filter((job) => jobFamily(job.kind) === family)
    const total = rows.length
    const page = rows.slice(offset, offset + limit)
    return { jobs: page.map(snapshot), total, offset, limit, family }
  }

  /** 运行中的任务条数（界面上的小红点 / 顶部摘要用）。 */
  function runningJobCount() {
    let count = 0
    for (const job of jobs.values()) {
      if (job.state === 'running') count += 1
    }
    return count
  }

  function cancelJob(id) {
    const job = jobs.get(id)
    if (!job || job.state !== 'running') return false
    job.controller?.abort()
    return true
  }

  /**
   * 删掉**一条传输记录**（0.4.7）。
   *
   * 🔴 用户说得很明确：「注意删除的不是文件，而是记录」。
   *
   * 所以这里只从内存任务表里摘掉那一条、然后重写 transfers.json，
   * **绝不碰**网盘上的文件、也不碰本机下载下来的文件。
   * 这两件事在这份代码里从来没有交集（jobs 只是记录），但注释写清楚，
   * 免得以后有人「顺手」加个 removeNodes 进来。
   *
   * 正在跑的任务不删：用户可能是误点，而且删了之后进度就没人跟了。
   */
  function removeJobRecord(id) {
    const key = String(id ?? '')
    const job = jobs.get(key)
    if (!job) return { removed: false, reason: 'no-job' }
    if (job.state === 'running') return { removed: false, reason: 'running' }
    jobs.delete(key)
    schedulePersist(true)
    return { removed: true, reason: '' }
  }

  /**
   * 一次删掉**一批传输记录**（0.4.7，界面上的「一键删除」）。
   *
   * family: 'upload' | 'download' | ''（空 = 全部）
   * 同样只删记录，不动任何文件。正在跑的任务会被跳过并如实回报数量。
   */
  function removeJobRecords(params = {}) {
    const family = params.family === 'upload' || params.family === 'download' ? params.family : ''
    let removed = 0
    let skipped = 0
    for (const [key, job] of [...jobs.entries()]) {
      if (family && jobFamily(job.kind) !== family) continue
      if (job.state === 'running') {
        skipped += 1
        continue
      }
      jobs.delete(key)
      removed += 1
    }
    if (removed > 0) schedulePersist(true)
    return { removed, skipped, family }
  }

  /**
   * 传输记录文件夹在哪。
   *
   * 用户要求记录「永不删除」，那就得让他能自己找到、自己备份/清理这个文件 ——
   * 所以界面上不再有「清空记录」，而是「打开记录所在文件夹」。
   */
  function transfersFileInfo() {
    return {
      // ⚠️ 只回文件名，不回绝对路径（那里带 Windows 用户名）。
      fileName: basename(transfersFile),
      // 点「打开」时才由宿主自己 spawn 资源管理器，路径不出接口。
      exists: existsSync(transfersFile),
      count: jobs.size,
    }
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
   *
   * 返回里同时带上**空目录**（`dirs`）—— 否则下完之后本地会少掉那些空文件夹，
   * 用户看到的结构和网盘对不上。
   *
   * 🔴 0.5.2：`item.name` 是云端给的**外部数据**，可能是 `../../evil.txt`、
   * `..\\..\\evil.txt`、`/tmp/evil.txt`、`C:\\Windows\\evil.txt`、
   * `\\\\server\\share\\evil.txt`。拼进相对路径之后，落盘那一步就会写到
   * 目标目录之外。所以这里先用 safeRelativeName()（模块级纯函数）过滤，
   * 落盘那一层再用 safeJoin() 兜一道 —— 双保险，任何一层都能单独挡住。
   */
  async function collectFolder(folderId, prefix, out, depth = 0) {
    if (depth > 32) throw new Error('目录层级过深，可能在打转，已中止')
    let cursor = ''
    do {
      const page = await listFiles(folderId, cursor)
      for (const item of page.items) {
        const safeName = safeRelativeName(prefix, item.name)
        if (safeName === null) {
          /**
           * 越界 / 非法名字：收进 `out.skipped`，不递归、不入列。
           * 不静默改名（那会让用户以为下到了别的东西），也不整批失败。
           * 落盘那一层还会再过一道 safeJoin，双保险。
           */
          out.skipped.push({
            name: String(item.name ?? ''),
            parent: prefix || '/',
            reason: '路径越界或名字非法',
          })
          continue
        }
        if (item.type === 'folder') {
          out.dirs.push(safeName)
          await collectFolder(item.id, safeName, out, depth + 1)
        } else {
          out.files.push({ fileId: item.id, relative: safeName, size: item.size })
        }
      }
      cursor = page.nextCursor || ''
    } while (cursor)
  }

  /**
   * 下载整个文件夹（0.4.0 重做：「模仿中国移动云盘网页端的文件夹下载方式」）。
   *
   * 网页端不是逐个遍历 children 下载的。实测（从 yun.139.com 的 JS bundle 里扒出来
   * 并用真实账号验证过）它走的是**服务端打包**：
   *
   *   1. POST {host}/file/archiveFiles  { fileIds:[文件夹id], name:'xxx.zip' }
   *        → { data: { taskId, downloadUrl } }   ← 两者二选一
   *   2. 若只有 taskId：每秒轮询 POST {host}/task/get { taskId }
   *        响应结构是 **data.taskInfo.status**（不是 taskResult.taskInfo.status！）
   *        status ∈ Running / Succeed / Failed
   *        Succeed 时链接在 **data.extraData**（一个 JSON 字符串，要再 parse 一次）
   *        里取 `.url`，那是带签名的 zip 直链（实测有效期 900 秒）。
   *   3. 把那个 zip 直链流式下载到本地。
   *
   * 这样只有一个网络请求 + 一次打包等待，比逐个文件下快得多，目录结构也是服务端
   * 打好的（不会丢空目录、不会因为某个文件失败就整批废掉）。
   *
   * ⚠️ 服务端限制：同一账号**同时只允许一个打包任务**
   * （网页端硬闸：「有下载任务执行中，请等待完成后再试」，
   * 错误码 04010307 = 运行任务数达到系统限制）。所以这里必须串行 ——
   * 用 archiveQueue 把并发压到 1。
   *
   * ⚠️ 打包失败要给退路：超时（04010308）/ 超大（00010306）/ 超量（00010305）
   * 这几类**不能重试**（会白白消耗任务配额），直接回落成逐文件下载。
   */
  let archiveChain = Promise.resolve()

  /** 把「打包下载」串行化：同一个账号同时只能有一个打包任务。 */
  function runExclusive(task) {
    const next = archiveChain.then(task, task)
    // 别让链条因为某一次失败而断掉
    archiveChain = next.then(() => undefined, () => undefined)
    return next
  }

  /** 这几个错误码重试没用（配额 / 超限 / 超时），要直接回落。 */
  const ARCHIVE_FATAL_CODES = new Set(['04010307', '04010308', '00010306', '00010305', '00010012'])

  /**
   * 请求服务端把一批 fileId 打成 zip，返回 zip 直链。
   *
   * job 用来报进度（phase / done / total 由调用方维护，这里只更新 phase）。
   */
  async function requestArchiveUrl(fileIds, zipName, job) {
    const ids = (Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean)
    if (!ids.length) throw new Error('没有要打包的文件')

    if (job) job.phase = 'archive'
    const created = await withHostRetry(() =>
      call(personalUrl('/file/archiveFiles'), { fileIds: ids, name: zipName }),
    )
    const data = created?.data ?? {}

    // 分支 A：直接给了链接
    if (typeof data.url === 'string' && data.url) return data.url
    if (typeof data.downloadUrl === 'string' && data.downloadUrl) return data.downloadUrl

    // 分支 B：异步任务，要轮询
    const taskId = data.taskId
    if (!taskId) {
      throw new Error('服务端既没给打包直链、也没给任务号')
    }

    /**
     * 轮询。实测单次打包（不大的目录）1~2 秒就 Succeed，大目录可能几十秒。
     * 上限给 10 分钟：再久基本就是服务端排队卡住，让用户重试更好。
     * 每 1 秒一次，和网页端一致。
     */
    const deadline = Date.now() + 10 * 60 * 1000
    while (Date.now() < deadline) {
      if (job?.signal?.aborted) throw new Error('已取消')
      await sleep(1000)
      const got = await withHostRetry(() => call(personalUrl('/task/get'), { taskId }))
      const info = got?.data?.taskInfo ?? {}
      const status = String(info.status ?? '')
      if (job) {
        // 服务端给的 progress 是百分比，换算成「假装已经走了多少字节」不现实，
        // 所以这里只把 phase 换成 archive，进度条走不确定态（界面已经支持）。
        job.currentFile = `正在打包（${info.progress ?? 0}%）`
      }
      if (status === 'Succeed') {
        const extraRaw = got?.data?.extraData
        let parsed = null
        try {
          parsed = typeof extraRaw === 'string' ? JSON.parse(extraRaw) : extraRaw
        } catch (error) {
          throw new Error(`打包任务完成了，但解不出下载地址（${errorMessage(error)}）`)
        }
        const url = parsed?.url || parsed?.downloadUrl
        if (!url) throw new Error('打包任务完成了，但响应里没有 zip 地址')
        return String(url)
      }
      if (status === 'Failed') {
        const code = String(info.code ?? '')
        const message = String(info.message ?? '打包失败')
        const error = new Error(`打包失败：${message}${code ? `（${code}）` : ''}`)
        error.archiveFatal = ARCHIVE_FATAL_CODES.has(code) || true // Failed 一律不重试
        error.archiveCode = code
        throw error
      }
    }
    throw new Error('打包超时：服务端 10 分钟都没给出 zip 地址，请稍后重试。')
  }

  /**
   * 下载整个文件夹。
   *
   * preferred: 'archive'（默认，服务端打包成一个 zip）| 'files'（逐个下载）
   * 打包失败时**自动回落**成逐个下载，保证「点了就一定能下到东西」。
   */
  async function downloadFolder(folderId, localDir, job, options = {}) {
    const mode = options.mode === 'files' ? 'files' : 'archive'
    const folderName = String(options.folderName || '').trim()

    if (mode === 'archive') {
      try {
        return await runExclusive(() => downloadFolderAsArchive(folderId, localDir, job, folderName))
      } catch (error) {
        if (job.signal.aborted) throw new Error('已取消')
        logger?.warn?.(`mobile-cloud: 打包下载失败，回落成逐个下载（${errorMessage(error)}）`)
        if (job) {
          job.currentFile = `打包下载不可用（${errorMessage(error)}），改成逐个文件下载…`
        }
        return downloadFolderFileByFile(folderId, localDir, job)
      }
    }
    return downloadFolderFileByFile(folderId, localDir, job)
  }

  /** 服务端打包 → 一个 zip 落盘。 */
  async function downloadFolderAsArchive(folderId, localDir, job, folderName) {
    job.phase = 'scan'
    /**
     * 0.5.2：`folderName` 是云端目录名（外部数据），会同时进
     * ① 发给服务端的 zip 名、② 本地落盘路径。这里统一摘成「纯文件名」，
     * 去掉任何目录分隔符 / `..` / 盘符 —— 落盘再走一次 safeJoin 兜底。
     */
    const zipBase = safeFileName(folderName || 'download')
    const url = await requestArchiveUrl([folderId], `${zipBase}.zip`, job)
    if (job.signal.aborted) throw new Error('已取消')

    job.phase = 'download'
    mkdirSync(localDir, { recursive: true })
    const zipPath = safeJoin(localDir, `${zipBase}.zip`)
    if (zipPath === null) throw new Error('目录名里含有非法路径片段，已拒绝写入')
    job.total = 0
    job.currentFile = null

    const response = await fetch(url, { redirect: 'follow', signal: job.signal })
    if (!response.ok) throw new Error(`下载 zip 失败 HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0
    if (total) job.total = total
    job.done = 0
    await streamToFile(response.body, zipPath, (bytes) => {
      job.done += bytes
    }, job.signal)

    return {
      localDir,
      zipPath,
      packed: true,
      files: 1,
      bytes: job.done,
      message: '服务端已经把它打成一个 zip 下载下来了。',
    }
  }

  /**
   * 递归列出一棵目录树（逐个下载用）。
   *
   * ⚠️ 0.5.2：这条函数以前是**第二份**定义，和上面那个一模一样 ——
   * 后定义覆盖前定义，于是安全校验被整段顶掉（改上面那份等于没改）。
   * 现在只保留上面那一份（带 safeRelativeName 越界过滤），这里不再重复定义。
   *
   * 返回里同时带上**空目录**（`dirs`）—— 否则下完之后本地会少掉那些空文件夹，
   * 用户看到的结构和网盘对不上。
   */

  /** 逐个文件下载的回落路径（打包不可用时才走）。 */
  async function downloadFolderFileByFile(folderId, localDir, job) {
    job.phase = 'scan'
    /**
     * skipped：collectFolder 阶段就判定为越界 / 非法名字的条目。
     * 它们不会进入 files/dirs，但要在结果里报出来 —— 不能静默消失。
     */
    const tree = { dirs: [], files: [], skipped: [] }
    await collectFolder(folderId, '', tree)
    job.total = tree.files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
    job.fileCount = tree.files.length
    job.phase = 'download'

    // 失败清单从这里开始收集：collectFolder 阶段跳过的先记进去
    const failures = tree.skipped.map((entry) => ({
      relative: entry.name,
      error: entry.reason,
    }))

    // 目录先建出来（空目录也要有），否则结构和网盘对不上。
    // 🔴 0.5.2：`tree.dirs` 里已经是 collectFolder 归一过的相对路径，
    // 但落盘这一层仍然要再过一次 safeJoin —— 不能只信任上游。
    mkdirSync(localDir, { recursive: true })
    const rootResolved = resolve(localDir)
    for (const dir of tree.dirs) {
      const dirPath = safeJoin(localDir, dir)
      if (dirPath === null) {
        // 越界目录：不建、记为失败、继续下别的
        failures.push({ relative: dir, error: '路径越界，已跳过（不会写到目标目录之外）' })
        logger?.warn?.(`mobile-cloud: 跳过越界的本地目录 ${dir}`)
        continue
      }
      try {
        mkdirSync(dirPath, { recursive: true })
      } catch (error) {
        logger?.warn?.(`mobile-cloud: 建本地目录失败 ${dir}（${errorMessage(error)}）`)
      }
    }

    if (!tree.files.length) {
      return {
        localDir,
        dirs: tree.dirs.length,
        files: 0,
        bytes: 0,
        failed: failures,
        packed: false,
        message: failures.length
          ? `这个文件夹里没有可下载的文件（${failures.length} 个条目因路径非法被跳过）。`
          : '这个文件夹是空的（已经建好对应的空目录）。',
      }
    }

    const concurrency = Math.min(3, Math.max(1, tree.files.length))
    let cursorIndex = 0

    /** 下一个待下载的文件（多个 worker 抢着取，天然去重）。 */
    function nextFile() {
      if (job.signal.aborted) return null
      if (cursorIndex >= tree.files.length) return null
      const file = tree.files[cursorIndex]
      cursorIndex += 1
      return file
    }

    async function worker() {
      let file = nextFile()
      while (file) {
        if (job.signal.aborted) return
        job.currentFile = file.relative
        /**
         * 🔴 0.5.2 的关键一道：写文件前用 safeJoin 解析并校验。
         * 越界就记失败 + 继续下一个，**不静默改名、也不整批中断**。
         */
        const targetPath = safeJoin(localDir, file.relative)
        if (targetPath === null) {
          failures.push({ relative: file.relative, error: '路径越界，已跳过（不会写到目标目录之外）' })
          logger?.warn?.(`mobile-cloud: 跳过越界的下载目标 ${file.relative}`)
          file = nextFile()
          continue
        }
        // 兜底：即便 safeJoin 通过，也再核一次它确实在 localDir 里
        if (!isInside(rootResolved, targetPath)) {
          failures.push({ relative: file.relative, error: '路径越界，已跳过（不会写到目标目录之外）' })
          file = nextFile()
          continue
        }
        let attempt = 0
        let lastError = null
        while (attempt < 3) {
          attempt += 1
          try {
            await downloadOneFile(file.fileId, targetPath, job, file.size)
            lastError = null
            break
          } catch (error) {
            lastError = error
            if (job.signal.aborted) return
            if (attempt < 3) await sleep(600 * attempt)
          }
        }
        if (lastError) {
          failures.push({ relative: file.relative, error: errorMessage(lastError) })
        }
        file = nextFile()
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    job.currentFile = null

    if (job.signal.aborted) throw new Error('已取消')

    return {
      localDir,
      dirs: tree.dirs.length,
      files: tree.files.length - failures.length,
      bytes: job.done,
      failed: failures,
      packed: false,
      message: failures.length
        ? `有 ${failures.length} 个文件没能下载（其余 ${tree.files.length - failures.length} 个已完成）。`
        : undefined,
    }
  }

  /**
   * 下载单个文件到指定路径，并保证「这一个文件」对进度的贡献恒等于它的大小。
   *
   * 为什么单独包一层：文件夹逐个下载时 total 是整棵树的合计，
   * 而 CDN 返回的 content-length 可能缺、也可能和列表里的 size 不一致，
   * 直接把流字节数累进 job.done 会让进度条永远差一截。
   */
  async function downloadOneFile(fileId, localPath, job, expectedSize) {
    const before = job.done
    await downloadFile(fileId, localPath, job)
    const gained = job.done - before
    const expected = Number(expectedSize) || 0
    if (expected > 0 && gained < expected) job.done += expected - gained
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
      // 凭据被服务端判定失效（过期/改密/踢下线）→ 界面直接引导重新登录，
      // 而不是把「认证失败(05050006)」这种原始错误码丢给用户。
      needsReauth: Boolean(quotaError && /认证失败|暂无权限|授权已过期|登录失败/.test(quotaError)),
      userDomainId: value?.userDomainId ?? null,
      // 只回文件名：完整路径带 Windows 用户名（C:\Users\<名字>\...），没必要发出去。
      credentialFileName: basename(store.file),
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

  /**
   * 用账号密码登录，换出 Authorization。
   *
   * rememberPassword = true 时把账号密码也存进凭据文件（DPAPI 加密），
   * 否则**只在内存里用一次，用完即弃**。
   */
  async function login(account, password, rememberPassword) {
    const cleanAccount = String(account ?? '').trim()
    const cleanPassword = String(password ?? '')
    if (!cleanAccount) throw new Error('请填写手机号或邮箱')
    if (!cleanPassword) throw new Error('请填写密码')

    const result = await loginWithPassword(cleanAccount, cleanPassword)
    const next = {
      authorization: result.authorization,
      userDomainId: result.userDomainId || '',
    }
    if (rememberPassword === true) {
      next.savedAccount = cleanAccount
      next.savedPassword = cleanPassword
    }
    update(next)
    host = null
    await ensureHost()

    let quota = null
    let quotaError = null
    try {
      quota = await getQuota()
    } catch (error) {
      quotaError = errorMessage(error)
    }
    return {
      accountMasked: maskAccount(result.account),
      quota,
      quotaError,
      rememberPassword: rememberPassword === true,
    }
  }

  /** 读回已保存的账号（密码不回传，只告诉前端「有没有存」）。 */
  function savedLogin() {
    const value = credential
    if (!value || !value.savedAccount) return { hasSaved: false, account: null }
    return { hasSaved: true, account: value.savedAccount }
  }

  // ---------------------------------------------------------- 扫码登录
  /**
   * 扫码登录：拉起浏览器 → 等用户扫码 → 抓 cookie 里的 authorization。
   * 这是个长任务（最长 5 分钟），所以做成「后台跑 + 前端轮询进度」。
   */
  let scanSession = null

  function startScan() {
    if (scanSession && scanSession.state === 'running') {
      return { ok: true, already: true, ...snapshotScan() }
    }
    const session = {
      id: randomUUID().slice(0, 8),
      state: 'running',
      phase: 'launching',
      message: '正在启动浏览器…',
      startedAt: Date.now(),
      error: null,
      controller: new AbortController(),
    }
    scanSession = session

    session.promise = (async () => {
      try {
        const result = await scanLogin({
          signal: session.controller.signal,
          onProgress: (p) => {
            session.phase = p.phase || session.phase
            session.message = p.message || session.message
          },
        })
        // 存凭据（扫码拿到的令牌同样支持自动续期）
        update({
          authorization: result.authorization,
          userDomainId: result.udId || '',
        })
        host = null
        try {
          await ensureHost()
        } catch {
          /* host 解析失败不影响保存 */
        }
        session.state = 'done'
        session.phase = 'done'
        session.message = '登录成功'
        session.result = {
          accountMasked: maskAccount(decodeAuthorization(result.authorization).account),
        }
      } catch (error) {
        session.state = error?.message === '已取消扫码登录' ? 'cancelled' : 'error'
        session.phase = 'error'
        session.error = errorMessage(error)
        session.message = session.error
      }
    })()
    session.promise.catch(() => {})
    return { ok: true, ...snapshotScan() }
  }

  function snapshotScan() {
    if (!scanSession) return { state: 'idle', phase: 'idle', message: '' }
    return {
      id: scanSession.id,
      state: scanSession.state,
      phase: scanSession.phase,
      message: scanSession.message,
      error: scanSession.error,
      result: scanSession.result ?? null,
      elapsedMs: Date.now() - scanSession.startedAt,
    }
  }

  function cancelScan() {
    if (!scanSession || scanSession.state !== 'running') return { cancelled: false }
    try {
      scanSession.controller.abort()
    } catch {
      /* 已经停了 */
    }
    return { cancelled: true }
  }

  /**
   * 界面用的搜索：在当前目录及其子目录里按名字找。
   *
   * 和模型工具 `mcloud_search` 的差别：
   *   · 工具版是 BFS 走 10 页，适合「帮我找找」，用户等得起；
   *   · 界面版是人在输入框里打字，必须**尽快出第一批结果**，并且要能中途取消。
   *
   * 所以这里：先只搜当前这一层（最快），够了就停；不够再往下走，
   * 且总量封顶，避免用户搜个常见字把整个网盘翻一遍。
   */
  async function searchFiles(keyword, parentFileId = ROOT_ID, options = {}) {
    const needle = String(keyword ?? '').trim().toLowerCase()
    if (!needle) return { items: [], truncated: false }

    // 只在磁盘上跑：limit 是「返回上限」，pages 是「最多翻多少页」
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 120))
    const maxPages = Math.max(1, Math.min(60, Number(options.maxPages) || 24))
    const depthLimit = Math.max(0, Math.min(8, Number(options.depth) ?? 4))

    const matches = []
    let pages = 0
    let truncated = false

    /** 走一层：返回这一层里的文件夹 id，供下一层继续。 */
    async function scanFolder(folderId, depth, pathLabel) {
      const children = []
      let cursor = ''
      do {
        if (pages >= maxPages || matches.length >= limit) {
          truncated = true
          return children
        }
        const page = await listFiles(folderId, cursor)
        pages += 1
        for (const item of page.items) {
          const hit = String(item.name || '').toLowerCase().includes(needle)
          if (hit) {
            matches.push({
              ...item,
              parent: folderId,
              parentPath: pathLabel,
            })
            if (matches.length >= limit) {
              truncated = true
              return children
            }
          }
          if (item.type === 'folder') children.push(item)
        }
        cursor = page.nextCursor || ''
      } while (cursor)
      return children
    }

    // 第一层（当前目录）：优先、同步完成
    const level1 = await scanFolder(parentFileId, 0, '/')

    if (depthLimit > 0 && matches.length < limit && pages < maxPages) {
      let frontier = level1.map((folder) => ({ id: folder.id, path: '/' + folder.name }))
      for (let depth = 1; depth <= depthLimit && frontier.length && matches.length < limit; depth += 1) {
        const next = []
        for (const folder of frontier) {
          if (pages >= maxPages || matches.length >= limit) {
            truncated = true
            break
          }
          const kids = await scanFolder(folder.id, depth, folder.path)
          for (const kid of kids) next.push({ id: kid.id, path: folder.path + '/' + kid.name })
        }
        frontier = next
      }
    }

    return { items: matches, truncated, pages }
  }

  /**
   * 查一个文件/文件夹是否**还在原来的父目录下**（0.4.0「定位」用）。
   *
   * 用户要求：「如果用户下载和上传的文件移动了位置那就显示无法定位」。
   *
   * 所以定位前必须先复核，而不是拿着记忆里的 fileId 直接跳：
   *   · 文件被移到别处 / 被删 → 不在原目录了 → 报「无法定位」
   *   · 文件夹被改名但还在原地 → 仍然能定位（按 fileId 找）
   *
   * 网盘没有「按 fileId 反查路径」的接口，所以只能列父目录去找。
   * 为了快，第一页 pageSize=50，最多翻 5 页 —— 正常情况下文件就在附近；
   * 翻不到就认定「已经不在原位」。
   */
  async function locateRemoteItem(parentFileId, fileId) {
    const parent = parentFileId || ROOT_ID
    const wanted = String(fileId ?? '')
    if (!wanted) return { found: false, reason: 'no-id' }
    let cursor = ''
    let pages = 0
    do {
      const page = await listFiles(parent, cursor, LIST_PAGE_SIZE, { force: true })
      const hit = page.items.find((item) => item.id === wanted)
      if (hit) return { found: true, item: hit, parentFileId: parent }
      cursor = page.nextCursor || ''
      pages += 1
    } while (cursor && pages < 5)
    return { found: false, reason: 'moved', parentFileId: parent }
  }

  /**
   * 按 fileId 反查它在网盘里的**完整路径**（0.4.5）。
   *
   * 为什么要这个：上传记录只记了 `parentFileId`，而 `parentPath` 在相当多的
   * 记录里是 null（老记录 / 拖拽上传 / 服务端没回名字）。之前「定位」缺了层级名就只能
   * 老实退回根目录 —— 照片明明在 `/Windows/实验/.../第一周实验结果` 里，
   * 点定位却跳回 `/`，用户看到的就是「找不到上传的图片」。
   *
   * 实现见顶层 `resolveRemotePathBfs`（提取成纯函数，便于单测）。
   */
  function resolveRemotePath(targetFileId, options = {}) {
    return resolveRemotePathBfs(targetFileId, {
      listFiles,
      pageSize: LIST_PAGE_SIZE,
      ...options,
    })
  }

  /**
   * 复核一条传输记录还能不能定位（0.4.0，0.4.5 增加路径反查）。
   *
   * 返回 { canReveal, kind:'local'|'remote'|'', reason, path?, trail? }：
   *   · 'local-missing'  本机那个文件/文件夹已经不在了（被移走或删了）
   *   · 'remote-moved'   网盘里那个文件已经不在原来的目录了
   *   · 'no-path'        老记录，压根没留下位置
   *
   * ⚠️ 上传记录会额外带回 `path` / `trail`（网盘目录路径 + 每一级的 id/name）。
   * 那是**网盘**里的路径，不含任何本机信息，给界面重建面包屑用；
   * 本机绝对路径依然一个字都不回（那是 /transfers 的规矩，这里照旧）。
   */
  async function checkJobLocatable(id) {
    const job = jobs.get(String(id ?? ''))
    if (!job) return { canReveal: false, kind: '', reason: 'no-job' }
    const family = jobFamily(job.kind)

    if (family === 'download') {
      const target = typeof job.localPath === 'string' ? job.localPath.trim() : ''
      if (!target) return { canReveal: false, kind: 'local', reason: 'no-path' }
      if (!existsSync(target)) return { canReveal: false, kind: 'local', reason: 'local-missing' }
      return { canReveal: true, kind: 'local', reason: '' }
    }

    if (family === 'upload') {
      const parentId = job.parentFileId
      const remoteId = job.fileId
      if (!parentId && !remoteId) return { canReveal: false, kind: 'remote', reason: 'no-path' }

      /**
       * 🔴 0.4.5 第 1 条的核心：**必须把父目录的完整路径查出来**。
       *
       * 老记录 / 拖拽上传的记录里 `parentPath` 经常是 null，只有 `parentFileId`。
       * 之前界面拿到 null 就只能退回根目录 —— 照片在 `/Windows/实验/.../第一周实验结果`
       * 里，点「定位」却跳回 `/`，用户看到的就是「找不到上传的图片」。
       *
       * 所以这里先试 resolveRemotePath(parentFileId)，拿到带每一级 id 的 trail；
       * 查不到（网络抖动 / 层级太深）再退回记录里的 parentPath 字符串。
       */
      let trail = null
      if (parentId && parentId !== ROOT_ID) {
        try {
          const resolved = await resolveRemotePath(parentId)
          if (resolved) trail = resolved.trail
        } catch (error) {
          logger?.warn?.(`mobile-cloud: 反查目录路径失败（${errorMessage(error)}）`)
        }
      }

      const recordedPath = typeof job.parentPath === 'string' ? job.parentPath.trim() : ''
      const path = trail && trail.length
        ? '/' + trail.map((entry) => entry.name).join('/')
        : recordedPath

      // 老记录只有 parentFileId（没有 fileId）：至少目录还在，就允许跳过去。
      if (!remoteId) {
        return {
          canReveal: true,
          kind: 'remote',
          reason: '',
          path: path || null,
          trail: trail || null,
        }
      }
      try {
        const hit = await locateRemoteItem(parentId, remoteId)
        if (hit.found) {
          return {
            canReveal: true,
            kind: 'remote',
            reason: '',
            path: path || null,
            trail: trail || null,
          }
        }
        return { canReveal: false, kind: 'remote', reason: 'remote-moved' }
      } catch (error) {
        // 网络抖动别把「能定位」变成「不能」：宁可放它去试，让用户看到真实报错。
        logger?.warn?.(`mobile-cloud: 复核上传记录位置失败（${errorMessage(error)}）`)
        return {
          canReveal: true,
          kind: 'remote',
          reason: '',
          path: path || null,
          trail: trail || null,
        }
      }
    }

    return { canReveal: false, kind: '', reason: 'no-path' }
  }

  /**
   * 打开「传输记录文件」所在的文件夹（0.4.0）。
   *
   * 记录永不删除，所以界面不再给「清空」按钮，改成让用户自己找到这个文件
   * 去备份 / 自己清理。文件存在就选中它，不存在就只打开目录。
   */
  function revealTransfersFolder() {
    if (!windows) throw new Error('打开记录文件夹目前只支持 Windows')
    const dir = dirname(transfersFile)
    mkdirSync(dir, { recursive: true })
    const hasFile = existsSync(transfersFile)
    try {
      // 和 revealLocalPath 同一套：verbatim + 自己加引号（路径里带用户名/空格也能定位）。
      const { args, options } = hasFile
        ? explorerLocateArgs(transfersFile, false)
        : explorerLocateArgs(dir, true)
      const child = spawn('explorer.exe', args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        ...options,
      })
      child.on('error', () => {})
      child.unref()
    } catch (error) {
      throw new Error(`打开记录文件夹失败：${errorMessage(error)}`)
    }
    return { ok: true, fileName: basename(transfersFile) }
  }

  return {
    status,
    authorize,
    login,
    savedLogin,
    startScan,
    snapshotScan,
    cancelScan,
    forget,
    listFiles,
    searchFiles,
    getDownloadUrl,
    makeDir,
    renameNode,
    moveNodes,
    removeNodes,
    getQuota,
    startJob,
    getJob,
    getJobLocalTarget,
    listJobs,
    runningJobCount,
    cancelJob,
    removeJobRecord,
    removeJobRecords,
    transfersFileInfo,
    revealTransfersFolder,
    transferJobSnapshot: snapshot,
    checkJobLocatable,
    ensureFolder,
    uploadFile,
    uploadFolder,
    uploadFromTempPath,
    downloadFile,
    downloadFolder,
    isAuthorized: () => Boolean(credential?.authorization),
    dispose() {
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
    },
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
        { parentFileId: args?.parentFileId })
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
        { parentFileId: args?.parentFileId })
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
        { localPath })
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
        { localPath })
        const result = await job.promise
        return textResult(
          `已把整个文件夹下载到 ${result.localDir}（${result.files} 个文件，${humanSize(result.bytes)}）。`,
        )
      },
    },
  ]
}

// ------------------------------------------------------------------ 路由

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

function createRoutes(client, options = {}) {
  const base = '/api/dsh-mcloud'

  /**
   * 所有路由共用的一道闸：环回 + Host + Origin。
   *
   * `x-dsh-mcloud: 1` 只是「这条请求确实想调插件」的标记，**不是安全边界** ——
   * 任何网页都能自己加上。真正的边界在 requestRejection 里。
   */
  function guard(req, res) {
    const reason = requestRejection(req, options)
    if (reason !== null) {
      writeJson(res, 403, { ok: false, error: reason })
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
      path: `${base}/scan/start`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async () => client.startScan())
      },
    },
    {
      kind: 'exact',
      path: `${base}/scan/status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          writeJson(res, 200, { ok: true, ...client.snapshotScan() })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${base}/scan/cancel`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async () => client.cancelScan())
      },
    },
    {
      kind: 'exact',
      path: `${base}/login`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          if (typeof value.account !== 'string' || typeof value.password !== 'string') {
            throw new Error('account 和 password 都必须是字符串')
          }
          const result = await client.login(value.account, value.password, value.rememberPassword === true)
          return result
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/login/saved`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          writeJson(res, 200, { ok: true, ...client.savedLogin() })
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
          /**
           * 🔴 0.4.0 修的是这一条：以前只有显式 `refresh=1` 才绕过宿主 60 秒缓存，
           * 而界面上**没有任何一条路径会带它** —— 「刷新」按钮走 reload()、
           * 上传完成后走 refreshAfterUpload() → reload()，两个都不带。
           *
           * 于是用户看到的现象就是：传完文件点了刷新，列表还是旧的；
           * 再等几十秒（缓存过期）才忽然出现。这跟「上传有概率不显示、刷新也没用、
           * 过几十秒才显示」完全对上。
           *
           * 现在改成默认值反过来：**默认不吃缓存**，只有明确 `cache=1` 才用。
           * 缓存的价值在「回访目录秒开」，那由客户端自己的 5 分钟 stale-while-revalidate
           * 缓存负责（先渲染旧数据再后台校准），不需要宿主这层 60 秒缓存再来挡一道。
           */
          const useCache = url.searchParams.get('cache') === '1'
          const force = !useCache
          const page = await client.listFiles(parentFileId, cursor, pageSize ?? LIST_PAGE_SIZE, { force })
          writeJson(res, 200, { ok: true, parentFileId, ...page })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: errorMessage(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${base}/search`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url, 'http://127.0.0.1')
          const keyword = url.searchParams.get('keyword') || ''
          const parentFileId = url.searchParams.get('parentFileId') || ROOT_ID
          const depth = url.searchParams.get('depth')
          const result = await client.searchFiles(keyword, parentFileId, {
            depth: depth === null ? undefined : Number(depth),
          })
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${base}/pick-dir`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async () => {
          const paths = await pickLocalPaths('download-dir')
          return { path: paths[0] || '', cancelled: paths.length === 0 }
        })
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
      path: `${base}/reveal`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          // 传 localPath 就在本机资源管理器里定位；传 jobId 就用任务记下的落点。
          //
          // 0.4.0：传 jobId 时**先复核还能不能定位** ——
          // 用户要求「文件移动了位置就显示无法定位」，所以这里先查本机文件还在不在，
          // 不在就明确报错，而不是让 explorer 静默打开别的地方。
          let target = String(value.localPath ?? '').trim()
          if (!target && value.jobId) {
            const id = String(value.jobId)
            const found = client.getJob(id)
            if (!found) throw new Error('找不到这条传输记录')
            const verdict = await client.checkJobLocatable(id)
            if (!verdict.canReveal) {
              if (verdict.reason === 'local-missing') {
                throw new Error('无法定位：这个文件已经被移动或删除了。')
              }
              if (verdict.reason === 'no-path') throw new Error('这条记录没有记下本机位置')
              throw new Error('无法定位：这条记录的位置信息已经失效。')
            }
            /**
             * 🔴 路径要从**宿主内部**取，不能用 getJob()。
             *
             * getJob 返回的是 snapshot()，而 snapshot 为了不把本机绝对路径发给浏览器，
             * 里面是没有 localPath 的。以前这里写的正是 `found.localPath` ——
             * 于是永远读到 undefined → 永远抛「这条记录没有记下本机位置」，
             * 用户看到的就是「下载定位无效」。
             */
            const local = client.getJobLocalTarget(id)
            if (!local || !local.localPath) throw new Error('这条记录没有记下本机位置')
            target = local.localPath
          }
          return revealLocalPath(target)
        })
      },
    },
    {
      // 0.4.0：记录永不删除，所以不再提供「清空」。只提供「这条还能不能定位」的复核，
      // 以及「打开记录文件所在文件夹」让用户自己管理。
      kind: 'exact',
      path: `${base}/transfers/check`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const jobId = url.searchParams.get('jobId') || ''
          if (!jobId) return writeJson(res, 400, { ok: false, error: 'jobId 不能为空' })
          const verdict = await client.checkJobLocatable(jobId)
          return writeJson(res, 200, { ok: true, ...verdict })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    },
    {
      /**
       * 删掉**一条**传输记录（0.4.7）。
       *
       * 🔴 只删记录，不删文件 —— 网盘上的、本机下载下来的都不动。
       * 用户原话：「注意删除的不是文件，而是记录」。
       */
      kind: 'exact',
      path: `${base}/transfers/remove`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const jobId = String(value.jobId ?? '').trim()
          if (!jobId) throw new Error('jobId 不能为空')
          const result = client.removeJobRecord(jobId)
          if (!result.removed) {
            if (result.reason === 'running') {
              throw new Error('这个任务还在传输中，先取消再删记录')
            }
            throw new Error('找不到这条传输记录（可能已经删掉了）')
          }
          return { removed: 1 }
        })
      },
    },
    {
      /**
       * 一键删掉**一批**传输记录（0.4.7）。
       *
       * family: 'upload' | 'download' | ''（空 = 两个页签都清）
       * 同样只删记录，不碰任何文件。
       */
      kind: 'exact',
      path: `${base}/transfers/clear`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async (value) => {
          const family = value.family === 'upload' || value.family === 'download' ? value.family : ''
          const result = client.removeJobRecords({ family })
          return result
        })
      },
    },
    {
      kind: 'exact',
      path: `${base}/transfers/open-folder`,
      handler: async (req, res) => {
        if (!guardWrite(req, res)) return
        await post(req, res, async () => client.revealTransfersFolder())
      },
    },
    {
      kind: 'exact',
      path: `${base}/transfers/info`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          writeJson(res, 200, { ok: true, ...client.transfersFileInfo() })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
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
          // 0.4.0：支持按 upload / download 分页（记录永不删除，可能很多条）
          const page = client.listJobs({
            family: url.searchParams.get('family') || '',
            offset: url.searchParams.get('offset'),
            limit: url.searchParams.get('limit'),
          })
          writeJson(res, 200, {
            ok: true,
            jobs: page.jobs,
            total: page.total,
            offset: page.offset,
            limit: page.limit,
            family: page.family,
            running: client.runningJobCount(),
          })
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
          { parentFileId: value.parentFileId, parentPath: cleanParentPath(value.parentPath) })
          job.total = stats.size
          return { jobId: job.id, name: job.label }
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
          { parentFileId: value.parentFileId, parentPath: cleanParentPath(value.parentPath) })
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
        const parentPath = cleanParentPath(url.searchParams.get('parentPath'))
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
        { parentFileId, parentPath })
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
          const displayName = typeof value.name === 'string' && value.name.trim()
            ? basename(value.name.trim())
            : ''
          const localPath =
            String(value.localPath ?? '').trim() || join(DEFAULT_DOWNLOAD_DIR, displayName || fileId)
          const job = client.startJob('download', displayName || basename(localPath), (active) =>
            client.downloadFile(fileId, localPath, active),
          { localPath, fileId, name: displayName || basename(localPath) })
          return { jobId: job.id }
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
          // 文件夹名用来做 zip 名 / 本地目录名。浏览器传上来的是**网盘里的名字**，
          // 不能从 localPath 反推（默认落点原来用的是 folderId，用户会看到一串乱码目录名）。
          const folderName = typeof value.name === 'string' && value.name.trim()
            ? basename(value.name.trim())
            : ''
          const localDir =
            String(value.localPath ?? '').trim() ||
            join(DEFAULT_DOWNLOAD_DIR, folderName || folderId)
          // 默认走服务端打包（跟网页端一致）；'files' 强制逐个下载。
          const mode = value.mode === 'files' ? 'files' : 'archive'
          const job = client.startJob('download-folder', basename(localDir), (active) =>
            client.downloadFolder(folderId, localDir, active, { mode, folderName }),
          { localPath: localDir, fileId: folderId, name: basename(localDir) })
          return { jobId: job.id }
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

  /**
   * 额外的 Host 白名单，只在「前面挂了反代 / 用自定义域名访问 DSH」时才需要。
   * 支持字符串或数组，形如 `dsh.example.com` 或 `dsh.example.com:8443`。
   */
  const allowedAuthorities = (Array.isArray(config.allowedAuthorities)
    ? config.allowedAuthorities
    : typeof config.allowedAuthorities === 'string'
      ? [config.allowedAuthorities]
      : []
  )
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => entry.trim())

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
      const server = webCtx.webServer
      const routes = createRoutes(client, {
        // 每次都现读，端口是 listen 之后才定的，不能注册时快照
        get webServer() {
          return server
        },
        allowedAuthorities,
      })
      const disposers = routes.map((route) => server.register(route))
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

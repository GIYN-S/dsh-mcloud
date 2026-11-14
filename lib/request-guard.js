/**
 * dsh-mcloud — 请求闸（Host / Origin / DNS rebinding 防护）
 *
 * 背景：`/api/dsh-mcloud/*` 挂在 DSH 的 webServer 上，而 webServer 本身**不做**
 * Host / Origin 准入 —— 它只负责按路径分发。于是只要把一个网页开在你自己的
 * 浏览器里，那个网页就能往 `http://127.0.0.1:<port>/api/dsh-mcloud/mkdir` 发请求，
 * 带着你已登录的云盘凭据干活。
 *
 * 光靠 `x-dsh-mcloud: 1` 挡不住：静态请求头谁都能加，而且它不参与任何校验。
 * 真正的边界是浏览器会替我们带、而攻击者**伪造不了**的两样东西：
 *
 *   · Host —— 页面在 evil.example 上时，浏览器发的 Host 就是 evil.example。
 *     DNS rebinding 只能把 socket 拨到 127.0.0.1，改不了 Host。
 *   · Origin —— 跨站写请求必带；沙箱 iframe / file: 页面会给 "null"。
 *
 * 另外 `Sec-Fetch-Site: cross-site` 是现代浏览器的自述，见到就直接拒，
 * 不给任何绕过解析差异的机会。这一层不建立身份，只回答「这个请求是不是
 * 本部署自己的页面发出的」。
 */

/**
 * 只认「连进来的 socket 是环回」。挡得住局域网里的别人，挡不住你自己浏览器
 * 里开着的网页 —— 那种请求的 remoteAddress 一样是 127.0.0.1。
 * 所以它是第一道闸，不是唯一一道。
 */
export function isLoopbackAddress(address) {
  const text = String(address ?? '')
  return text === '127.0.0.1'
    || text === '::1'
    || text === '::ffff:127.0.0.1'
    || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(text)
}

/** authority 文本里不该出现的东西：空白、路径、凭据分隔符 */
const AUTHORITY_SHAPE = /^[^\s/\\?#@]+$/

/**
 * 把 `host[:port]` 解析成 URL。
 * 用 URL 解析而不是手写正则，是为了让默认端口、大小写、IPv6 方括号的归一化
 * 跟浏览器完全一致 —— 自己写一套往往会和浏览器差一个边界。
 */
export function parseAuthority(text, scheme = 'http:') {
  if (typeof text !== 'string') return undefined
  const value = text.trim()
  if (!value || !AUTHORITY_SHAPE.test(value)) return undefined
  try {
    const url = new URL(`${scheme}//${value}`)
    // 只接受裸 authority；带 userinfo 的一律当畸形
    if (url.username || url.password) return undefined
    return url
  } catch {
    return undefined
  }
}

/** IPv6 的 URL.hostname 带方括号，比较前去掉 */
export function bareHostname(hostname) {
  const text = String(hostname ?? '').trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1)
  return text
}

/** 环回主机名：localhost / *.localhost / 127.0.0.0/8 / ::1 */
export function isLoopbackHostname(hostname) {
  const name = bareHostname(hostname)
  if (!name) return false
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (name === '::1' || name === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/** URL 没写端口时，按协议取默认端口 */
export function effectivePort(url, protocol) {
  if (url.port) return url.port
  return protocol === 'https:' ? '443' : '80'
}

function headerValue(headers, name) {
  const value = headers?.[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

/**
 * 判断一条请求能不能进插件路由。
 *
 * @param req - node:http 的 IncomingMessage（只用到 socket.remoteAddress 与 headers）
 * @param options.webServer - 可选；提供 host / port / protocol 用来核对 Host 的端口。
 *   这是个 getter 友好的对象：端口要等 listen 之后才知道，调用方应当现读。
 * @param options.allowedAuthorities - 额外的 `host` 或 `host:port` 白名单，
 *   给「前面挂了反代 / 用了自定义域名」的部署留的口子。不带端口的条目匹配任意端口。
 * @returns 拒绝理由；通过时返回 null。
 */
export function requestRejection(req, options = {}) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return 'forbidden: loopback-only'

  const server = options.webServer
  const protocol = server?.protocol === 'https:' ? 'https:' : 'http:'

  const hostUrl = parseAuthority(headerValue(req?.headers, 'host'), protocol)
  if (hostUrl === undefined) return 'forbidden: missing or malformed Host'

  const hostname = bareHostname(hostUrl.hostname)
  if (!hostname) return 'forbidden: malformed Host'

  const bindHostname = typeof server?.host === 'string' ? bareHostname(server.host) : ''
  const listenerPort = typeof server?.port === 'number' ? String(server.port) : undefined

  const sameBindAddress = bindHostname !== '' && hostname === bindHostname
  const listed = (options.allowedAuthorities ?? []).some((entry) => {
    const entryUrl = parseAuthority(entry, protocol)
    if (entryUrl === undefined) return false
    if (bareHostname(entryUrl.hostname) !== hostname) return false
    // 不带端口的条目按「任意端口」算，跟 DSH 自己的 trustedHosts 语义一致
    if (!entryUrl.port) return true
    return effectivePort(entryUrl, protocol) === effectivePort(hostUrl, protocol)
  })

  if (!isLoopbackHostname(hostname) && !sameBindAddress && !listed) {
    return 'forbidden: Host is not this deployment'
  }

  // 端口必须对上：否则 evil.example:80 这条 authority 在 rebinding 之后
  // 也能打到本监听器上，而 Host 那一关已经过了。
  if (listenerPort !== undefined && effectivePort(hostUrl, protocol) !== listenerPort) {
    const loose = isLoopbackHostname(hostname) || sameBindAddress
    if (loose) return 'forbidden: Host port is not this listener'
  }

  if (headerValue(req?.headers, 'sec-fetch-site') === 'cross-site') {
    return 'forbidden: cross-site request'
  }

  const origin = headerValue(req?.headers, 'origin')
  if (origin !== undefined) {
    // 沙箱 iframe、file: 页面、某些重定向会把 Origin 写成字面量 "null"
    if (String(origin).trim().toLowerCase() === 'null') return 'forbidden: opaque Origin'
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      return 'forbidden: malformed Origin'
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return 'forbidden: opaque Origin'
    }
    if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) {
      return 'forbidden: cross-origin request'
    }
  }

  return null
}

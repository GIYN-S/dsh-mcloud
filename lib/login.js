/**
 * dsh-mcloud — 登录模块
 *
 * 用「手机号 + 密码」走 139 邮箱的登录流程，最终换出云盘的 Authorization。
 *
 * 三步（社区逆向，参考 OpenList 的 drivers/139）：
 *   1. POST mail.10086.cn/Login/Login.ashx   账号密码登录 → 拿到 sid
 *   2. GET  smsrebuild1.mail.10086.cn/setting/s?func=umc:getArtifact&sid=…  → 拿到 dycpwd
 *   3. POST user-njs.yun.139.com/user/thirdlogin  用 dycpwd 换 authToken（双层 AES）
 *   → Authorization = base64("pc:账号:authToken")
 *
 * 安全约定：
 *   · 密码只在内存里活到登录结束，本模块不写盘。
 *   · 是否持久化由调用方（宿主端）决定，这里只负责算。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createCipheriv, createDecipheriv } from 'node:crypto'

const MAIL_LOGIN_URL = 'https://mail.10086.cn/Login/Login.ashx'
const MAIL_ARTIFACT_URL = 'https://smsrebuild1.mail.10086.cn/setting/s'
const YUN_THIRD_LOGIN_URL = 'https://user-njs.yun.139.com/user/thirdlogin'

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'

/** 第三层登录用的双层 AES 密钥（社区逆向所得，非用户凭据）
 *  KEY_HEX_1 → 24 字节 = AES-192-CBC
 *  KEY_HEX_2 → 16 字节 = AES-128-ECB
 */
const KEY_HEX_1 = '73634235495062495331515373756c734e7253306c673d3d'
const KEY_HEX_2 = '7150714477323633586746674c337538'

const TIMEOUT_MS = 25_000

// ------------------------------------------------------------------ 小工具

function sha1Hex(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/** 139 邮箱的密码哈希规则：sha1("fetion.com.cn:" + 明文密码) */
export function hashMailPassword(password) {
  return sha1Hex(`fetion.com.cn:${String(password)}`)
}

function md5Hex(text) {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

function pkcs7Pad(buf, blockSize) {
  const pad = blockSize - (buf.length % blockSize)
  return Buffer.concat([buf, Buffer.alloc(pad, pad)])
}

function pkcs7Unpad(buf) {
  if (!buf.length) throw new Error('AES 解密失败：数据为空')
  const pad = buf[buf.length - 1]
  if (pad > buf.length) throw new Error('AES 解密失败：填充非法')
  return buf.subarray(0, buf.length - pad)
}

function aesCbcEncrypt(plain, key, iv) {
  // 密钥长度决定算法：16→aes-128, 24→aes-192, 32→aes-256
  const algo = `aes-${key.length * 8}-cbc`
  const cipher = createCipheriv(algo, key, iv)
  return Buffer.concat([cipher.update(pkcs7Pad(plain, 16)), cipher.final()])
}

function aesCbcDecrypt(cipherText, key, iv) {
  const algo = `aes-${key.length * 8}-cbc`
  const d = createDecipheriv(algo, key, iv)
  return pkcs7Unpad(Buffer.concat([d.update(cipherText), d.final()]))
}

function aesEcbDecrypt(cipherText, key) {
  const d = createDecipheriv('aes-128-ecb', key, null)
  d.setAutoPadding(false)
  return pkcs7Unpad(Buffer.concat([d.update(cipherText), d.final()]))
}

/** 递归给 JSON 排序键，再字符串化（第三层登录要求） */
function sortedJsonStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') {
    try {
      return sortedJsonStringify(JSON.parse(value))
    } catch {
      return JSON.stringify(value)
    }
  }
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(sortedJsonStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedJsonStringify(value[k])}`).join(',')}}`
}

function xmlField(xml, tag) {
  const m = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i').exec(xml)
  return m ? m[1] : ''
}

/** 从 Set-Cookie 头里取出某个 cookie 的值 */
function cookieValue(cookieHeaders, name) {
  for (const line of cookieHeaders) {
    const first = String(line).split(';')[0]
    const eq = first.indexOf('=')
    if (eq < 0) continue
    if (first.slice(0, eq).trim() === name) return first.slice(eq + 1)
  }
  return ''
}

function allCookies(cookieHeaders) {
  const pairs = []
  for (const line of cookieHeaders) {
    const first = String(line).split(';')[0]
    if (first.includes('=')) pairs.push(first.trim())
  }
  return pairs.join('; ')
}

// ------------------------------------------------------------------ 第三层：加密请求

/**
 * 云盘 SSO 的加密请求：请求体 AES-CBC（随机 IV，前置到 base64），
 * 响应也可能是加密的（base64，前 16 字节是 IV）。
 */
async function encryptedPost(url, bodyObject, headers, aesKeyHex) {
  const key = Buffer.from(aesKeyHex, 'hex')
  const plain = Buffer.from(sortedJsonStringify(bodyObject), 'utf8')
  const iv = randomBytes(16)
  const payload = Buffer.concat([iv, aesCbcEncrypt(plain, key, iv)]).toString('base64')

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`SSO 请求失败（HTTP ${response.status}）`)
  }
  const text = await response.text()
  if (!text) throw new Error('SSO 返回空响应')

  // 有时服务端直接回明文 JSON
  if (text.trimStart().startsWith('{')) return JSON.parse(text)

  let decoded
  try {
    decoded = Buffer.from(text, 'base64')
  } catch {
    throw new Error('SSO 响应不是合法 base64')
  }
  if (decoded.length < 16) throw new Error('SSO 响应过短')
  const respIv = decoded.subarray(0, 16)
  const respCipher = decoded.subarray(16)
  const json = aesCbcDecrypt(respCipher, key, respIv).toString('utf8')
  return JSON.parse(json)
}

// ------------------------------------------------------------------ 登录三步

/**
 * 第一步：邮箱账号密码登录，返回 { sid, cookies }
 * 风控（要求短信验证）会抛特定错误，调用方据此提示用户。
 */
async function mailPasswordLogin(account, password) {
  const cguid = String(Date.now())
  const hashedPassword = hashMailPassword(password)
  const encodedAccount = Buffer.from(String(account), 'utf8').toString('base64')

  const body = new URLSearchParams({
    UserName: String(account),
    passOld: '',
    auto: 'on',
    Password: hashedPassword,
    webIndexPagePwdLogin: '1',
    pwdType: '1',
    clientId: '1003',
    authType: '2',
  }).toString()

  const response = await fetch(MAIL_LOGIN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://mail.10086.cn',
      referer: `https://mail.10086.cn/default.html?&s=1&v=0&u=${encodedAccount}&m=1&ec=S001&resource=indexLogin&clientid=1003&auto=on&cguid=${cguid}&mtime=45`,
      'user-agent': UA_DESKTOP,
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : []
  const location = response.headers.get('location') || ''
  const cookies = allCookies(setCookie)

  // 风控：Location 里带风险码（MW0016 等），需要短信
  const riskMatch = /[?&]riskcode=([A-Za-z0-9]+)/i.exec(location) || /MW\d{4}/.exec(location)
  if (riskMatch) {
    const code = riskMatch[1] || riskMatch[0]
    const error = new Error('账号登录触发了安全验证，需要在手机或官网完成验证')
    error.code = 'MAIL_RISK'
    error.riskCode = code
    throw error
  }

  // 错误码判断（实测 139 邮箱的约定）：
  //   ec=S001 → 登录失败（账号或密码不正确）
  //   ec=S002 → 同样是凭据问题
  //   ec=S003 / S004 → 账号被限制或需要额外验证
  if (/[?&]ec=S00[12]\b/.test(location)) {
    const error = new Error('账号或密码不正确')
    error.code = 'BAD_CREDENTIALS'
    throw error
  }
  if (/[?&]ec=S00[34]\b/.test(location)) {
    const error = new Error('账号被限制或需要额外验证，请先到官网确认账号状态')
    error.code = 'ACCOUNT_BLOCKED'
    throw error
  }

  // 从 Location 的 query 或 cookie 里拿 sid
  let sid = ''
  const q = /\bsid=([^&]+)/.exec(location)
  if (q) sid = decodeURIComponent(q[1])
  if (!sid) sid = cookieValue(setCookie, 'Os_SSo_Sid') || cookieValue(setCookie, 'sid')

  if (!sid) {
    const error = new Error('登录未返回会话标识（sid），可能是账号格式不对或触发了风控')
    error.code = 'NO_SID'
    throw error
  }
  return { sid, cookies }
}

/** 第二步：用 sid 换 artifact（dycpwd） */
async function exchangeArtifact(sid, cookies) {
  const rmkey = (() => {
    for (const part of String(cookies).split(';')) {
      const t = part.trim()
      if (t.startsWith('RMKEY=')) return t
    }
    return ''
  })()
  if (!rmkey) {
    const error = new Error('登录会话缺少 RMKEY，无法换取凭据')
    error.code = 'NO_RMKEY'
    throw error
  }

  const url = `${MAIL_ARTIFACT_URL}?func=${encodeURIComponent('umc:getArtifact')}&sid=${encodeURIComponent(sid)}&cguid=${Date.now()}`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      cookie: rmkey,
      'content-type': 'text/xml; charset=utf-8',
      'accept-encoding': 'gzip',
      'user-agent': 'okhttp/4.12.0',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`换取凭据失败（HTTP ${response.status}）`)

  const text = await response.text()
  let artifact = ''
  try {
    artifact = JSON.parse(text)?.var?.artifact || ''
  } catch {
    artifact = ''
  }
  if (!artifact) {
    const error = new Error('换取凭据失败：响应里没有 artifact')
    error.code = 'NO_ARTIFACT'
    throw error
  }
  return artifact
}

/** 第三步：用 dycpwd 换 authToken，拼出 Authorization */
async function thirdPartyLogin(dycpwd, account) {
  const body = {
    clientkey_decrypt: 'l3TryM&Q+X7@dzwk)qP',
    clienttype: '886',
    cpid: '507',
    dycpwd,
    extInfo: { ifOpenAccount: '0' },
    loginMode: '0',
    msisdn: String(account),
    pintype: '13',
    secinfo: sha1Hex(`fetion.com.cn:${dycpwd}`).toUpperCase(),
    version: '20250901',
  }

  const headers = {
    'hcy-cool-flag': '1',
    'x-huawei-channelSrc': '10246600',
    'x-sdk-channelSrc': '',
    'x-MM-Source': '0',
    'x-UserAgent': 'android|23116PN5BC|android15|1.2.6|||1440x3200|10246600',
    'x-DeviceInfo': '4|127.0.0.1|5|1.2.6|Xiaomi|23116PN5BC||02-00-00-00-00-00|android 15|1440x3200|android|||',
    'content-type': 'text/plain;charset=UTF-8',
    'accept-encoding': 'gzip',
    'user-agent': 'okhttp/3.12.2',
  }

  // 第一层：AES-CBC 加密请求，响应解密后 data 是 hex 串
  const layer1 = await encryptedPost(YUN_THIRD_LOGIN_URL, body, headers, KEY_HEX_1)
  const hexInner = layer1?.data
  if (!hexInner || typeof hexInner !== 'string') {
    const error = new Error('SSO 登录失败：响应里没有 data')
    error.code = 'SSO_NO_DATA'
    throw error
  }

  // 第二层：hex → AES-ECB 解密
  const key2 = Buffer.from(KEY_HEX_2, 'hex')
  const finalJson = aesEcbDecrypt(Buffer.from(hexInner, 'hex'), key2).toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(finalJson)
  } catch {
    throw new Error('SSO 登录失败：二次解密结果不是 JSON')
  }

  const authToken = parsed?.authToken
  const realAccount = parsed?.account || String(account)
  const userDomainId = parsed?.userDomainId || ''
  if (!authToken) {
    const error = new Error('SSO 登录失败：没有拿到 authToken')
    error.code = 'NO_AUTH_TOKEN'
    throw error
  }

  const authorization = Buffer.from(`pc:${realAccount}:${authToken}`, 'utf8').toString('base64')
  return { authorization, account: realAccount, userDomainId }
}

/**
 * 完整登录：手机号 + 密码 → Authorization。
 * 不写盘、不留密码；密码只在这个函数的作用域里存活。
 */
export async function loginWithPassword(account, password) {
  const cleanAccount = String(account || '').trim()
  const cleanPassword = String(password || '')
  if (!cleanAccount) throw new Error('请填写手机号或邮箱')
  if (!cleanPassword) throw new Error('请填写密码')

  const { sid, cookies } = await mailPasswordLogin(cleanAccount, cleanPassword)
  const artifact = await exchangeArtifact(sid, cookies)
  return thirdPartyLogin(artifact, cleanAccount)
}

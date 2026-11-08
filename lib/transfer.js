/**
 * dsh-mcloud — 传输层（纯函数，不碰鉴权也不碰 DSH）
 *
 * 移动云盘的上传是标准的「建任务 → 分片 PUT → complete」三段式，
 * 两个独立实现（OpenList 的 Go 驱动、cloud_driver_sdk 的 Python SDK）流程一致：
 *
 *   1. POST {host}/file/create   带整文件 SHA256 + 全部分片信息
 *        → 命中秒传（exist / rapidUpload）就直接结束
 *        → 否则给回 fileId、uploadId 和前 100 个分片的 uploadUrl
 *   2. PUT 每个 uploadUrl，body 是该分片的原始字节（按 partOffset/partSize 从文件里切）
 *   3. POST {host}/file/complete
 *
 * 这里只负责：算哈希、切分片、把一段字节流式 PUT 上去、边传边报进度。
 */

import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import http from 'node:http'
import https from 'node:https'

export const MB = 1024 * 1024

/** 分片大小：跟 OpenList 一致，>30GB 才放大到 512MB */
export const PART_SIZE_DEFAULT = 100 * MB
export const PART_SIZE_LARGE = 512 * MB
/** 服务端一次最多接受/返回 100 个分片 */
export const PART_BATCH = 100

export const UPLOAD_CONTENT_TYPE = 'application/octet-stream'

export function partSizeFor(size) {
  return size > 30 * 1024 * MB ? PART_SIZE_LARGE : PART_SIZE_DEFAULT
}

/** 按文件大小切出 partInfos（就是发给 /file/create 的那个数组） */
export function buildPartInfos(size, partSize) {
  if (size <= 0) {
    // 空文件：给一个 0 长分片，服务端只认任务本身
    return [{ partNumber: 1, partSize: 0, parallelHashCtx: { partOffset: 0 } }]
  }
  const count = Math.ceil(size / partSize)
  const list = []
  for (let index = 0; index < count; index += 1) {
    const offset = index * partSize
    list.push({
      partNumber: index + 1,
      partSize: Math.min(partSize, size - offset),
      parallelHashCtx: { partOffset: offset },
    })
  }
  return list
}

/** 流式算整文件 SHA256，返回小写 hex（大文件也不会吃内存） */
export function sha256File(filePath) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const source = createReadStream(filePath)
    source.on('error', rejectHash)
    source.on('data', (chunk) => hash.update(chunk))
    source.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/**
 * 把文件的一段 [start, end]（闭区间）流式 PUT 到分片地址。
 * 刻意不把分片读进内存 —— 分片可能是 512MB。
 */
export function putRange(urlString, filePath, start, end, onBytes, signal) {
  return new Promise((resolvePut, rejectPut) => {
    let target
    try {
      target = new URL(urlString)
    } catch {
      rejectPut(new Error(`服务端给的分片地址不合法：${String(urlString).slice(0, 120)}`))
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      rejectPut(new Error(`分片地址协议不支持：${target.protocol}`))
      return
    }

    const length = end - start + 1
    const transport = target.protocol === 'http:' ? http : https
    const request = transport.request(
      {
        method: 'PUT',
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        headers: {
          'content-type': UPLOAD_CONTENT_TYPE,
          'content-length': String(length),
          origin: 'https://yun.139.com',
          referer: 'https://yun.139.com/',
        },
        signal,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          if (response.statusCode === 200) {
            resolvePut()
            return
          }
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 300)
          rejectPut(new Error(`分片上传失败 HTTP ${response.statusCode}：${body}`))
        })
      },
    )

    request.on('error', rejectPut)

    const source = createReadStream(filePath, { start, end })
    source.on('error', rejectPut)

    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          onBytes?.(chunk.length)
        } catch {
          /* 进度回调不该影响传输本身 */
        }
        callback(null, chunk)
      },
    })

    source.pipe(counter).pipe(request)
  })
}

/**
 * 把一段 web 响应体流式写进本地文件。
 * 先写 `<path>.part-xxxx` 再原子改名 —— 失败（含取消）时不会留半个文件冒充成品。
 */
export async function streamToFile(webBody, localPath, onBytes, signal) {
  mkdirSync(dirname(localPath), { recursive: true })
  const temporary = `${localPath}.part-${Math.random().toString(16).slice(2, 10)}`
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        onBytes?.(chunk.length)
      } catch {
        /* 进度回调不该影响传输本身 */
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(webBody), counter, createWriteStream(temporary), { signal })
    renameSync(temporary, localPath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return localPath
}

/**
 * 把一批「服务端返回的分片地址」对应到我们自己的 partInfos 上依次传完。
 * 顺序按 partNumber 排，这样进度条是单调的。
 */
export async function putParts(partInfos, uploadPartInfos, filePath, onBytes, signal, onPart) {
  const list = [...(uploadPartInfos ?? [])].sort(
    (a, b) => Number(a?.partNumber ?? 0) - Number(b?.partNumber ?? 0),
  )
  for (const item of list) {
    const partNumber = Number(item?.partNumber ?? 0)
    const info = partInfos[partNumber - 1]
    if (!info) throw new Error(`服务端返回了越界的分片号 ${partNumber}`)
    if (!item?.uploadUrl) continue
    const size = Number(info.partSize ?? 0)
    if (size <= 0) continue
    const start = Number(info.parallelHashCtx?.partOffset ?? 0)
    await putRange(item.uploadUrl, filePath, start, start + size - 1, onBytes, signal)
    onPart?.(partNumber)
  }
}

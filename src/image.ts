// 取图：命令参数 / 被引用的消息 / 当前消息里的图片 → bytes + mimeType。
import fs from 'node:fs'
import path from 'node:path'
import type { Context, Session } from 'koishi'
import { looksLikeImageBuffer, safeFetchBuffer } from './safe-fetch'

export interface ImageInput {
  bytes: Buffer
  mimeType: string
  /** 图的公网地址（QQ 图链、命令里直接给的网址）。有它 SerpApi 才能自己抓图。 */
  url?: string
}
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 按文件头认格式，不信扩展名 —— 有人把 png 存成 .jpg，反查接口会直接拒。 */
export function sniffMime(bytes: Buffer): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes.length > 12 && bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  return 'image/jpeg'
}

export async function imageFromUrl(input: string): Promise<ImageInput> {
  const url = String(input ?? '').trim()
  if (/^https?:\/\//i.test(url)) {
    // http(s) → safeFetchBuffer（SSRF 防护；这些 URL 来自用户/LLM）
    const got = await safeFetchBuffer(url, MAX_IMAGE_BYTES)
    return { bytes: got.buffer, mimeType: sniffMime(got.buffer), url }
  }
  if (/^base64:\/\//i.test(url)) {
    const bytes = Buffer.from(url.slice(9), 'base64')
    return { bytes, mimeType: sniffMime(bytes) }
  }
  const dataUrl = url.match(/^data:image\/[^;,]+;base64,([\s\S]+)$/i)
  if (dataUrl) {
    const bytes = Buffer.from(dataUrl[1].replace(/\s+/g, ''), 'base64')
    return { bytes, mimeType: sniffMime(bytes) }
  }
  throw new Error('只支持 http(s) 图片地址或 base64 图片')
}

/**
 * 本机文件路径取图 —— 只给 ChatLuna 工具用（agent 本来就有文件权限，不增加攻击面），
 * 「找鸡」命令不走这条路：普通用户给个路径就能读服务器任意文件，那是漏洞。
 */
export async function imageFromPath(input: string, baseDir: string): Promise<ImageInput> {
  let file = String(input ?? '').trim()
  const fileUrl = file.match(/^file:\/\/+(.+)$/i)
  if (fileUrl) file = decodeURIComponent(fileUrl[1])
  const resolved = path.isAbsolute(file) ? file : path.resolve(baseDir, file)
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new Error(`本机没有这个文件：${file}`)
  }
  if (!stat.isFile()) throw new Error('那个路径不是文件')
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`图太大了（${(stat.size / 1024 / 1024).toFixed(1)}MB，上限 20MB）`)
  }
  const bytes = fs.readFileSync(resolved)
  if (!bytes.length || !looksLikeImageBuffer(bytes)) throw new Error('那个文件不是图片')
  return { bytes, mimeType: sniffMime(bytes) }
}

interface MessageElement {
  type?: string
  attrs?: Record<string, any>
  children?: MessageElement[]
}

/** 从消息元素里找第一个图片（'img' / 'image'，含嵌套），返回它的地址。 */
function firstImageSrc(elements: readonly MessageElement[] | undefined): string {
  for (const element of elements ?? []) {
    if (!element) continue
    if (element.type === 'img' || element.type === 'image') {
      const src = String(element.attrs?.src || element.attrs?.url || element.attrs?.file || '')
      if (src) return src
    }
    const nested = firstImageSrc(element.children)
    if (nested) return nested
  }
  return ''
}

/** 拿被引用的那条消息里的图；没有引用就看本条消息自己有没有图。 */
export async function imageFromSession(ctx: Context, session: Session): Promise<ImageInput | null> {
  const logger = ctx.logger('bitchfinder')
  let quoteElements = session.quote?.elements as MessageElement[] | undefined
  if (session.quote && !quoteElements?.length) {
    const messageId = String(session.quote.id ?? session.quote.messageId ?? '')
    if (messageId) {
      try {
        const message = await session.bot.getMessage(session.channelId!, messageId)
        quoteElements = message?.elements as MessageElement[] | undefined
      } catch (error) {
        logger.warn('取被引用的消息失败：%s', (error as Error)?.message ?? error)
      }
    }
  }
  const src = firstImageSrc(quoteElements) || firstImageSrc(session.elements as unknown as MessageElement[] | undefined)
  if (!src) return null
  let bytes: Buffer
  let mime = ''
  if (src.startsWith('base64://')) {
    bytes = Buffer.from(src.slice(9), 'base64')
  } else {
    const file = await ctx.http.file(src)
    bytes = Buffer.from(file.data)
    mime = String(file.type ?? (file as any).mime ?? '')
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`图太大了（${(bytes.length / 1024 / 1024).toFixed(1)}MB，上限 20MB）`)
  }
  if (!looksLikeImageBuffer(bytes) && !/^image\//.test(mime)) {
    throw new Error(`那个地址不是图片（${mime}）`)
  }
  return { bytes, mimeType: sniffMime(bytes), url: /^https?:\/\//i.test(src) ? src : undefined }
}

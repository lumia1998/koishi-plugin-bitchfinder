// 取图：命令参数 / 被引用的消息 / 当前消息里的图片 → bytes + mimeType。
import type { Context, Session } from 'koishi'
import { looksLikeImageBuffer, safeFetchBuffer } from './safe-fetch'

export interface ImageInput { bytes: Buffer; mimeType: string }
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
    return { bytes: got.buffer, mimeType: sniffMime(got.buffer) }
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
  return { bytes, mimeType: sniffMime(bytes) }
}

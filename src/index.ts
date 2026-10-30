/**
 * koishi-plugin-bitchfinder
 *
 * 多引擎图片反向检索，定位图片最可能的原始出处与作者。
 * 移植自 vmoranv/astrbot_plugin_bitchfinder（AstrBot 插件）。
 *
 * 两种使用方式：
 * - 聊天命令「找鸡」/「kfc」：附带或回复一张图片；
 * - ChatLuna 工具 `findbitch`：由大模型在对话中按需调用，
 *   模型与 API Key 全部由 chatluna 插件管理，本插件不保存任何 LLM 凭据。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { DynamicStructuredTool } from '@langchain/core/tools'
import { Context, Schema, h, Session } from 'koishi'
import { z } from 'zod'

import { HttpClient } from './http'
import { reverseSearch, SearchConfig, SearchDeps } from './search'
import { EngineError } from './types'

export const name = 'bitchfinder'

export const inject = {
  required: [],
  optional: ['chatluna'],
}

export interface Config {
  maxResults: number
  timeout: number
  proxy: string
  saucenaoApiKey: string
  gcvApiKey: string
  ascii2dCookie: string
  serpapiApiKey: string
  serpapiVisualMatches: boolean
  baiduEnabled: boolean
  copyseekerEnabled: boolean
  useLlmCandidates: boolean
  model: string
  followerTiebreak: boolean
  sendAsForward: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    maxResults: Schema.number()
      .min(1)
      .max(20)
      .default(8)
      .description('输出的候选/出处数量上限。'),
    timeout: Schema.number()
      .min(5)
      .max(120)
      .default(20)
      .description('单个引擎请求的超时时间（秒）。'),
    proxy: Schema.string()
      .default('')
      .description('HTTP 代理地址，例如 `http://127.0.0.1:7890`；留空为直连。'),
    sendAsForward: Schema.boolean()
      .default(true)
      .description('以合并转发消息发送结果（部分适配器不支持，失败时自动回退为普通消息）。'),
  }).description('基础设置'),
  Schema.object({
    saucenaoApiKey: Schema.string()
      .role('secret')
      .default('')
      .description('SauceNAO API Key，[免费申请](https://saucenao.com/user.php?page=search-api)，100 次/天。强烈建议配置。'),
    gcvApiKey: Schema.string()
      .role('secret')
      .default('')
      .description('Google Cloud Vision API Key（启用 WEB_DETECTION，付费）。'),
    serpapiApiKey: Schema.string()
      .role('secret')
      .default('')
      .description('SerpApi API Key，用于 Google Lens exact_matches（付费）。'),
    ascii2dCookie: Schema.string()
      .role('secret')
      .default('')
      .description('ascii2d 的 Cloudflare `cf_clearance` cookie；不填则 ascii2d 大概率被拦截。'),
  }).description('搜索引擎凭据'),
  Schema.object({
    serpapiVisualMatches: Schema.boolean()
      .default(false)
      .description('Google Lens 同时查询 visual_matches（相似图，线索噪声较多）。'),
    baiduEnabled: Schema.boolean()
      .default(false)
      .description('启用百度识图（线索级，中文/国内图源可能有帮助）。'),
    copyseekerEnabled: Schema.boolean()
      .default(false)
      .description('启用 Copyseeker（线索级，轮询较慢，约需 3-18 秒）。'),
  }).description('额外引擎'),
  Schema.object({
    followerTiebreak: Schema.boolean()
      .default(true)
      .description('最优先两名候选置信度并列且均为 X 账号时，取粉丝数较多者（fxTwitter 公开接口）。'),
    useLlmCandidates: Schema.boolean()
      .default(true)
      .description('无可靠署名时，调用 ChatLuna 模型从来源文字中提取账号线索（需在下方选择模型）。'),
    model: Schema.dynamic('model')
      .description('用于文字候选解析的 ChatLuna 模型；留空则不启用 LLM 兜底。'),
  }).description('ChatLuna / LLM'),
])

function createSearchConfig(config: Config): SearchConfig {
  return {
    maxResults: config.maxResults,
    timeout: config.timeout,
    proxy: config.proxy,
    saucenaoApiKey: config.saucenaoApiKey,
    gcvApiKey: config.gcvApiKey,
    ascii2dCookie: config.ascii2dCookie,
    serpapiApiKey: config.serpapiApiKey,
    serpapiVisualMatches: config.serpapiVisualMatches,
    baiduEnabled: config.baiduEnabled,
    copyseekerEnabled: config.copyseekerEnabled,
    useLlmCandidates: config.useLlmCandidates,
    followerTiebreak: config.followerTiebreak,
  }
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 把消息元素里的图片 src 转为 Buffer；不支持的来源返回 null。 */
async function loadImageSource(
  http: HttpClient,
  src: string,
): Promise<Buffer | null> {
  if (!src) return null
  try {
    if (src.startsWith('base64://')) {
      return Buffer.from(src.slice('base64://'.length), 'base64')
    }
    if (src.startsWith('data:')) {
      const comma = src.indexOf(',')
      if (comma === -1) return null
      const meta = src.slice(5, comma)
      const payload = src.slice(comma + 1)
      return meta.includes('base64')
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'binary')
    }
    if (src.startsWith('file://')) {
      return await readFile(fileURLToPath(src))
    }
    let url = src
    if (url.startsWith('//')) url = 'https:' + url
    if (!/^https?:\/\//i.test(url)) return null
    const data = await http.getBuffer(url, { timeout: 30 })
    return data.length > MAX_IMAGE_BYTES ? null : data
  } catch {
    return null
  }
}

function imageElementsOf(session: Session): any[] {
  const elements: any[] = []
  const quote = (session as any).quote
  if (quote?.elements?.length) elements.push(...quote.elements)
  if (session.elements?.length) elements.push(...session.elements)
  return elements.filter(
    (el) => el?.type === 'img' || el?.type === 'image',
  )
}

/** 依次尝试消息内/引用消息内的图片，返回第一张可读图片。 */
async function imageFromSession(
  http: HttpClient,
  session: Session,
): Promise<Buffer | null> {
  for (const el of imageElementsOf(session)) {
    const src = String(el?.attrs?.src || el?.attrs?.url || el?.attrs?.file || '')
    const data = await loadImageSource(http, src)
    if (data) return data
  }
  return null
}

/** ChatLuna 工具：由模型决定何时调用，图片可来自参数或当前会话。 */
function createFindBitchTool(
  ctx: Context,
  config: Config,
  http: HttpClient,
  deps: SearchDeps,
) {
  const schema = z.object({
    image_url: z
      .string()
      .optional()
      .describe(
        '要反查的图片 URL 或 base64:// 数据；用户在当前消息/引用中已发图时可省略。',
      ),
  })

  const toolConfig: any = {
    name: 'findbitch',
    description:
      'Reverse image search: find the most likely original author and source page of an image. ' +
      'Use it when the user asks who is in a picture, where a picture comes from, or asks to ' +
      '"find the source/author" of an image. The image is taken from image_url, or from the ' +
      'current chat message / quoted message if image_url is omitted. Returns a ranked list of ' +
      'candidate accounts with confidence and evidence links.',
    schema,
    func: async (input: { image_url?: string }, _runManager: any, runnable: any) => {
      try {
        const session: Session | undefined =
          runnable?.configurable?.session ||
          _runManager?.configurable?.session
        let image: Buffer | null = null
        if (input?.image_url) {
          image = await loadImageSource(http, input.image_url)
        }
        if (!image && session) {
          image = await imageFromSession(http, session)
        }
        if (!image) {
          return '没有取到图片：请在参数中提供 image_url，或在当前消息/引用中附带图片。'
        }
        return await reverseSearch(image, createSearchConfig(config), deps)
      } catch (err) {
        ctx.logger.warn('findbitch 工具失败: %s', err)
        return `反查失败：${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
  return new DynamicStructuredTool(toolConfig)
}

export function apply(ctx: Context, config: Config) {
  const http = new HttpClient(config.proxy, config.timeout)
  const logger = ctx.logger('bitchfinder')

  // ChatLuna 模型由 chatluna 插件创建和管理，本插件只持有引用。
  let modelRef: any
  const deps: SearchDeps = {
    http,
    log: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
    getModel: () => modelRef?.value,
  }

  ctx.command('找鸡', '多引擎反查图片出处与作者')
    .alias('kfc')
    .usage(
      '附带一张图片发送「找鸡」，或回复一张图片后发送「找鸡」。\n' +
        '会用 Yandex / SauceNAO / ascii2d / Google 等引擎检索，并按证据强度给出作者候选。',
    )
    .example('找鸡（附图）')
    .action(async ({ session }) => {
      if (!session) return
      const image = await imageFromSession(http, session)
      if (!image) {
        return '请附带一张图片，或回复一张图片后发送「找鸡」。'
      }
      await session.send('正在多引擎检索，请稍候…')
      let text: string
      try {
        text = await reverseSearch(image, createSearchConfig(config), deps)
      } catch (err) {
        logger.warn(err)
        return `反查失败：${err instanceof Error ? err.message : String(err)}`
      }
      if (config.sendAsForward) {
        try {
          await session.send(h('message', { forward: true }, [h('text', text)]))
          return
        } catch (err) {
          logger.warn('合并转发发送失败，回退为普通消息: %s', err)
        }
      }
      return text
    })

  // 注册为 ChatLuna 工具；chatluna 未安装时静默跳过。
  ctx.inject(['chatluna'], (ctx) => {
    const chatluna = (ctx as any).chatluna
    const dispose = chatluna.platform.registerTool('findbitch', {
      selector: () => true,
      authorization: (session: any) => !!session,
      description:
        'Reverse image search: find the original author and source of an image.',
      meta: {
        source: 'extension',
        group: 'bitchfinder',
        tags: ['image', 'search', 'reverse-image-search'],
        defaultAvailability: {
          enabled: true,
          main: true,
          chatluna: true,
          characterScope: 'all',
        },
      },
      createTool: () => createFindBitchTool(ctx, config, http, deps),
    })
    if (typeof dispose === 'function') ctx.on('dispose', dispose)

    if (config.useLlmCandidates && config.model) {
      chatluna
        .createChatModel(config.model)
        .then((ref: any) => {
          modelRef = ref
        })
        .catch((err: unknown) => {
          logger.warn('加载 ChatLuna 模型失败（LLM 兜底已禁用）: %s', err)
        })
    }
  })
}

declare module 'koishi' {
  interface Context {
    chatluna: any
  }
}

// 导出给单元测试/二次开发使用
export { reverseSearch } from './search'
export type { Config as BitchfinderConfig }
export { EngineError }

// ChatLuna 工具 findbitch：让模型按需反查图片。
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { Context, Logger, Session } from 'koishi'
import { z } from 'zod'
import type { Account } from './accounts'
import { imageFromPath, imageFromSession, imageFromUrl } from './image'
import type { ImageInput } from './image'

export interface FindBitchToolDeps {
  logger: Logger
  findChicken(image: ImageInput): Promise<{ text: string; accounts: Account[] }>
  lastUse: Map<string, number>
  gap: number
  keyOf(session: Session): string
}

export function createFindBitchTool(ctx: Context, deps: FindBitchToolDeps) {
  const { logger, findChicken, lastUse, gap, keyOf } = deps
  return new DynamicStructuredTool({
    name: 'findbitch',
    description: 'Reverse image search for cosplay / real-person photos (Google Lens / SauceNAO / trace.moe): find which coser is in a picture and their social accounts (Twitter/X, Weibo, Bilibili, Instagram, Pixiv). Use it when the user asks who is in a picture or where a picture comes from. The image is taken from image_url, or from the current chat message / quoted message if image_url is omitted. Returns platform / name / account lines, or explains why nothing was found.',
    schema: z.object({
      image_url: z.string().optional().describe('要反查的图片：公网 http(s) URL（内网/127.x/10.x 地址会被安全策略拒绝）、base64:// 数据、或本机文件路径（如 /tmp/x.png）；用户在当前消息/引用中已发图时可省略。')
    }),
    func: async (input: any, _runManager: any, runnable: any) => {
      try {
        const session = runnable?.configurable?.session || _runManager?.configurable?.session
        // 冷却：同一个人别刷 —— 反查引擎有免费额度，刷爆了大家都不能用。
        if (session) {
          const key = keyOf(session)
          const now = Date.now()
          const last = lastUse.get(key) ?? 0
          if (gap && now - last < gap) {
            return `刚查过，${Math.ceil((gap - (now - last)) / 1000)} 秒后再试`
          }
        }
        const arg = String(input?.image_url ?? '').trim()
        const image = arg
          ? (/^(https?:\/\/|base64:\/\/|data:image\/)/i.test(arg)
            ? await imageFromUrl(arg)
            : await imageFromPath(arg, ctx.baseDir))
          : (session ? await imageFromSession(ctx, session as Session) : null)
        if (!image) return '没有取到图片：请在参数中提供 image_url，或在当前消息/引用中附带图片。'
        if (session) lastUse.set(keyOf(session), Date.now())
        return (await findChicken(image)).text
      } catch (error) {
        logger.warn('findbitch 工具失败: %s', (error as Error)?.stack ?? error)
        return `反查失败：${(error as Error)?.message ?? error}`
      }
    }
  } as any)
}

export function registerFindBitchTool(ctx: Context, deps: FindBitchToolDeps) {
  const chatluna = (ctx as any).chatluna
  const dispose = chatluna.platform.registerTool('findbitch', {
    selector: () => true,
    authorization: (session: any) => !!session,
    description: 'Reverse image search: find the original author and source of an image.',
    meta: {
      source: 'extension',
      group: 'bitchfinder',
      tags: ['image', 'search', 'reverse-image-search'],
      defaultAvailability: { enabled: true, main: true, chatluna: true, characterScope: 'all' },
    },
    createTool: () => createFindBitchTool(ctx, deps),
  })
  if (typeof dispose === 'function') ctx.on('dispose', dispose)
}

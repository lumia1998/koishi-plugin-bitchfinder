// ChatLuna 工具 checkbitch：让模型按需鉴定 X 账号可信度。
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { Context, Logger, Session } from 'koishi'
import { z } from 'zod'
import { formatReport } from './format'
import type { Verifier } from './service'

export interface CheckBitchToolDeps {
  logger: Logger
  verifier: Verifier
}

export function createCheckBitchTool(deps: CheckBitchToolDeps) {
  const { logger, verifier } = deps
  return new DynamicStructuredTool({
    name: 'checkbitch',
    description: 'Check the credibility of an X/Twitter account: searches X for the profile and third-party reviews, then returns a 0-200 trust score, tags (风俗业者 / 可线下 / 有门槛费 / AV女优 / 福利博主), complaints, risk flags (stolen photos / fake gender / scam / impersonation) and a short Chinese summary. Use it when the user asks whether an X account is real, trustworthy, a scam, or asks to 鉴定 / 查账号.',
    schema: z.object({
      username: z.string().describe('X/Twitter 用户名，可带 @，也可以是 https://x.com/xxx 链接。')
    }),
    func: async (input: any, _runManager: any, runnable: any) => {
      try {
        const session = (runnable?.configurable?.session || _runManager?.configurable?.session) as Session | undefined
        const key = session ? `${session.platform}:${session.channelId}|${session.userId}|check` : undefined
        const outcome = await verifier.check(String(input?.username ?? ''), key)
        return formatReport(outcome.row, { cached: outcome.cached, stale: outcome.stale })
      } catch (error) {
        logger.warn('checkbitch 工具失败: %s', (error as Error)?.stack ?? error)
        return `鉴定失败：${(error as Error)?.message ?? error}`
      }
    }
  } as any)
}

export function registerCheckBitchTool(ctx: Context, deps: CheckBitchToolDeps) {
  const chatluna = (ctx as any).chatluna
  const dispose = chatluna.platform.registerTool('checkbitch', {
    selector: () => true,
    authorization: (session: any) => !!session,
    description: 'Check the credibility / risk of an X (Twitter) account.',
    meta: {
      source: 'extension',
      group: 'bitchfinder',
      tags: ['x', 'twitter', 'trust', 'scam-check'],
      defaultAvailability: { enabled: true, main: true, chatluna: true, characterScope: 'all' },
    },
    createTool: () => createCheckBitchTool(deps),
  })
  if (typeof dispose === 'function') ctx.on('dispose', dispose)
}

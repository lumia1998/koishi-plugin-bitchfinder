// 鱼鱼找鸡 Koishi 版：被引图片 → 反查来源 → 抽 coser 社媒账号 → 回一句话（有账号时顺带「已找到鸡」图）。
import { Context, Schema, Session, h } from 'koishi'
import type {} from 'koishi-plugin-puppeteer'
import fs from 'node:fs'
import path from 'node:path'
import { extractAccounts, formatReply } from './accounts'
import type { Account } from './accounts'
import { FishBrowser } from './browser'
import { reverseSearch } from './engines'
import type { EngineId } from './engines'
import { imageFromSession, imageFromUrl, sniffMime } from './image'
import type { ImageInput } from './image'
import { registerFindBitchTool } from './tool'
import { sleep } from './utils'

export const name = 'bitchfinder'
export const inject = { required: ['puppeteer'], optional: ['chatluna'] }

export const usage = `给一张图，反查这人是哪个 coser、账号在哪（移植自 鱼鱼找鸡 v1.0.0）。

需要 puppeteer 服务（谷歌 Lens / 百度识图用浏览器跑）。

用法：引用一张图发「找鸡」（或带图发）。

反查必须把图发给引擎（谷歌 / SauceNAO / trace.moe …），不想上传就别用。`

export interface Config {
  engines: EngineId[]
  serpapiKey: string
  timeoutMs: number
  maxAccounts: number
  strictConsensus: boolean
  proxy: string
  foundImage: string
  cooldownSec: number
  registerTool: boolean
}

export const Config: Schema<Config> = Schema.object({
  engines: Schema.array(Schema.union([
    Schema.const('lens').description('谷歌 Lens（最准，能抓到推特主页；要能访问谷歌）'),
    Schema.const('saucenao').description('SauceNAO（动漫/同人，直连，免费有频率限制）'),
    Schema.const('tracemoe').description('trace.moe（动漫截屏溯源，直连）'),
    Schema.const('iqdb').description('IQDB（动漫图库，直连，常排队）'),
    Schema.const('baidu').description('百度识图（很慢）'),
  ])).role('checkbox').default(['lens']).description('用哪些引擎。Lens 和百度走 puppeteer 浏览器，其余直接 HTTP。默认只开 Lens：真人/coser 图靠它最准；SauceNAO/trace.moe/IQDB 只认动漫图，真人照片只会返回「看着像」的画作。'),
  serpapiKey: Schema.string().role('secret').default('').description('可选：SerpApi 的 Google Lens key（付费 API，免费档每月 100 次）。填了且图片有公网地址时，Lens 走 SerpApi 不依赖能连谷歌的浏览器；失败自动回退浏览器 Lens。base64/本地图没有公网地址，只能走浏览器。'),
  timeoutMs: Schema.natural().role('ms').default(45000).description('单个引擎的超时（Lens/百度至少按 30 秒算）。'),
  maxAccounts: Schema.natural().min(1).default(3).description('最多报几个账号。'),
  strictConsensus: Schema.boolean().default(true).description('开 = 名字对不上的别人的号不报（少报不错报）；关 = 全都报出来自己挑。'),
  proxy: Schema.string().default('').description('只让本插件的浏览器页面走这个代理（例如 http://127.0.0.1:7890）。留空 = 跟随 puppeteer 插件（它会自动使用 Koishi 全局代理）。'),
  foundImage: Schema.string().default('').description('查到账号时顺带发的图（本机文件路径，相对路径按 Koishi 根目录算，比如一张「找到了」的表情包）。留空 = 不发图。'),
  cooldownSec: Schema.natural().default(30).description('同一个人在同一个会话里的冷却秒数（反查引擎有免费额度，刷爆了大家都不能用）。0 = 不限。'),
  registerTool: Schema.boolean().default(true).description('装了 ChatLuna 时注册工具 findbitch，让模型按需反查。'),
})

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('bitchfinder')
  const browser = new FishBrowser(ctx, { proxy: config.proxy })
  ctx.on('dispose', () => browser.dispose())

  // 冷却：同一个人 30 秒内别刷 —— 反查引擎有免费额度，刷爆了大家都不能用。
  const lastUse = new Map<string, number>()
  const gap = Math.max(0, Number(config.cooldownSec) || 0) * 1000
  const keyOf = (session: Session) => `${session.platform}:${session.channelId}|${session.userId}`

  const findChicken = async (image: ImageInput): Promise<{ text: string; accounts: Account[] }> => {
    const result = await reverseSearch(image.bytes, image.mimeType, {
      engines: config.engines,
      timeoutMs: config.timeoutMs,
      browser,
      lensUrl: image.url,
      serpapiKey: config.serpapiKey,
      onLog: (line) => logger.info(line)
    })
    const accounts = extractAccounts(result.candidates, { max: config.maxAccounts, strictNames: config.strictConsensus !== false })
    const text = formatReply({
      accounts,
      candidates: result.candidates,
      enginesUsed: result.enginesUsed,
      failures: result.failures
    }).replace(/\*\*/g, '') // QQ 不渲染 markdown（同原版 README 的样例）
    return { text, accounts }
  }

  /** 「已找到鸡」素材：读得到、没超限才返回 Buffer，否则 null（调用方只发文字）。 */
  const loadFoundImage = (): Buffer | null => {
    const file = String(config.foundImage ?? '')
    if (!file) return null
    const cap = 4 * 1024 * 1024
    try {
      const resolved = path.isAbsolute(file) ? file : path.resolve(ctx.baseDir, file)
      const stat = fs.statSync(resolved)
      if (!stat.isFile() || stat.size === 0 || stat.size > cap) return null
      const buffer = fs.readFileSync(resolved)
      return buffer?.length ? buffer : null
    } catch {
      return null
    }
  }

  ctx.command('找鸡 [url:text]', '给一张图，反查这人是哪个 coser、账号在哪')
    .usage('引用一张图发「找鸡」，或者带图发「找鸡」，也可以「找鸡 <图片网址>」。')
    .action(async ({ session }, url) => {
      if (!session) return
      const key = keyOf(session)
      const now = Date.now()
      const last = lastUse.get(key) ?? 0
      if (gap && now - last < gap) {
        return `刚查过，${Math.ceil((gap - (now - last)) / 1000)} 秒后再试`
      }
      let image: ImageInput | null = null
      try {
        const arg = String(url ?? '').trim()
        if (/^(https?:\/\/|base64:\/\/|data:image\/)/i.test(arg)) {
          image = await imageFromUrl(arg)
        } else {
          image = await imageFromSession(ctx, session)
        }
      } catch (error) {
        return h.text(`取图失败：${(error as Error)?.message ?? error}`)
      }
      if (!image) return '要引用有图的那条再发「找鸡」'
      lastUse.set(key, Date.now())
      await session.send('收到，开始找鸡')
      let text: string
      let accounts: Account[]
      try {
        ({ text, accounts } = await findChicken(image))
      } catch (error) {
        logger.warn('找鸡失败：%s', (error as Error)?.stack ?? error)
        return h.text(`找鸡失败：${(error as Error)?.message ?? error}`)
      }
      // 有账号、又有「已找到」图：图+文一条发出去（一条比两条稳）。
      const found = accounts.length ? loadFoundImage() : null
      if (found) {
        let ids: string[] | undefined
        try { ids = await session.send([h.image(found, sniffMime(found)), h.text(text)]) } catch { ids = undefined }
        if (!ids?.length) {
          logger.warn('图文混排被拒，改成两条')
          try { await session.send(h.image(found, sniffMime(found))) } catch {}
          await sleep(400)
        } else {
          return
        }
      }
      return h.text(text)
    })

  ctx.inject(['chatluna'], (ctx) => {
    if (!config.registerTool) return
    registerFindBitchTool(ctx, { logger, findChicken, lastUse, gap, keyOf })
  })
}

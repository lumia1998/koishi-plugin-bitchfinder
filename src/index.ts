// 找鸡 + 鉴定 + 烧鸡榜 Koishi 插件：图片反查社媒账号，用户名鉴定 X 账号可信度。
// 另带 X 账号鉴定（xAI x_search）与烧鸡榜。
import { Context, Schema, Session, h } from 'koishi'
import type {} from 'koishi-plugin-puppeteer'
import fs from 'node:fs'
import path from 'node:path'
import { extractAccounts, formatReply } from './accounts'
import type { Account } from './accounts'
import { FishBrowser } from './browser'
import { buildRankForward, formatRankText, formatReport } from './check/format'
import type { RankGroup } from './check/format'
import { buildRank, RANK_CATEGORIES, resolveCategory } from './check/rank'
import { RankFetcher } from './check/remote'
import { parseCheckTarget, UserError, Verifier } from './check/service'
import { AccountStore, defineModel } from './check/store'
import { registerCheckBitchTool } from './check/tool'
import { reverseSearch } from './engines'
import type { EngineId } from './engines'
import { imageFromSession, imageFromUrl, sniffMime } from './image'
import type { ImageInput } from './image'
import { registerFindBitchTool } from './tool'
import { sleep } from './utils'

export const name = 'bitchfinder'
export const inject = { required: ['puppeteer'], optional: ['chatluna', 'database'] }

export const usage = `根据图片和用户名找鸡和鉴别鸡：给一张图反查 coser/博主的社媒账号；给一个 X 用户名鉴定真实度和风险。

需要 puppeteer 服务（谷歌 Lens / 百度识图用浏览器跑）。

用法：
· 引用一张图发「找鸡」（或带图发）
· 发「鉴定 @用户名」查 X 账号可信度（需要 xAI API Key）
· 发「烧鸡榜」看 flj.info 排行榜（连不上时用本机记录）

反查必须把图发给引擎（谷歌 / SauceNAO / trace.moe …），不想上传就别用。
鉴定会把用户名发给 xAI，由它去 X 上搜公开资料和他人评价。`

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
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  aiTimeoutMs: number
  cacheHours: number
  checkCooldownSec: number
  checkDailyLimit: number
  rankSize: number
  rankApiBase: string
  checkHint: boolean
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
  aiBaseUrl: Schema.string().default('https://api.x.ai/v1').description('xAI API 地址，默认官方地址。只支持 xAI：鉴定靠 x_search 去 X 上搜实时资料，换别家模型不成立。'),
  aiApiKey: Schema.string().role('secret').default('').description('xAI API Key（console.x.ai 生成）。不填则「鉴定」不可用。按量收费，每次鉴定跑两次 x_search。'),
  aiModel: Schema.string().default('').description('模型名。留空 = 自动从 /v1/models 选最新可用的 grok 文本模型（推荐）；也可以手动填 grok-4.7 固定型号。'),
  aiTimeoutMs: Schema.natural().role('ms').default(180000).description('单次 xAI 请求超时。x_search 要真去 X 搜资料和评价，完整鉴定实测 60–90 秒，默认 180 秒留足余量。'),
  cacheHours: Schema.natural().default(0).description('鉴定结果存数据库，有就直接读，不重复扣 xAI 费用。0（默认）= 永不过期；填 N = 超过 N 小时后再查会自动重新鉴定。想立刻重查发「鉴定 @用户名 刷新」。'),
  checkCooldownSec: Schema.natural().default(30).description('鉴定冷却秒数（同一个人）。只对真正调用 AI 的请求生效，读缓存不受限。'),
  checkDailyLimit: Schema.natural().default(10).description('每个人每天最多鉴定几次（防止被人拿去刷你的 xAI 余额）。0 = 不限。'),
  rankSize: Schema.natural().min(1).default(5).description('烧鸡榜每个分类显示几个人。'),
  rankApiBase: Schema.string().default('https://flj.info/api/rankings').description('烧鸡榜的数据接口（flj.info 的公开排行榜）。留空 = 只用本机鉴定记录；接口连不上时会自动回退到本机记录。'),
  checkHint: Schema.boolean().default(true).description('找鸡查到 X 账号时，在结果末尾加一句「发鉴定 @用户名 查可信度」的提示。'),
})

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('bitchfinder')
  const browser = new FishBrowser(ctx, { proxy: config.proxy })
  ctx.on('dispose', () => browser.dispose())

  // 鉴定：没装 database 时 store 会自动用内存，不阻塞插件启动。
  const store = new AccountStore(ctx, { logger, cacheHours: config.cacheHours })
  const rankFetcher = new RankFetcher(config.rankApiBase)
  const verifier = new Verifier({
    logger,
    store,
    baseUrl: config.aiBaseUrl,
    apiKey: config.aiApiKey,
    model: config.aiModel,
    timeoutMs: config.aiTimeoutMs,
    cooldownSec: config.checkCooldownSec,
    dailyLimit: config.checkDailyLimit,
    cacheHours: config.cacheHours
  })
  ctx.inject(['database'], (ctx) => defineModel(ctx))
  ctx.on('ready', () => {
    if (!store.persistent) logger.warn('没有 database 服务：鉴定结果只存在内存里，重启就没了。装上 database-sqlite / database-mysql 可持久化。')
  })

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
      const twitter = accounts.find((account) => account.platform === 'twitter')
      if (config.checkHint && twitter) {
        text += `\n\n· 想看这个号可信度：发「鉴定 ${twitter.handle}」`
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

  ctx.command('鉴定 <target:text>', '查 X(Twitter) 账号可信度')
    .usage('发「鉴定 @用户名」，或者「鉴定 https://x.com/用户名」。AI 会去 X 上搜账号资料和他人评价，给出 0–200 的可信度、标签和风险。结果会存进数据库，之后同一个人再查直接读库、不再花 xAI 费用；想重新查就发「鉴定 @用户名 刷新」。')
    .example('鉴定 @alice')
    .example('鉴定 @alice 刷新')
    .action(async ({ session }, target) => {
      if (!session) return
      if (!config.aiApiKey) return '还没配置 xAI API Key：在插件配置里填上 aiApiKey 才能鉴定。'
      const raw = String(target ?? '').trim()
      if (!raw) return '用法：鉴定 @用户名，或者 鉴定 https://x.com/用户名'
      // 刷新词可放开头或结尾；结果仍受冷却和每日上限限制。
      const { handle, refresh } = parseCheckTarget(raw)
      if (!handle) return '要刷新谁？发「鉴定 @用户名 刷新」。'
      let normalized: string
      try {
        normalized = verifier.normalize(handle)
      } catch (error) {
        return (error as Error).message
      }
      await session.send(`收到，正在${refresh ? '重新' : ''}鉴定 @${normalized}（要搜一会儿，别急）`)
      try {
        const outcome = await verifier.check(normalized, `${keyOf(session)}|check`, { refresh })
        return h.text(formatReport(outcome.row, {
          cached: outcome.cached,
          stale: outcome.stale
        }))
      } catch (error) {
        if (!(error instanceof UserError)) logger.warn('鉴定失败：%s', (error as Error)?.stack ?? error)
        return h.text(`鉴定失败：${(error as Error)?.message ?? error}`)
      }
    })

  ctx.command('烧鸡榜 [category:text]', '看烧鸡榜（flj.info，连不上时用本机记录）')
    .usage('发「烧鸡榜」看全部分类，或者「烧鸡榜 风俗业者」只看一个。数据来自 flj.info 的公开排行榜；接口连不上时自动用本机鉴定记录。分类：' + RANK_CATEGORIES.map((category) => category.title).join(' / '))
    .example('烧鸡榜 评分最高')
    .action(async ({ session }, category) => {
      if (!session) return
      const picked = resolveCategory(category)
      if (String(category ?? '').trim() && !picked) {
        return `没有这个榜。可用：${RANK_CATEGORIES.map((item) => item.title).join(' / ')}`
      }
      const categories = picked ? [picked] : RANK_CATEGORIES

      // 优先读 flj.info 的公开榜；网站本来就有数据，不用先把账号鉴定一遍。
      const groups: RankGroup[] = []
      let remote = false
      if (rankFetcher.enabled) {
        const results = await Promise.allSettled(categories.map((item) => rankFetcher.fetch(item, config.rankSize)))
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            remote = true
            if (result.value.length) groups.push({ category: categories[index], rows: result.value })
          } else {
            logger.warn('排行榜接口失败：%s', (result.reason as Error)?.message ?? result.reason)
          }
        })
      }

      if (!remote) {
        // 接口不可用：退回本机鉴定记录
        let rows
        try {
          rows = await store.list()
        } catch (error) {
          return h.text(`读榜单失败：${(error as Error)?.message ?? error}`)
        }
        const local = buildRank(rows, categories.map((item) => item.key), config.rankSize)
          .filter((group) => group.rows.length)
        if (!local.length) {
          if (!rankFetcher.enabled) {
            return '没有配置排行榜接口（rankApiBase），本机也没有鉴定记录。先发「鉴定 @用户名」查几个，或者在配置里填上 rankApiBase。'
          }
          return `flj.info 排行榜暂时连不上，本机也没有${picked ? `「${picked.title}」的` : ''}鉴定记录。先发「鉴定 @用户名」查几个，或者稍后再试。`
        }
        await session.send('⚠️ flj.info 排行榜接口暂时连不上，下面用本机鉴定记录兜底。')
        groups.push(...local)
      }

      if (!groups.length) {
        return picked ? `「${picked.title}」暂时没有数据。` : 'flj.info 排行榜暂时没有数据。'
      }

      try {
        // buildRankForward 会先下载头像转成 base64：节点里放远程 URL 时机器人下载失败会让整条转发挂掉。
        await session.send(await buildRankForward(groups))
        return
      } catch (error) {
        logger.warn('带头像的合并转发失败，改发纯文字转发：%s', (error as Error)?.message ?? error)
      }
      try {
        // 头像（base64）仍可能因为体积/平台限制被拒，去掉图再试一次。
        await session.send(await buildRankForward(groups, { avatars: false }))
        return
      } catch (error) {
        logger.warn('合并转发失败，回退纯文字：%s', (error as Error)?.message ?? error)
        return formatRankText(groups)
      }
    })

  ctx.inject(['chatluna'], (ctx) => {
    if (!config.registerTool) return
    registerFindBitchTool(ctx, { logger, findChicken, lastUse, gap, keyOf })
    if (config.aiApiKey) registerCheckBitchTool(ctx, { logger, verifier })
  })
}

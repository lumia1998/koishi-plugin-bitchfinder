// xAI Responses API 调用与结果归一化。
// 只接 xAI：鉴定依赖 x_search 去 X 上搜实时资料和第三方评价，换别的模型会退化成瞎猜。
import { calcScore } from './score'
import type { CheckResult, Gender } from './types'

export interface AiOptions {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export type AiErrorCode = 'no_key' | 'auth' | 'quota' | 'network' | 'timeout' | 'http' | 'empty'

export class AiError extends Error {
  constructor(message: string, readonly code: AiErrorCode) {
    super(message)
    this.name = 'AiError'
  }
}

/** 自动选模型的结果缓存 10 分钟：模型列表不会每分钟变。 */
const MODEL_CACHE_TTL = 10 * 60_000
const modelCache = new Map<string, { at: number; promise: Promise<string> }>()

function apiBase(value: string): string {
  const base = String(value || '').trim().replace(/\/+$/, '') || 'https://api.x.ai/v1'
  return base.replace(/\/responses$/, '')
}

/**
 * 配置里填了 aiModel 就照用；留空则从 /v1/models 自动选。
 * 选最新创建的、能跑 x_search 的文本模型，跳过图像/视频/构建/实验模型。
 */
export async function resolveModel(options: AiOptions): Promise<string> {
  const configured = String(options.model ?? '').trim()
  if (configured) return configured

  const base = apiBase(options.baseUrl)
  const cached = modelCache.get(base)
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL) return cached.promise

  const promise = fetchModelList(base, options.apiKey)
  modelCache.set(base, { at: Date.now(), promise })
  try {
    return await promise
  } catch (error) {
    // 失败不缓存，下次鉴定重试
    modelCache.delete(base)
    throw error
  }
}

async function fetchModelList(base: string, apiKey: string): Promise<string> {
  if (!apiKey) throw new AiError('还没配置 xAI API Key，先在插件配置里填上。', 'no_key')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let res: Response
  try {
    res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted) throw new AiError('获取 xAI 模型列表超时：可以在配置里手动填 aiModel。', 'timeout')
    throw new AiError(`连不上 xAI 模型列表：${(error as Error)?.message ?? error}`, 'network')
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401 || res.status === 403) throw new AiError('xAI API Key 无效或没有权限（401/403）。', 'auth')
  if (!res.ok) throw new AiError(`获取 xAI 模型列表失败（${res.status}）：可以在配置里手动填 aiModel。`, 'http')

  let data: any
  try {
    data = await res.json()
  } catch {
    throw new AiError('xAI 模型列表返回的不是 JSON：可以在配置里手动填 aiModel。', 'http')
  }
  const picked = pickModel(data?.data)
  if (!picked) throw new AiError('xAI 没有返回可用的文本模型：可以在配置里手动填 aiModel。', 'empty')
  return picked
}

/** 从 /v1/models 的 data 里挑最新的可用文本模型。 */
export function pickModel(items: unknown): string | null {
  if (!Array.isArray(items)) return null
  const all = items
    .map((item: any) => ({
      id: typeof item?.id === 'string' ? item.id.trim() : '',
      created: Number(item?.created) || 0
    }))
    .filter((item) => item.id && isTextModel(item.id))
  if (!all.length) return null
  // 有正式版就不选 beta/experimental；只有 beta 时才退而求其次
  const stable = all.filter((item) => !/beta|experimental/i.test(item.id))
  const pool = stable.length ? stable : all
  pool.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
  return pool[0].id
}

function isTextModel(id: string): boolean {
  if (!/^grok-/i.test(id)) return false
  // 图像/视频/构建/多智能体模型不一定支持 x_search
  return !/imagine|video|image|build|multi-agent/i.test(id)
}

const RISK_TYPES = ['stolen_photo', 'fake_gender', 'scam', 'impersonation']
const POSITIVE_TYPES = ['recommended', 'verified_real', 'praised', 'trusted']
const CONTENT_TAGS = ['巨乳', '童颜', '御姐', '萝莉', '美腿', '黑丝', '不露脸', '多人', 'SM', '调教', '女同', '4P', '熟女', '美臀', '纯爱', '情侣', 'NTR', '小狗']

const ACCOUNT_TAG_MAP: Record<string, string> = {
  '風俗業者': '风俗业者',
  '風俗业者': '风俗业者',
  '风俗业者': '风俗业者',
  '風俗娘': '风俗业者',
  '可线下': '可线下',
  '可線下': '可线下',
  '有门槛费': '有门槛费',
  '有門檻費': '有门槛费',
  'AV女優': 'AV女优',
  'AV女优': 'AV女优',
  '福利博主': '福利博主'
}

export function normalizeHandle(input: string): string | null {
  let text = String(input ?? '').trim()
  if (!text) return null
  const url = text.match(/^(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i)
  if (url) text = url[1]
  text = text.replace(/^@+/, '').trim()
  // 只接受单个用户名，防止把整段话塞进提示词
  if (!/^[A-Za-z0-9_]{1,15}$/.test(text)) return null
  return text.toLowerCase()
}

/** 从模型输出里抠 JSON：优先剥掉 ```json 围栏，再按括号配平取第一个完整对象。 */
export function extractJson<T = Record<string, unknown>>(text: string): T | null {
  const source = String(text ?? '').replace(/```(?:json)?/gi, '').trim()
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, i + 1)) as T } catch { return null }
      }
    }
  }
  return null
}

async function xaiSearch(input: string, maxOutputTokens: number, options: AiOptions): Promise<string> {
  if (!options.apiKey) throw new AiError('还没配置 xAI API Key，先在插件配置里填上。', 'no_key')
  const url = `${apiBase(options.baseUrl)}/responses`
  // aiModel 留空时自动选；两个并行请求会共用同一次 /v1/models 查询。
  const model = await resolveModel(options)

  // x_search 要真去 X 搜资料和第三方评价，完整鉴定实测 60–90 秒；默认给足 180 秒。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5000, options.timeoutMs || 180000))
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`
      },
      body: JSON.stringify({
        model,
        tools: [{ type: 'x_search' }],
        input,
        max_output_tokens: maxOutputTokens
      }),
      signal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted) throw new AiError('xAI 请求超时。x_search 完整搜索通常要 60–90 秒，把配置里的 aiTimeoutMs 调到 180000（或更大）再试。', 'timeout')
    throw new AiError(`连不上 xAI：${(error as Error)?.message ?? error}`, 'network')
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401 || res.status === 403) throw new AiError('xAI API Key 无效或没有权限（401/403）。', 'auth')
  if (res.status === 402 || res.status === 429) throw new AiError('xAI 额度不足或被限流（402/429），等会儿再试。', 'quota')
  if (res.status === 503) throw new AiError('xAI 暂时不可用（503），稍后再试。', 'http')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new AiError(`xAI 返回 ${res.status}${body ? `：${body.slice(0, 160)}` : ''}`, 'http')
  }

  const data = await res.json() as any
  const text = extractOutputText(data)
  if (!text) throw new AiError('AI 没返回有效内容，稍后再试。', 'empty')
  // 去掉 Grok 的引用标签 <grok:render ...>...</grok:render>
  return text.replace(/<grok:[^>]*>[\s\S]*?<\/grok:[^>]*>/g, '').replace(/<grok:[^/]*\/>/g, '').trim()
}

function extractOutputText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text
  const output = Array.isArray(data?.output) ? data.output : []
  const message = output.find((item: any) => item?.type === 'message') ?? output[0]
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item: any) => typeof item === 'string' ? item : (item?.text ?? '')).join('')
  }
  return ''
}

export async function checkAccount(handle: string, options: AiOptions): Promise<CheckResult> {
  const profilePrompt = `Look up @${handle} on X. Return ONLY valid JSON (no markdown):
{"display_name":"name","bio":"bio text","avatar_url":"url or null","is_active":true/false,"engagement":"high/medium/low","recent_posts":["post1","post2"],"location":"city/country or null","using_proxy":true if VPN suspected else false,"detail":"3-4 sentences in Chinese: what they post, engagement style, any red flags or complaints found","blue_v_interaction_pct":0-100 or null,"primary_language":"日本語/中文/English etc or null","active_cities":["東京"] — major cities only, normalize districts to city (渋谷→東京, 難波→大阪), ["全球可飞"] if global, [] if unknown,"account_tags":include matching tags only — "風俗業者"(sex/nightlife industry: 風俗/夜職/パパ活/メンヘス/デリヘル/ソープ/キャバ/ホスト etc),"可线下"(offline meetups),"有门槛费"(🚪 or deposit fee),"AV女優"(AV actress/studio),"福利博主"(sells photo/video packs: OnlyFans/Fanbox/Fantia/图包 etc) — [] if none,"content_tags":select 3–5 matching tags from this list based on their content/media/bio — try to pick at least 3 if the account has any adult/welfare content — ["巨乳","童颜","御姐","萝莉","美腿","黑丝","不露脸","多人","SM","调教","女同","4P","熟女","美臀","纯爱","情侣","NTR","小狗"] — [] only if truly no relevant content,"gender":"female/male/unknown","follower_count":int or null,"following_count":int or null,"tweet_count":int or null,"is_blue_verified":true/false/null,"account_age_years":decimal or null,"is_welfare":true if adult/NSFW/nightlife content else false,"pinned_tweet_has_url":true if pinned tweet has any link else false}
If the account cannot be found, return the JSON with null/empty values and detail explaining it. Never invent numbers or quotes.`

  const mentionPrompt = `Search X for third-party tweets mentioning @${handle}. Count complaints (盗图/皮下男/詐欺骗钱跑路/偽物なりすまし/差评踩雷) and positives (推荐好评/会えた本物/かわいい信頼).
EXCLUDE: tweets BY @${handle} themselves (including self-defense or rhetorical questions), pure speculation without victim firsthand account.
complaint_types (strict evidence required): "stolen_photo"(explicit claim of stolen photos),"fake_gender"(direct interaction proving male),"scam"(≥2 independent victims with payment+disappear),"impersonation"(confirmed fake identity).
positive_types: "recommended","verified_real","praised","trusted".
Examples must be verbatim third-party tweets only. If nothing is found, return zeros and empty arrays — never invent. Return ONLY JSON:
{"complaints":0,"positives":0,"complaint_types":[],"positive_types":[],"complaint_examples":[],"positive_examples":[]}`

  const [profileText, mentionText] = await Promise.all([
    xaiSearch(profilePrompt, 800, options),
    xaiSearch(mentionPrompt, 600, options)
  ])

  const profile = extractJson<any>(profileText)
  const mentions = extractJson<any>(mentionText) ?? {}
  if (!profile) throw new AiError('AI 没返回可解析的账号资料，可能这个号不存在或刚才搜索失败，稍后再试。', 'empty')

  const p = isRecord(profile) ? profile : {}
  const m = isRecord(mentions) ? mentions : {}

  const accountTags = normalizeAccountTags(p.account_tags)
  const isWelfare = p.is_welfare === true || accountTags.some((tag) => ['风俗业者', 'AV女优', '福利博主'].includes(tag))

  const complaintExamples = filterSelfDefense(stringArray(m.complaint_examples))
  const positiveExamples = filterSelfDefense(stringArray(m.positive_examples))
  const complaintTypes = normalizeRiskTypes(stringArray(m.complaint_types), complaintExamples)
  const positives = clampCount(m.positives)
  const complaints = clampCount(m.complaints)

  const profileFields = {
    accountAgeYears: numberOrNull(p.account_age_years),
    followers: numberOrNull(p.follower_count),
    tweets: numberOrNull(p.tweet_count),
    isVerified: booleanOrNull(p.is_blue_verified),
    isActive: booleanOrNull(p.is_active),
    engagement: stringOrNull(p.engagement),
    positives,
    complaints,
    complaintTypes,
    usingProxy: booleanOrNull(p.using_proxy),
    pinnedTweetHasUrl: booleanOrNull(p.pinned_tweet_has_url),
    manualVerified: false
  }

  return {
    handle,
    displayName: stringOrNull(p.display_name),
    bio: stringOrNull(p.bio),
    avatarUrl: stringOrNull(p.avatar_url),
    detail: stringOrNull(p.detail) ?? '',
    score: calcScore(profileFields),
    complaints,
    positives,
    complaintExamples,
    positiveExamples,
    riskTags: complaintTypes,
    positiveTags: stringArray(m.positive_types).filter((tag) => POSITIVE_TYPES.includes(tag)),
    accountTags,
    contentTags: stringArray(p.content_tags).filter((tag) => CONTENT_TAGS.includes(tag)).slice(0, 5),
    activeCities: stringArray(p.active_cities).filter((city) => city.length <= 12).slice(0, 6),
    language: stringOrNull(p.primary_language),
    gender: normalizeGender(p.gender),
    isWelfare,
    followers: profileFields.followers,
    tweets: profileFields.tweets,
    accountAgeYears: profileFields.accountAgeYears,
    isVerified: profileFields.isVerified
  }
}

function filterSelfDefense(examples: string[]): string[] {
  return examples.filter((example) => {
    if (!example || typeof example !== 'string') return false
    const lower = example.toLowerCase()
    return !lower.includes('なぜ') && !lower.includes('为什么我') && !lower.includes('why do people think i')
  }).slice(0, 10).map((example) => example.slice(0, 300))
}

function normalizeRiskTypes(types: string[], examples: string[]): string[] {
  const list = types.filter((tag) => RISK_TYPES.includes(tag))
  // 诈骗/冒充必须有例句撑腰，否则只保留标签性风险（盗图、皮下男）
  if (!examples.length) return list.filter((tag) => tag !== 'scam' && tag !== 'impersonation')
  return [...new Set(list)]
}

function normalizeAccountTags(value: unknown): string[] {
  const list = stringArray(value)
  const out: string[] = []
  for (const tag of list) {
    const mapped = ACCOUNT_TAG_MAP[tag]
    if (mapped && !out.includes(mapped)) out.push(mapped)
  }
  return out
}

function normalizeGender(value: unknown): Gender {
  return value === 'female' || value === 'male' ? value : 'unknown'
}

function clampCount(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(999, n)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

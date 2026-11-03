// ── 账号抽取 ──────────────────────────────────────────────────────────────
import { stripTags, trimText } from './utils'

export interface Candidate {
  engine?: string
  similarity?: number | null
  title?: string
  sourceUrl?: string
  authorUrl?: string
  authorName?: string
  host?: string
  snippet?: string
  links?: string[]
  url?: string
  weak?: boolean
}

export interface AccountEvidence {
  engine: string
  similarity: number | null
  sourceUrl: string
  name?: string
}

export interface Account {
  platform: string
  handle: string
  url: string
  authorName?: string
  confidence: string
  evidence: AccountEvidence
}

export interface Failure {
  engine: string
  reason: string
}

export interface DroppedAccount {
  account: Account
  consensus: { name: string; prefix: string; hits: number }
}

interface PlatformMatch {
  platform: string
  handle: string
  handleKey: string
  url: string
}

const PLATFORM_RULES: { platform: string; re: RegExp; clean: (m: RegExpMatchArray) => { handle: string; handleKey: string; url?: string } }[] = [
  {
    platform: 'twitter',
    re: /^https?:\/\/(?:www\.|mobile\.|m\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{2,20})(?:\/|$|\?)/i,
    // 命中的常常是某条推文（/status/…），但人问的是「账号」，所以一律收敛到主页地址。
    clean: (m) => ({
      handle: '@' + m[1],
      handleKey: m[1].toLowerCase(),
      url: `https://x.com/${m[1]}`
    })
  },
  {
    platform: 'weibo',
    re: /^https?:\/\/(?:www\.|m\.)?weibo\.(?:com|cn)\/(?:u\/|n\/)?(\d{6,}|[A-Za-z0-9_\-]{3,40})(?:\/|$|\?)/i,
    clean: (m) => ({ handle: m[1], handleKey: m[1].toLowerCase() })
  },
  {
    platform: 'bilibili',
    re: /^https?:\/\/(?:space\.bilibili\.com|www\.bilibili\.com\/space)\/(\d{3,})(?:\/|$|\?)/i,
    clean: (m) => ({ handle: m[1], handleKey: m[1] })
  },
  {
    platform: 'instagram',
    re: /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})\/?(?:\?|$)/i,
    clean: (m) => ({ handle: '@' + m[1], handleKey: m[1].toLowerCase() })
  },
  {
    platform: 'pixiv',
    // 两种真实形态：新站 /users/<id>，老站 /member.php?id=<id>（SauceNAO 的 Member 行就是后者）
    re: /^https?:\/\/(?:www\.)?pixiv\.net\/(?:(?:en\/)?users\/(\d{2,})|member\.php\?(?:[^#]*&)?id=(\d{2,}))/i,
    clean: (m) => {
      const id = m[1] ?? m[2]
      return { handle: id, handleKey: id, url: `https://www.pixiv.net/users/${id}` }
    }
  }
]

// bilibili 的图文/视频页里带作者 mid 时才算 direct
const BILIBILI_AUTHOR_RE = /\/(?:opus|video|read)\/.*?(?:mid=|space\.bilibili\.com\/)(\d{3,})/i

// 同分时的平台顺序（数字越小越靠前）：Twitter → 微博 → B站 → Instagram → Pixiv。
// 真人 coser 的号绝大部分在推特，微博其次；Pixiv 是画作平台（画师的作品页），
// 不是「这个人自己的社交账号」，所以排在最后，回话里也要标出来。
const PLATFORM_WEIGHT: Record<string, number> = { twitter: 1, weibo: 2, bilibili: 3, instagram: 4, pixiv: 9 }

// 画作平台：pixiv 上的是画师的作品/会员号，不是 coser 的主页。
const ARTWORK_PLATFORMS = new Set(['pixiv'])

// 「看着像账号、其实是页面」的路径前缀 —— 搜索结果里这类链接特别多，
// 不挡掉就会把 `weibo.com/ttarticle/p/show?id=…` 当成一个叫 ttarticle 的账号报出去。
const PATH_DENY: Record<string, string[]> = {
  weibo: ['ttarticle', 'p', 'show', 'status', 'detail', 'photo', 'video', 'article', 'fav', 'like', 'comment', 'search', 'hot', 'topic', 'tv', 'page', 's', 'weibo', 'login', 'signup', 'reg'],
  twitter: ['i', 'intent', 'share', 'home', 'search', 'hashtag', 'status', 'explore', 'notifications', 'messages', 'settings', 'login', 'signup', 'tos', 'privacy', 'account'],
  instagram: ['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'about', 'legal', 'directory'],
  bilibili: ['video', 'read', 'opus', 'bangumi', 'search', 'account'],
  pixiv: ['artworks', 'i', 'en', 'tags', 'search', 'ranking', 'novel', 'ajax']
}

export function matchPlatform(url: string): PlatformMatch | null {
  for (const rule of PLATFORM_RULES) {
    const m = String(url ?? '').match(rule.re)
    if (!m) continue
    const handle = String(m[1] ?? '')
    const deny = PATH_DENY[rule.platform] ?? []
    if (deny.includes(handle.toLowerCase())) continue
    if (rule.platform === 'weibo') {
      // weibo.com/123456 这种纯数字才是 uid；weibo.com/abc 是昵称路径，也能用
      if (!/^\d+$/.test(handle) && !/^[A-Za-z0-9_\-]{3,}$/.test(handle)) continue
    }
    if (rule.platform === 'instagram' && /^(p|reel|explore|accounts|stories)$/i.test(handle)) continue
    if (rule.platform === 'twitter' && /^(i|intent|share|home|search)$/i.test(handle)) continue
    const cleaned = rule.clean(m)
    // clean() 可以给出归一化后的 url（比如 pixiv 老站 member.php → /users/<id>）
    return { platform: rule.platform, ...cleaned, url: cleaned.url || String(url) }
  }
  return null
}

/** 整条标题当人名的兜底太脏（会得到「阿抽崽on X: \"hi\" / X」这种），先过滤掉不像名字的。 */
export function looksLikePersonName(value: string): boolean {
  const text = String(value ?? '').trim()
  if (text.length < 2 || text.length > 24) return false
  if (/["':：/|]/.test(text)) return false
  if (/\b(on|via|by)\s+(x|twitter|instagram|ig|weibo|bilibili|tiktok|facebook|threads)\b/i.test(text)) return false
  return true
}

/** 人名归一：小写、去空格与常见标点，用来做「这俩是不是同一串字」的粗比较。 */
export function normalizePersonName(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\-_·・.,，。:：;；!！?？'"“”‘’()（）\[\]【】{}<>《》|/\\~—–]+/g, '')
}

/**
 * 找出「这一批结果主要在讲谁」：把候选里出现过的名字（作者行、社交卡片、主页标题）逐个拿去
 * 比对所有结果的标题，某个名字或它的前几个字命中最多条结果，就以它为主轴。
 * 只命中自己那一条的名字（hits 减掉自身后为 0）不算证据 —— 那就是搭便车的别人。
 */
export function dominantPersonName(candidates: Candidate[], { minHits = 1, minPrefix = 4 } = {}): { name: string; prefix: string; hits: number } {
  const list = Array.isArray(candidates) ? candidates : []
  const titles = list
    .map((candidate) => normalizePersonName(`${candidate?.title ?? ''} ${candidate?.snippet ?? ''}`))
    .filter((text) => text.length >= minPrefix)
  if (!titles.length) return { name: '', prefix: '', hits: 0 }
  const names = new Map<string, string>()
  const add = (raw: string | undefined) => {
    const key = normalizePersonName(raw ?? '')
    if (key.length < minPrefix || names.has(key)) return
    names.set(key, String(raw ?? '').trim())
  }
  for (const candidate of list) {
    add(candidate?.authorName)
    add(profileTitleName(String(candidate?.title ?? '')).name)
    add(socialNameFromTitle(String(candidate?.title ?? '')))
    // 标题里写的名字（`CN : 阿薰kaOri`）也是证据：同一批结果里它出现在好几条标题上，
    // 就说明这张图讲的是这个人 —— 哪怕账号卡片是别人发的。
    add(nameFromTitleMention(String(candidate?.title ?? '')))
  }
  let best = { name: '', prefix: '', hits: 0 }
  // 短名先占位：同票时留「阿薰kaori」这种干净写法，而不是「阿薰kaOriCOSPlayerVN」。
  const keys = [...names.keys()].sort((a, b) => a.length - b.length)
  for (const key of keys) {
    // 从长到短试前缀：「阿薰kaori防盗版」整串只命中 1 条，砍到「阿薰kaori」就命中好几条
    for (let len = Math.min(key.length, 12); len >= minPrefix; len -= 1) {
      const head = key.slice(0, len)
      const hits = titles.filter((text) => text.includes(head)).length - 1
      if (hits < minHits) continue
      if (hits > best.hits) best = { name: names.get(key) ?? key, prefix: head, hits }
      break
    }
  }
  return best
}

/** 从候选结果里抽社媒账号。只认 URL 证据 —— 没有证据的 handle 一律不写。 */
export function extractAccounts(candidates: Candidate[], { max = 3, onDrop = null, strictNames = true }: { max?: number; onDrop?: ((dropped: DroppedAccount) => void) | null; strictNames?: boolean } = {}): Account[] {
  const out: Account[] = []
  const seen = new Set<string>()
  const list = Array.isArray(candidates) ? candidates : []
  for (const candidate of list) {
    const authorHit = candidate?.authorUrl ? matchPlatform(candidate.authorUrl) : null
    const authorKey = authorHit ? authorHit.platform + '|' + authorHit.handleKey : ''
    const urls: string[] = []
    for (const value of [candidate?.authorUrl, candidate?.sourceUrl, candidate?.url, ...(candidate?.links ?? [])]) {
      if (value) urls.push(value)
    }
    // 标题/摘要里偶尔也带完整链接
    for (const text of [candidate?.title, candidate?.snippet]) {
      const found = String(text ?? '').match(/https?:\/\/[^\s"'<>）)]+/g)
      if (found) urls.push(...found)
    }
    for (const url of urls) {
      const hit = matchPlatform(url)
      if (!hit) continue
      const dedupe = hit.platform + '|' + hit.handleKey
      const profileName = profileTitleName(candidate?.title ?? '')
      const fallbackName = authorNameFromTitle(candidate?.title ?? '')
      const ownName =
        profileName.name ||
        socialNameFromTitle(candidate?.title ?? '') ||
        String(candidate?.authorName ?? '') ||
        (dedupe === authorKey || !looksLikePersonName(fallbackName) ? '' : fallbackName)
      if (seen.has(dedupe)) {
        // 同一个号被多个引擎撞见时，谁先到并不代表谁的标题更完整（扫描日期在前、作者在后很常见），
        // 所以后面再遇到带名字的就补上。
        const existing = out.find((item) => item.platform + '|' + String(item.handle ?? '').replace(/^@/, '').toLowerCase() === dedupe)
        if (existing && !existing.authorName && ownName) existing.authorName = ownName
        continue
      }
      seen.add(dedupe)
      out.push({
        platform: hit.platform,
        handle: hit.handle,
        url: hit.url,
        // 作者行带出来的名字（`Member: ... <a>名字</a>`）比作品标题更像「这个人叫什么」
        authorName: ownName,
        confidence: candidate.weak ? 'weak' : 'direct',
        evidence: {
          engine: candidate.engine ?? '',
          similarity: candidate.similarity ?? null,
          sourceUrl: candidate.sourceUrl ?? ''
        }
      })
    }
    // bilibili 图文页：从 sourceUrl 里挖 mid
    const bili = String(candidate?.sourceUrl ?? '').match(BILIBILI_AUTHOR_RE)
    if (bili) {
      const dedupe = 'bilibili|' + bili[1]
      if (!seen.has(dedupe)) {
        seen.add(dedupe)
        out.push({
          platform: 'bilibili',
          handle: bili[1],
          url: `https://space.bilibili.com/${bili[1]}`,
          confidence: candidate.weak ? 'weak' : 'direct',
          evidence: {
            engine: candidate.engine ?? '',
            similarity: candidate.similarity ?? null,
            sourceUrl: candidate.sourceUrl ?? ''
          }
        })
      }
    }
  }
  // 同一张图/同一条原帖只能对应一个作者：SauceNAO 常同时给出
  // `weibo.com/n/昵称` 与 `weibo.com/u/数字uid` —— 那是一个人，不能当成两个账号报出去。
  // 归一规则：按 platform + 原帖地址分组，组内只留「最正式」的那条 URL。
  const canonicalScore = (account: Account) => {
    const url = String(account.url ?? '')
    if (/\/u\/\d{3,}/.test(url)) return 3              // weibo.com/u/<uid>
    if (/space\.bilibili\.com\/\d+/.test(url)) return 3
    if (/members?\.php\?|pixiv\.net\/users\/\d+/.test(url)) return 3
    if (/\/(?:n|profile)\//.test(url)) return 1        // weibo.com/n/<昵称>：会 302 到 uid
    return 2
  }
  const bySource = new Map<string, Account>()
  const rank = (account: Account) => (account.confidence === 'direct' ? 0 : account.confidence === 'weak' ? 1 : 2)
  for (const account of out) {
    // 没有原帖地址时退回自己的 url 分组：否则「同平台但没 sourceUrl」的两个人会被当成同一个人，
    // 只留下一个（真机上 Lens 的候选是带 sourceUrl 的，但其他引擎不一定）。
    const group = `${account.platform}|${account.evidence?.sourceUrl || account.url || ''}`
    const prev = bySource.get(group)
    if (!prev) { bySource.set(group, account); continue }
    if (rank(account) < rank(prev)) { bySource.set(group, account); continue }
    if (rank(account) === rank(prev) && canonicalScore(account) > canonicalScore(prev)) bySource.set(group, account)
  }
  const deduped = [...new Set(bySource.values())]
  // 同一个 cos 角色常有好几个 coser 各拍一版，Lens 会把别人的原帖一起带回来（查「尤诺」时
  // 混进另一个 coser 的推文就是这种情况）。判断「谁是这张图的人」看出现次数：某个名字（或它
  // 的前几个字）在多条结果的标题里都出现，说明整批结果都在讲同一个人；只出现一次的就是搭便车。
  // 名字对不上的号一律不报 —— 宁可少报，也别把小鲸鱼报成别人的号。
  const consensus = dominantPersonName(list)
  const artworkOnly = deduped.length > 0 && deduped.every((account) => ARTWORK_PLATFORMS.has(account.platform))
  const nameOf = (account: Account) => normalizePersonName(account?.authorName ?? '')
  const namedMatch = consensus.prefix && !artworkOnly
    ? deduped.filter((account) => {
      const name = nameOf(account)
      if (!name) return false
      return name.startsWith(consensus.prefix) || consensus.prefix.startsWith(name)
    })
    : []
  // 只要认出了主轴，就只报「名字对得上」的号：对不上的、没名字的一律不报 ——
  // 报出去就是把别人的账号当成这个人（查尤诺那次报成 @Akane_ACZ 就是这么漏的）。
  // 主轴要求「同一串名字出现在 ≥2 条结果标题里」，所以单个候选的噪声名字不会触发这条。
  // strictNames=false 是给本人留的后门：有的作者压根不在标题里写名字，
  // 严格模式会变成「明明翻到了却报没查到」。关掉它就把所有号都报出来，
  // 由本人自己认。默认仍然是严格的那一套。
  const strictName = strictNames !== false && Boolean(consensus.prefix) && !artworkOnly
  const keptList = strictName ? namedMatch : deduped
  // 被「名字对不上主轴」挡掉的号要报给调用方：否则用户只看到「没查到」，
  // 不知道其实翻到了别人的帖子，只是没把它当成这个人。
  if (strictName && typeof onDrop === 'function') {
    for (const account of deduped) {
      if (namedMatch.includes(account)) continue
      try {
        onDrop({ account, consensus })
      } catch {
        // 统计用的回调，出错也不能影响结果
      }
    }
  }

  // 排序：direct → weak（相似图）→ inferred；同级再按相似度降序、平台顺序
  keptList.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    const sa = a.evidence?.similarity ?? -1
    const sb = b.evidence?.similarity ?? -1
    if (sb !== sa) return sb - sa
    return (PLATFORM_WEIGHT[a.platform] ?? 9) - (PLATFORM_WEIGHT[b.platform] ?? 9)
  })
  return keptList.slice(0, Math.max(1, Number(max) || 3))
}

export function platformLabel(platform: string): string {
  const name = ({ twitter: 'Twitter', weibo: '微博', bilibili: 'B站', instagram: 'Instagram', pixiv: 'Pixiv' } as Record<string, string>)[platform] ?? platform
  return ARTWORK_PLATFORMS.has(platform) ? `${name}（画作平台）` : name
}

// ── inferred 账号（搜索交叉验证，最多 2 个） ──────────────────────────────
//
// 口径：**direct 优先且必须已有 direct**。只有「同一作品/作者名 + 同平台账号页」
// 在同一份搜索结果里同时出现时才采纳，否则丢弃 —— 宁缺毋滥，绝不凭名字猜 handle。

/** 从候选标题里剥出「像作者名」的片段（去掉【分组】【漫画】这类方括号内容）。 */
export function authorNameFromTitle(title: string): string {
  const text = trimText(stripTags(String(title ?? '')), 120)
  if (!text) return ''
  const cleaned = text
    .replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const candidate = cleaned || text
  return candidate.length >= 2 && candidate.length <= 24 ? candidate : ''
}

/**
 * 谷歌 Lens 的社交卡片标题长这样：`X吴二棒on X: "…"`、`Instagram 某coser on Instagram: 1/3`。
 * 作者名就是那个「on <站点>」前面的部分 —— 比从整段文案里猜准得多。
 */
/**
 * 从标题里挖 coser 名字。Lens 的脸书 / Coser吧 / 贴吧卡片常把名字直接写在标题里
 * （`CN : 阿薰kaOri`、`动漫博主阿薰kaOri NO.049`），那不是账号卡片，
 * 所以原来的名字来源取不到 —— 「整批结果都在讲阿薰kaOri」这条最有力的证据就丢了。
 * 只做保守提取：抓到的东西还必须在别的标题里也出现，才会被当成主轴（见 dominantPersonName）。
 */
export function nameFromTitleMention(title: string): string {
  const text = String(title ?? '')
  if (!text) return ''
  const patterns = [
    // 注意不要写 \bCN：`FacebookCN : 阿薰kaOri` 里 k 和 C 之间没有词边界，带上 \b 就匹配不到了
    /CN\s*[:：]\s*([\p{L}\p{N}_@.]{2,24})/iu,
    /(?:coser|cosplayer|cos)\s*[:：\-_]\s*([\p{L}\p{N}_@.]{2,24})/iu,
    /(?:博主|coser|cosplayer)(?![吧网站群])([一-龥][\p{L}\p{N}_@.]{1,23})/iu
  ]
  for (const pattern of patterns) {
    const hit = text.match(pattern)
    if (!hit) continue
    // 中文里常见「Coser吧…」「博主网…」，把开头的语气词/站点词削掉再当名字
    const name = String(hit[1] ?? '').replace(/^(?:吧|网|站|群|们|的)+/, '').trim()
    if (name && looksLikePersonName(name)) return name
  }
  return ''
}

export function socialNameFromTitle(title: string): string {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const m = text.match(
    /^(?:X|Twitter|推特|Instagram|IG|Ins|TikTok|抖音|微博|Weibo|Bilibili|哔哩哔哩|Facebook|Threads)\s*(.{1,32}?)\s*on\s*(?:X|Twitter|Instagram|TikTok|Facebook|Threads|微博|Bilibili)\b/i
  )
  if (!m) return ''
  return m[1].trim().replace(/[:："'“”]+$/, '').slice(0, 40)
}

/**
 * 主页卡片标题长这样：`X阿薰kaOri防盗版(@izayoill) / X`、`Instagram 某coser(@abc) • Instagram`。
 * 名字取 `(` 之前、去掉开头的平台徽标；顺带把 handle 也带出来（和 URL 互相印证）。
 *
 * X 官方页面的标题则是 `Naimi奶咪 (@Anaimiya2) / X` 或 `Naimi奶咪 (@Anaimiya2) on X`，
 * 开头没有平台徽标。之前只认带徽标的 Lens 卡片，这种标题会整个漏掉，名字只能退回 handle。
 */
export function profileTitleName(title: string): { name: string; handle: string } {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return { name: '', handle: '' }
  const m = text.match(
    /^(?:X|Twitter|推特|Instagram|IG|Ins|TikTok|抖音|微博|Weibo|Bilibili|哔哩哔哩|Facebook|Threads)\s*(.{1,40}?)\s*[（(]\s*@?([A-Za-z0-9_.\-]{2,30})\s*[)）]/i
  )
  if (m) {
    const name = m[1].trim().replace(/[:：]+$/, '')
    return { name, handle: m[2] }
  }
  const generic = text.match(/^(.{1,40}?)\s*[（(]\s*@([A-Za-z0-9_.\-]{2,30})\s*[)）]/)
  if (!generic) return { name: '', handle: '' }
  const name = generic[1].trim().replace(/[:：]+$/, '')
  // 标题里的名字不能是平台徽标本身（`X (@foo)` 这种），也不能等于 handle。
  if (!name || /^(?:x|twitter|ig|ins|instagram|weibo|bilibili|facebook|threads)$/i.test(name)) {
    return { name: '', handle: '' }
  }
  if (name.replace(/^@/, '').toLowerCase() === generic[2].toLowerCase()) {
    return { name: '', handle: '' }
  }
  // `Top posts on X (@someone)` 这种页面标题不是人：名字里带「on X / via Twitter」的一律不认。
  if (/\b(on|via|by)\s+(x|twitter)\b/i.test(name)) return { name: '', handle: '' }
  return { name, handle: generic[2] }
}

/** 名字：优先 weibo 昵称形态的 handle，其次「图源那一条候选的标题里像人名的片段」，最后退回 handle。 */
export function accountNameOf(account: Account, candidates: Candidate[] = []): string {
  const url = String(account?.url ?? '')
  const nick = url.match(/weibo\.com\/n\/([^/?#]+)/i)
  if (nick) {
    try { return decodeURIComponent(nick[1]) } catch { return nick[1] }
  }
  const handle = String(account?.handle ?? '').replace(/^@/, '')
  const own = String(account?.authorName ?? '').trim()
  if (own) return own
  const source = account?.evidence?.sourceUrl ?? ''
  const list = Array.isArray(candidates) ? candidates : []
  const same = list.find((c) => c?.sourceUrl && source && c.sourceUrl === source)
    ?? list.find((c) => c?.sourceUrl && c.title)
  const fromTitle = same
    ? profileTitleName(same.title ?? '').name || authorNameFromTitle(same.title ?? '')
    : ''
  if (fromTitle) return fromTitle
  if (handle && !/^\d+$/.test(handle)) return handle
  // 纯数字 id（pixiv 会员号 / 微博 uid）看不出是谁，别硬编名字
  return '未知'
}

/** 账号展示：昵称类加 @，纯数字 id（微博 uid / B站 mid / pixiv 会员号）只给数字，链接另附。 */
export function displayHandle(account: Account): string {
  const handle = String(account?.handle ?? '').replace(/^@/, '').trim()
  if (!handle) return '未知'
  return /^\d+$/.test(handle) ? handle : `@${handle}`
}

/**
 * 拼回话。账号回复按用户指定的固定版式：
 *   🎯 **找鸡结果**
 *   🌐 平台：…
 *   👤 名字：…
 *   🆔 账号：…（主页链接跟在账号后面，方便点开核对）
 * 多个账号之间空一行；inferred 的账号在账号行尾标「推断」。
 */
export function formatReply({ accounts = [], candidates = [], enginesUsed = [], failures = [], cached = false, withImage = false, artworkDropped = 0, nameDropped = 0, consensusName = '', droppedHandles = [], label = '' }: {
  accounts?: Account[]
  candidates?: Candidate[]
  enginesUsed?: string[]
  failures?: Failure[]
  cached?: boolean
  withImage?: boolean
  artworkDropped?: number
  nameDropped?: number
  consensusName?: string
  droppedHandles?: string[]
  /** 追加在标题后的说明，比如「第 2 个候选」。 */
  label?: string
} = {}): string {
  const list = Array.isArray(accounts) ? accounts : []
  // 认出主轴时，优先给「写着这个人名字」的原帖：那才是你要顺着找的那条。
  const pool = (Array.isArray(candidates) ? candidates : []).filter((c) => c?.sourceUrl)
  const consensusKey = normalizePersonName(consensusName)
  const decode = (value: string) => {
    try {
      return decodeURIComponent(String(value ?? ''))
    } catch {
      return String(value ?? '')
    }
  }
  const top = (consensusKey
    ? pool.find((candidate) => normalizePersonName(
      `${candidate?.title ?? ''} ${decode(candidate?.sourceUrl ?? '')}`
    ).includes(consensusKey))
    : null) ?? pool[0] ?? null
  if (list.length) {
    const blocks = list.map((account) => {
      const url = String(account?.url ?? '').trim()
      const guess = account.confidence === 'inferred'
        ? '（推断，未核实）'
        : account.confidence === 'weak' ? '（相似图，未核实）' : ''
      const handle = `${displayHandle(account)}${url ? ` · ${url}` : ''}`
      return [
        `🌐 平台：${platformLabel(account.platform)}`,
        `👤 名字：${accountNameOf(account, candidates)}`,
        `🆔 账号：${handle}${guess}`
      ].join('\n')
    })
    const extra = [label, cached ? '缓存' : ''].filter(Boolean).join(' · ')
    const head = `🎯 **找鸡结果**${extra ? `（${extra}）` : ''}`
    let text = [head, '', blocks.join('\n\n')].join('\n')
    // 只有画作平台的结果时，得说清楚这不是 coser 本人的号
    if (list.every((account) => ARTWORK_PLATFORMS.has(account?.platform))) {
      text += '\n\n· Pixiv 是画作平台（画师的作品页），不是 coser 本人的账号；真人号一般在推特'
    }
    if (text.length > 900) text = text.slice(0, 897) + '…'
    return text
  }
  const tried = enginesUsed.length ? engineLabels(enginesUsed).join(' / ') : ''
  const why = failures.length ? `（${failures.map((f) => `${f.engine}:${trimText(f.reason, 30)}`).join('；')}）` : ''
  // 三种「没查到」要分开说，否则用户分不清是引擎没工作、还是翻到了但对不上人：
  //   · 一个引擎都没跑通 —— 是环境/网络问题（该看 why）
  //   · 跑通了、也翻到相似图 —— 是「对不上人」，比「都空」更接近事实
  //   · 跑通了但一片空白 —— 才是「私图/新图/裁过」
  const cacheTag = cached ? '（缓存）' : ''
  const head = !enginesUsed.length
    ? `❌ 这次没查成，一个引擎都没跑通${why ? ' ' + why : ''}`
    : (candidates?.length ?? 0) > 0
      ? `❌ 没查到账号。${tried}${cacheTag}翻到 ${candidates.length} 条相似图，但没有能确认的账号${why ? ' ' + why : ''}`
      : `❌ 没查到账号。${tried}${cacheTag}，都空——这种一般是私图、新图，或者裁过${why ? ' ' + why : ''}`
  const lines = [`🎯 **找鸡结果**`, '', head]
  if (Number(artworkDropped) > 0) {
    lines.push(`只翻到 ${Number(artworkDropped)} 张相似画作（相似度不够，没当成图源）；真人 coser 的号一般在推特`)
  }
  if (Number(nameDropped) > 0) {
    // 把被挡掉的 handle 也念出来：用户一眼能认出「这是另一个 coser 的号」。
    const handles = (Array.isArray(droppedHandles) ? droppedHandles : [])
      .map((handle) => String(handle ?? '').trim())
      .filter(Boolean)
      .slice(0, 3)
    const shown = handles.length ? `（${handles.join('、')}）` : ''
    lines.push(`翻到 ${Number(nameDropped)} 个别人的号${shown}，名字对不上${consensusName ? `「${trimText(consensusName, 24)}」` : '主轴'}，没当成这个人报`)
  }
  if (top) lines.push(`最接近的图源：${trimText(top.sourceUrl ?? '', 120)}`)
  let text = lines.join('\n')
  if (text.length > 900) text = text.slice(0, 897) + '…'
  return text
}

// ── 引擎可用性 ────────────────────────────────────────────────────────────

// 已验证「开箱即用」的引擎：不给探针结果也跑（探针只用来记录健康度）。
// 回话里给用户看的名字：光甩 id（lens / tracemoe）没人看得懂。
export const ENGINE_LABELS: Record<string, string> = {
  saucenao: 'SauceNAO',
  lens: '谷歌 Lens',
  tracemoe: '动漫截图溯源',
  iqdb: 'IQDB',
  bing: '必应',
  yandex: 'Yandex',
  google: '谷歌识图'
}

/** 把引擎 id 列表变成人话，例如 `谷歌 Lens / SauceNAO`。 */
export function engineLabels(engines: string[]): string[] {
  const list = Array.isArray(engines) ? engines : []
  return list.map((id) => ENGINE_LABELS[id] ?? String(id)).filter(Boolean)
}

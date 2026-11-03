// 鉴定 / 榜单里不依赖网络的部分：用户名解析、JSON 抠取、评分、分类、报告格式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAccount, extractJson, normalizeHandle, pickModel, resolveModel } from '../lib/check/ai.js'
import { buildNestedRankNodes, buildRankForward, formatRankText, formatReport } from '../lib/check/format.js'
import { pickTop, RANK_CATEGORIES, resolveCategory } from '../lib/check/rank.js'
import { RankFetcher } from '../lib/check/remote.js'
import { calcScore, scoreTier } from '../lib/check/score.js'
import { parseCheckTarget, Verifier } from '../lib/check/service.js'
import { AccountStore } from '../lib/check/store.js'

test('normalizeHandle 接受 @、裸用户名和 x/twitter 链接', () => {
  assert.equal(normalizeHandle('@Alice'), 'alice')
  assert.equal(normalizeHandle('Alice_01'), 'alice_01')
  assert.equal(normalizeHandle('https://x.com/Alice/status/123'), 'alice')
  assert.equal(normalizeHandle('https://twitter.com/alice?s=20'), 'alice')
  assert.equal(normalizeHandle('  @a_b  '), 'a_b')
})

test('normalizeHandle 拒绝空串、空格和超长用户名', () => {
  assert.equal(normalizeHandle(''), null)
  assert.equal(normalizeHandle('hello world'), null)
  assert.equal(normalizeHandle('abcdefghijklmnop'), null)
  assert.equal(normalizeHandle('https://example.com/alice'), null)
})

test('extractJson 能从围栏和废话里抠出 JSON', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('结果如下：{"a":"含 } 的字符串","b":[1,2]} 完毕'), { a: '含 } 的字符串', b: [1, 2] })
  assert.equal(extractJson('没有 JSON'), null)
  assert.equal(extractJson('{"a":'), null)
})

test('calcScore 对空字段保持基准分，对差评/诈骗扣分', () => {
  assert.equal(calcScore({}), 20)
  assert.ok(calcScore({ followers: 10000, tweets: 1000, accountAgeYears: 2 }) > 20)
  assert.ok(calcScore({ positives: 1 }) > 20)
  assert.ok(calcScore({ complaints: 2, complaintTypes: ['scam'] }) < calcScore({ complaints: 2 }))
})

test('scoreTier 分档单调', () => {
  assert.equal(scoreTier(10).label, '高危')
  assert.equal(scoreTier(60).label, '一般')
  assert.equal(scoreTier(160).label, '很高')
})

test('resolveCategory 支持标题、别名和模糊输入', () => {
  assert.equal(resolveCategory('评分最高')?.key, 'top')
  assert.equal(resolveCategory('top')?.key, 'top')
  assert.equal(resolveCategory('风俗')?.key, 'fushi')
  assert.equal(resolveCategory('AV女優')?.key, 'av')
  assert.equal(resolveCategory('不存在'), null)
})

function row(overrides = {}) {
  return {
    id: 1,
    handle: 'alice',
    displayName: 'Alice',
    bio: null,
    avatarUrl: null,
    detail: '这是一个测试账号。',
    score: 80,
    complaints: 0,
    positives: 0,
    riskTags: [],
    positiveTags: [],
    accountTags: [],
    contentTags: [],
    activeCities: [],
    language: null,
    gender: 'unknown',
    isWelfare: false,
    followers: 1000,
    tweets: 100,
    accountAgeYears: 1,
    isVerified: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    searchedAt: new Date('2026-01-01'),
    searchCount: 1,
    ...overrides
  }
}

test('pickTop 过滤并按分数排序', () => {
  const category = resolveCategory('评分最高')
  const rows = [
    row({ handle: 'a', score: 50 }),
    row({ handle: 'b', score: 120 }),
    row({ handle: 'c', score: 90 })
  ]
  assert.deepEqual(pickTop(rows, category, 2).map((item) => item.handle), ['b', 'c'])
})

test('pickTop 按标签过滤', () => {
  const category = resolveCategory('门槛妹')
  const rows = [
    row({ handle: 'a', accountTags: ['有门槛费'] }),
    row({ handle: 'b', accountTags: ['风俗业者'] })
  ]
  assert.deepEqual(pickTop(rows, category, 5).map((item) => item.handle), ['a'])
})

test('formatReport 含分数、标签和主页，且不超长', () => {
  const text = formatReport(row({ accountTags: ['风俗业者'], riskTags: ['scam'], complaints: 2, detail: '长'.repeat(500) }), { cached: true })
  assert.match(text, /@alice/)
  assert.match(text, /80\/200/)
  assert.match(text, /风俗业者/)
  assert.match(text, /骗钱跑路/)
  assert.match(text, /https:\/\/x\.com\/alice/)
  assert.ok(text.length <= 900)
})

test('formatRankText 每个分类都列出主页', () => {
  const category = resolveCategory('最新检索')
  const text = formatRankText([{ category, rows: [row()] }])
  assert.match(text, /最新检索/)
  assert.match(text, /https:\/\/x\.com\/alice/)
})

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** 收集合并转发节点里的图片元素（OneBot 适配器只认 base64://，不能留远程 URL）。 */
function imagesOf(element) {
  const found = []
  const walk = (items) => {
    for (const item of items ?? []) {
      if (item?.type === 'img' || item?.type === 'image') found.push(item)
      if (item?.children) walk(item.children)
    }
  }
  walk(element.children)
  return found
}

test('buildRankForward 把头像下载成 base64 再放进节点', async () => {
  const original = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
  }
  try {
    const category = resolveCategory('评分最高')
    const element = await buildRankForward([{ category, rows: [row({ avatarUrl: 'https://example.com/a.jpg' })] }])
    assert.equal(element.type, 'message')
    assert.equal(element.attrs.forward, true)
    assert.equal(element.children.length, 1)
    assert.equal(element.children[0].attrs.nickname, '评分最高')
    assert.deepEqual(urls, ['https://example.com/a.jpg'])

    const images = imagesOf(element)
    assert.equal(images.length, 1)
    assert.equal(images[0].attrs.src, `data:image/png;base64,${PNG.toString('base64')}`)
  } finally {
    globalThis.fetch = original
  }
})

test('buildRankForward 头像下载失败时省略图片，文字照发', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network down') }
  try {
    const category = resolveCategory('评分最高')
    const element = await buildRankForward([{ category, rows: [row({ avatarUrl: 'https://example.com/a.jpg' })] }])
    assert.equal(element.attrs.forward, true)
    assert.equal(imagesOf(element).length, 0)
    const text = JSON.stringify(element)
    assert.match(text, /@alice/)
    assert.match(text, /https:\/\/x\.com\/alice/)
  } finally {
    globalThis.fetch = original
  }
})

test('buildRankForward 相同头像只下载一次，非图片内容被丢弃', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('<html>nope</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
  }
  try {
    const category = resolveCategory('评分最高')
    const rows = [
      row({ handle: 'a', avatarUrl: 'https://example.com/a.jpg' }),
      row({ handle: 'b', avatarUrl: 'https://example.com/a.jpg' })
    ]
    const element = await buildRankForward([{ category, rows }])
    assert.equal(calls, 1)
    assert.equal(imagesOf(element).length, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('buildRankForward 关闭头像时不发任何请求', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
  }
  try {
    const category = resolveCategory('评分最高')
    const element = await buildRankForward([{ category, rows: [row({ avatarUrl: 'https://example.com/a.jpg' })] }], { avatars: false })
    assert.equal(calls, 0)
    assert.equal(element.attrs.forward, true)
    assert.equal(imagesOf(element).length, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('buildNestedRankNodes 产出「转发套转发」的原始 node 段', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
  try {
    const category = resolveCategory('评分最高')
    const nodes = await buildNestedRankNodes([{ category, rows: [row({ avatarUrl: 'https://example.com/a.jpg' })] }])
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].type, 'node')
    assert.equal(nodes[0].data.nickname, '评分最高')

    // SnowLuma 只把「content 全是 node」的节点当成内层转发，混进 text 就会被拍平。
    assert.ok(nodes[0].data.content.length > 0)
    assert.ok(nodes[0].data.content.every((segment) => segment.type === 'node'))

    const inner = nodes[0].data.content[0]
    assert.equal(inner.type, 'node')
    assert.equal(inner.data.nickname, 'Alice')
    const text = inner.data.content.filter((segment) => segment.type === 'text').map((segment) => segment.data.text).join('')
    assert.match(text, /@alice/)
    assert.match(text, /https:\/\/x\.com\/alice/)

    const image = inner.data.content.find((segment) => segment.type === 'image')
    assert.equal(image.data.file, `base64://${PNG.toString('base64')}`)
    assert.equal(image.data.cache, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('buildNestedRankNodes 头像下载失败时只发文字，且 avatars:false 不发请求', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('network down')
  }
  try {
    const category = resolveCategory('评分最高')
    const failed = await buildNestedRankNodes([{ category, rows: [row({ avatarUrl: 'https://example.com/a.jpg' })] }])
    assert.equal(calls, 1)
    assert.equal(failed[0].data.content[0].data.content.some((segment) => segment.type === 'image'), false)

    const skipped = await buildNestedRankNodes(
      [{ category, rows: [row({ avatarUrl: 'https://example.com/a.jpg' })] }],
      { avatars: false }
    )
    assert.equal(calls, 1)
    assert.equal(skipped[0].data.content[0].data.content.some((segment) => segment.type === 'image'), false)
  } finally {
    globalThis.fetch = original
  }
})

test('AccountStore 没有 database 时用内存，重复 save 累加次数', async () => {
  const ctx = { logger: () => ({ warn() {}, info() {} }) }
  const store = new AccountStore(ctx, { logger: { warn() {} }, cacheHours: 72 })
  assert.equal(store.persistent, false)
  assert.equal(await store.get('alice'), null)

  const first = await store.save(row({ handle: 'alice' }))
  assert.equal(first.searchCount, 1)
  assert.equal(store.isFresh(first), true)

  const second = await store.save(row({ handle: 'alice', score: 99 }))
  assert.equal(second.id, first.id)
  assert.equal(second.searchCount, 2)
  assert.equal(second.score, 99)
  assert.equal((await store.list()).length, 1)
})

function xaiResponse(value) {
  return new Response(JSON.stringify({
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function stubXai(profile, mentions) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls += 1
    const body = JSON.parse(init.body)
    return xaiResponse(String(body.input).includes('third-party tweets') ? mentions : profile)
  }
  return { calls: () => calls, restore: () => { globalThis.fetch = original } }
}

const PROFILE = {
  display_name: 'Alice',
  bio: '测试简介',
  avatar_url: 'https://example.com/a.jpg',
  is_active: true,
  engagement: 'high',
  detail: '主要发日常和福利图。',
  primary_language: '日本語',
  active_cities: ['東京'],
  account_tags: ['風俗業者', '有门槛费'],
  content_tags: ['黑丝'],
  gender: 'female',
  follower_count: 10000,
  tweet_count: 1000,
  is_blue_verified: true,
  account_age_years: 2,
  is_welfare: true,
  using_proxy: false,
  pinned_tweet_has_url: false
}

test('checkAccount 归一化标签 / 城市 / 风险，并保留第三方例句', async () => {
  const stub = stubXai(PROFILE, {
    complaints: 2,
    positives: 1,
    complaint_types: ['stolen_photo', 'scam'],
    positive_types: ['recommended'],
    complaint_examples: ['这个人盗图'],
    positive_examples: ['人很好，推荐']
  })
  try {
    const result = await checkAccount('alice', { baseUrl: 'https://api.x.ai/v1', apiKey: 'test', model: 'x', timeoutMs: 5000 })
    assert.equal(result.handle, 'alice')
    assert.deepEqual(result.accountTags, ['风俗业者', '有门槛费'])
    assert.deepEqual(result.contentTags, ['黑丝'])
    assert.deepEqual(result.activeCities, ['東京'])
    assert.equal(result.isWelfare, true)
    assert.deepEqual(result.riskTags.sort(), ['scam', 'stolen_photo'])
    assert.deepEqual(result.complaintExamples, ['这个人盗图'])
    assert.ok(result.score > 20)
    assert.equal(stub.calls(), 2)
  } finally {
    stub.restore()
  }
})

test('checkAccount 没有例句时不给 scam / impersonation 扣分', async () => {
  const stub = stubXai(PROFILE, {
    complaints: 1,
    positives: 0,
    complaint_types: ['stolen_photo', 'scam', 'impersonation'],
    positive_types: [],
    complaint_examples: [],
    positive_examples: []
  })
  try {
    const result = await checkAccount('alice', { baseUrl: 'https://api.x.ai/v1', apiKey: 'test', model: 'x', timeoutMs: 5000 })
    assert.deepEqual(result.riskTags, ['stolen_photo'])
  } finally {
    stub.restore()
  }
})

test('Verifier 命中缓存不再调 AI，日报上限会拒绝', async () => {
  const ctx = { logger: () => ({ warn() {}, info() {} }) }
  const store = new AccountStore(ctx, { logger: { warn() {} }, cacheHours: 72 })
  const stub = stubXai(PROFILE, { complaints: 0, positives: 0, complaint_types: [], positive_types: [], complaint_examples: [], positive_examples: [] })
  try {
    const verifier = new Verifier({
      logger: { warn() {} }, store,
      baseUrl: 'https://api.x.ai/v1', apiKey: 'test', model: 'x', timeoutMs: 5000,
      cooldownSec: 0, dailyLimit: 1, cacheHours: 72
    })
    const first = await verifier.check('@alice', 'u1')
    assert.equal(first.cached, false)
    assert.equal(stub.calls(), 2)
    const second = await verifier.check('alice', 'u1')
    assert.equal(second.cached, true)
    assert.equal(stub.calls(), 2)
    await assert.rejects(() => verifier.check('@bob', 'u1'), /今天已经鉴定 1 次/)
  } finally {
    stub.restore()
  }
})

test('parseCheckTarget 识别开头/结尾的刷新词', () => {
  assert.deepEqual(parseCheckTarget('@alice'), { handle: '@alice', refresh: false })
  assert.deepEqual(parseCheckTarget('@alice 刷新'), { handle: '@alice', refresh: true })
  assert.deepEqual(parseCheckTarget('刷新 @alice'), { handle: '@alice', refresh: true })
  assert.deepEqual(parseCheckTarget('alice --refresh'), { handle: 'alice', refresh: true })
  assert.deepEqual(parseCheckTarget('https://x.com/alice 重新查'), { handle: 'https://x.com/alice', refresh: true })
  assert.deepEqual(parseCheckTarget('刷新'), { handle: '', refresh: true })
})

test('isFresh：cacheHours=0 永不过期，填了小时数才按时间过期', () => {
  const ctx = { logger: () => ({ warn() {}, info() {} }) }
  const forever = new AccountStore(ctx, { logger: { warn() {} }, cacheHours: 0 })
  assert.equal(forever.isFresh(row({ searchedAt: new Date('2000-01-01') })), true)
  const expire = new AccountStore(ctx, { logger: { warn() {} }, cacheHours: 72 })
  assert.equal(expire.isFresh(row({ searchedAt: new Date('2000-01-01') })), false)
  assert.equal(expire.isFresh(row({ searchedAt: new Date() })), true)
})

test('Verifier 数据库有记录就直接读，只有 refresh 才重新调 AI', async () => {
  const ctx = { logger: () => ({ warn() {}, info() {} }) }
  const store = new AccountStore(ctx, { logger: { warn() {} }, cacheHours: 0 })
  const stub = stubXai(PROFILE, { complaints: 0, positives: 0, complaint_types: [], positive_types: [], complaint_examples: [], positive_examples: [] })
  try {
    const verifier = new Verifier({
      logger: { warn() {} }, store,
      baseUrl: 'https://api.x.ai/v1', apiKey: 'test', model: 'x', timeoutMs: 5000,
      cooldownSec: 0, dailyLimit: 0, cacheHours: 0
    })
    const first = await verifier.check('@alice', 'u1')
    assert.equal(first.cached, false)
    assert.equal(stub.calls(), 2)

    // 即使记录很旧，cacheHours=0 也直接复用
    const saved = await store.get('alice')
    saved.searchedAt = new Date('2000-01-01')
    const second = await verifier.check('@alice', 'u1')
    assert.equal(second.cached, true)
    assert.equal(stub.calls(), 2)

    // 明确要求刷新才重新调 AI，并覆盖原记录
    const third = await verifier.check('@alice', 'u1', { refresh: true })
    assert.equal(third.cached, false)
    assert.equal(stub.calls(), 4)
    assert.equal(third.row.id, second.row.id)
    assert.equal(third.row.searchCount, 2)
  } finally {
    stub.restore()
  }
})

test('Verifier 遇到 401 时给出明确错误', async () => {
  const ctx = { logger: () => ({ warn() {}, info() {} }) }
  const store = new AccountStore(ctx, { logger: { warn() {} }, cacheHours: 72 })
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 })
  try {
    const verifier = new Verifier({
      logger: { warn() {} }, store,
      baseUrl: 'https://api.x.ai/v1', apiKey: 'bad', model: 'x', timeoutMs: 5000,
      cooldownSec: 0, dailyLimit: 0, cacheHours: 72
    })
    await assert.rejects(() => verifier.check('@alice'), /401/)
  } finally {
    globalThis.fetch = original
  }
})

test('pickModel 跳过图像/视频/构建模型，选最新创建的正式版', () => {
  const picked = pickModel([
    { id: 'grok-imagine-image-2.0', created: 200 },
    { id: 'grok-imagine-video-1.5', created: 190 },
    { id: 'grok-build-0.1', created: 180 },
    { id: 'grok-4.20-multi-agent-0309', created: 170 },
    { id: 'grok-4.5', created: 100 },
    { id: 'grok-4.7', created: 120 },
    { id: 'grok-4.8-beta', created: 130 }
  ])
  assert.equal(picked, 'grok-4.7')
  // 只有 beta 时才退而求其次
  assert.equal(pickModel([{ id: 'grok-4.8-beta', created: 1 }]), 'grok-4.8-beta')
  assert.equal(pickModel([]), null)
})

test('resolveModel 在 aiModel 留空时自动取模型列表并缓存', async () => {
  const original = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return new Response(JSON.stringify({
      data: [
        { id: 'grok-4.3', created: 1 },
        { id: 'grok-4.7', created: 3 },
        { id: 'grok-imagine-image', created: 9 }
      ]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const options = { baseUrl: 'https://auto.example/v1', apiKey: 'test', model: '', timeoutMs: 5000 }
    assert.equal(await resolveModel(options), 'grok-4.7')
    assert.equal(await resolveModel(options), 'grok-4.7')
    assert.equal(urls.length, 1, '模型列表命中缓存')
    assert.equal(urls[0], 'https://auto.example/v1/models')

    // 配置了 aiModel 就不请求模型列表
    assert.equal(await resolveModel({ ...options, baseUrl: 'https://fixed.example/v1', model: 'grok-4.6' }), 'grok-4.6')
    assert.equal(urls.length, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('resolveModel 获取模型列表失败时给出可读错误', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('nope', { status: 500 })
  try {
    await assert.rejects(
      () => resolveModel({ baseUrl: 'https://fail.example/v1', apiKey: 'test', model: '', timeoutMs: 5000 }),
      /500/
    )
  } finally {
    globalThis.fetch = original
  }
})

test('每个烧鸡榜分类都有对应的 flj.info category', () => {
  const mapping = Object.fromEntries(RANK_CATEGORIES.map((category) => [category.key, category.api]))
  assert.deepEqual(mapping, {
    latest: 'comments',
    recent: 'latest',
    top: 'score',
    fushi: 'fushi',
    threshold: 'threshold',
    av: 'av',
    welfare: 'welfare',
    japan: 'ja',
    scam: 'risky'
  })
})

test('RankFetcher 从 flj.info 拉榜、映射字段并缓存', async () => {
  const original = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return new Response(JSON.stringify({
      items: [
        { twitter_username: 'Alice_01', display_name: ' Tester ', avatar_url: '/avatar/a.jpg', score: 97 },
        { twitter_username: 'bad name', display_name: 'x', avatar_url: null, score: 10 },
        { twitter_username: 'bob', display_name: '', avatar_url: 'https://img/b.jpg', score: 999 }
      ]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const fetcher = new RankFetcher('https://flj.info')
    const rows = await fetcher.fetch(resolveCategory('最新爆料'), 2)
    assert.equal(urls[0], 'https://flj.info/api/rankings?category=comments&page=1')
    assert.deepEqual(rows.map((item) => item.handle), ['alice_01', 'bob'])
    assert.equal(rows[0].displayName, 'Tester')
    assert.equal(rows[0].avatarUrl, 'https://flj.info/avatar/a.jpg')
    assert.equal(rows[0].score, 97)
    assert.equal(rows[1].displayName, null)
    assert.equal(rows[1].score, 200)

    await fetcher.fetch(resolveCategory('最新爆料'), 2)
    assert.equal(urls.length, 1, '同一分类命中缓存')
  } finally {
    globalThis.fetch = original
  }
})

test('RankFetcher 接口失败时抛出可读错误', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('nope', { status: 500 })
  try {
    const fetcher = new RankFetcher('https://flj.info/api/rankings')
    await assert.rejects(() => fetcher.fetch(resolveCategory('评分最高'), 5), /500/)
  } finally {
    globalThis.fetch = original
  }
})


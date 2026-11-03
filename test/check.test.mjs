// 鉴定 / 榜单里不依赖网络的部分：用户名解析、JSON 抠取、评分、分类、报告格式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAccount, extractJson, normalizeHandle } from '../lib/check/ai.js'
import { buildRankForward, formatRankText, formatReport } from '../lib/check/format.js'
import { pickTop, resolveCategory } from '../lib/check/rank.js'
import { calcScore, scoreTier } from '../lib/check/score.js'
import { Verifier } from '../lib/check/service.js'
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
  const text = formatReport(row({ accountTags: ['风俗业者'], riskTags: ['scam'], complaints: 2, detail: '长'.repeat(500) }), { cached: true, cacheHours: 72 })
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

test('buildRankForward 生成合并转发节点', () => {
  const category = resolveCategory('评分最高')
  const element = buildRankForward([{ category, rows: [row({ avatarUrl: 'https://example.com/a.jpg' })] }])
  assert.equal(element.type, 'message')
  assert.equal(element.attrs.forward, true)
  assert.equal(element.children.length, 1)
  assert.equal(element.children[0].attrs.nickname, '评分最高')
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


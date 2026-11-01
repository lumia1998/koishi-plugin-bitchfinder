// 差分测试：Koishi 移植版 vs 原版 鱼鱼找鸡 v1.0.0 —— 所有可比函数逐一对拍。
// 期望一律来自原版；移植版不一致就改移植版，绝不改测试期望或原版。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const portAccounts = require('../lib/accounts.js')
const portEngines = require('../lib/engines.js')
const portSafeFetch = require('../lib/safe-fetch.js')

const ORIG_DIR = process.env.FISH_ORIGINAL_DIR ?? path.resolve(here, '../../鱼鱼找鸡-插件-v1.0.0/鱼鱼找鸡-1.0.0')
const ORIG_FILE = path.join(ORIG_DIR, 'src/fish-find-chicken.js')

const counts = { parsers: {}, titles: 0, lists: { synthetic: 0, local: 0, random: 0 }, comparisons: 0 }

const capture = (fn) => {
  try { return { threw: false, value: fn() } }
  catch (error) { return { threw: true, message: String(error?.message ?? error), code: error?.code ?? null } }
}
const cmp = (portFn, origFn) => {
  counts.comparisons++
  assert.deepStrictEqual(capture(portFn), capture(origFn))
}

if (!fs.existsSync(ORIG_FILE)) {
  test('original plugin missing', (t) => {
    t.skip(`⚠️⚠️⚠️ 原版插件不在 ${ORIG_FILE} —— 差分测试整体跳过！设 FISH_ORIGINAL_DIR 指向原版目录后重跑 ⚠️⚠️⚠️`)
  })
  test('coverage summary', () => {
    console.log('[differential] SKIPPED: no comparisons ran (original plugin not found)')
  })
} else {
  const orig = await import(pathToFileURL(ORIG_FILE).href)
  const origSafeFetch = await import(pathToFileURL(path.join(ORIG_DIR, 'src/safe-fetch.js')).href)

  // ── 随机候选列表 ────────────────────────────────────────────────────────
  function mulberry32(seed) {
    let a = seed >>> 0
    return function () {
      a = (a + 0x6D2B79F5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const rng = mulberry32(20261101)
  const pick = (arr) => arr[Math.floor(rng() * arr.length)]

  const URL_POOL = [
    'https://x.com/coser_abc/status/123',
    'https://mobile.twitter.com/user_two',
    'https://www.x.com/three_',
    'https://x.com/i/home',
    'https://x.com/search?q=x',
    'https://x.com/hashtag/cos',
    'https://x.com/intent/tweet',
    'https://x.com/share',
    'https://x.com/a',
    'https://x.com/abcdefghij0123456789u',
    'https://weibo.com/u/123456789',
    'https://weibo.com/n/nick_name',
    'https://weibo.com/n/中文昵称',
    'https://weibo.com/ttarticle/p/show?id=1',
    'https://m.weibo.cn/status/1',
    'https://weibo.com/1234567/AbCd',
    'https://weibo.com/plainnick',
    'https://space.bilibili.com/123',
    'https://www.bilibili.com/space/678',
    'https://www.bilibili.com/opus/1?mid=45678',
    'https://www.bilibili.com/video/BV1x',
    'https://www.instagram.com/coser.ig/',
    'https://www.instagram.com/p/AbCdEf/',
    'https://www.instagram.com/reel/XyZ/',
    'https://www.instagram.com/explore/',
    'https://www.pixiv.net/users/123456',
    'https://www.pixiv.net/en/users/9876',
    'https://www.pixiv.net/member.php?id=555',
    'https://www.pixiv.net/artworks/111',
    'https://www.pixiv.net/member_illust.php?mode=medium&illust_id=222',
    'https://www.facebook.com/some.page',
    'https://tieba.baidu.com/p/123',
    'https://anilist.co/anime/456',
    'https://danbooru.donmai.us/posts/789',
    'https://example.com/a?b=1&c=2',
    ''
  ]
  const TITLE_POOL = [
    'X阿薰kaOri防盗版(@izayoill) / X',
    'FacebookCN : 阿薰kaOri',
    '动漫博主阿薰kaOri NO.049',
    'X别的coser(@other_cos) / X',
    'Instagram 某coser(@abc.def) • Instagram',
    'X吴二棒on X: "今天的cos"',
    'Instagram 小鲸鱼cos on Instagram: 1/3',
    '阿抽崽on X: "hi" / X',
    'Coser吧 阿薰kaOri 作品',
    'cosplayer: Lumi_Cos',
    'CN：小鲸鱼',
    '【原神】胡桃 cos [合集]',
    '阿薰kaOri COSPlayer VN',
    'pixiv 作品 by 画师A',
    'Some Article Title - Example',
    ''
  ]
  const AUTHOR_POOL = ['', '豊栄@ﾄﾞﾔｧ…', '阿薰kaOri', 'Lumi', '画师A']
  const SIM_POOL = [null, 0.45, 0.8, 0.87, 0.93, 0.99]
  const ENGINE_POOL = ['lens', 'saucenao', 'iqdb', 'tracemoe', 'baidu']
  const SNIPPET_POOL = ['', 'see https://x.com/snippet_user now', 'CN : 阿薰kaOri']

  const genCandidate = () => {
    const c = { engine: pick(ENGINE_POOL), title: pick(TITLE_POOL), sourceUrl: pick(URL_POOL) }
    if (rng() < 0.5) c.authorUrl = pick(URL_POOL)
    if (rng() < 0.5) c.authorName = pick(AUTHOR_POOL)
    if (rng() < 0.5) c.url = pick(URL_POOL)
    if (rng() < 0.5) c.snippet = pick(SNIPPET_POOL)
    if (rng() < 0.5) c.links = Array.from({ length: Math.floor(rng() * 4) }, () => pick(URL_POOL))
    if (rng() < 0.5) c.similarity = pick(SIM_POOL)
    if (rng() < 0.5) c.weak = rng() < 0.1
    return c
  }
  const randomLists = Array.from({ length: 500 }, () =>
    Array.from({ length: 1 + Math.floor(rng() * 10) }, genCandidate))

  const listFiles = (dir) => fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f))
    : []
  const loadList = (file) => {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(data) ? data : (data.candidates ?? [])
  }
  const syntheticLists = listFiles(path.join(here, 'fixtures/candidates')).map(loadList)
  const localLists = listFiles(path.join(here, 'local/fixtures/candidates')).map(loadList)
  const allLists = [...syntheticLists, ...localLists, ...randomLists]

  // ── 1. 常量 ─────────────────────────────────────────────────────────────
  test('constants', () => {
    assert.strictEqual(portEngines.LENS_EXTRACT, orig.LENS_EXTRACT, 'LENS_EXTRACT 必须和原版逐字节一致')
    assert.deepStrictEqual(portAccounts.ENGINE_LABELS, orig.ENGINE_LABELS)
    cmp(
      () => portAccounts.engineLabels(['lens', 'saucenao', 'tracemoe', 'iqdb', 'baidu', 'unknown']),
      () => orig.engineLabels(['lens', 'saucenao', 'tracemoe', 'iqdb', 'baidu', 'unknown'])
    )
  })

  // ── 2. 解析器 ───────────────────────────────────────────────────────────
  test('parsers', () => {
    for (const engine of ['saucenao', 'iqdb', 'tracemoe', 'baidu']) {
      let n = 0
      for (const dir of [path.join(here, 'fixtures/parsers', engine), path.join(here, 'local/fixtures/parsers', engine)]) {
        if (!fs.existsSync(dir)) continue
        for (const name of fs.readdirSync(dir).sort()) {
          const text = fs.readFileSync(path.join(dir, name), 'utf8')
          if (engine === 'saucenao') cmp(() => portEngines.parseSaucenao(text), () => orig.parseSaucenao(text))
          else if (engine === 'iqdb') cmp(() => portEngines.parseIqdb(text), () => orig.parseIqdb(text))
          else if (engine === 'tracemoe') {
            const payload = JSON.parse(text)
            cmp(() => portEngines.parseTracemoe(payload), () => orig.parseTracemoe(payload))
          } else cmp(() => portEngines.parseBaiduGraph(text), () => orig.parseBaiduGraph(text))
          n++
        }
      }
      counts.parsers[engine] = n
      assert.ok(n > 0, `committed fixtures must cover ${engine}`)
    }
  })

  // ── 3. 标题/人名辅助函数 ─────────────────────────────────────────────────
  test('title helpers', () => {
    const corpus = new Set(JSON.parse(fs.readFileSync(path.join(here, 'fixtures/titles.json'), 'utf8')))
    for (const list of allLists) {
      for (const candidate of list) {
        if (candidate?.title) corpus.add(candidate.title)
        if (candidate?.authorName) corpus.add(candidate.authorName)
      }
    }
    const helpers = ['looksLikePersonName', 'normalizePersonName', 'authorNameFromTitle', 'nameFromTitleMention', 'socialNameFromTitle', 'profileTitleName']
    for (const title of corpus) {
      for (const name of helpers) {
        cmp(() => portAccounts[name](title), () => orig[name](title))
      }
      counts.titles++
    }
  })

  // ── 4. 候选列表：主轴 / 抽账号 / 展示名 / 拼回话 ─────────────────────────
  const ENGINES_OPTIONS = [[], ['lens'], ['saucenao', 'tracemoe', 'lens']]
  const FAILURES_OPTIONS = [
    [],
    [{ engine: 'lens', reason: 'GOOGLE_UNREACHABLE：谷歌连不上（猫猫云没开或系统代理没开）' }],
    [{ engine: 'saucenao', reason: '空结果' }, { engine: 'tracemoe', reason: 'trace.moe HTTP 500' }]
  ]
  const buildCombos = (consensusName) => {
    const combos = []
    for (const strict of [true, false])
      for (const accEmpty of [false, true])
        for (const enginesUsed of ENGINES_OPTIONS)
          for (const failures of FAILURES_OPTIONS)
            for (const cached of [false, true])
              for (const artworkDropped of [0, 2])
                for (const [nameDropped, droppedHandles] of [[0, []], [1, ['@a', '@b']]])
                  for (const cn of ['', consensusName])
                    combos.push({ strict, accEmpty, enginesUsed, failures, cached, artworkDropped, nameDropped, droppedHandles, consensusName: cn })
    return combos
  }

  const runList = (list, { fullFormat }) => {
    cmp(
      () => portAccounts.dominantPersonName(structuredClone(list)),
      () => orig.dominantPersonName(structuredClone(list))
    )
    for (const strictNames of [true, false]) {
      for (const max of [1, 3, 5]) {
        const portDrops = []
        const origDrops = []
        const portRes = capture(() => portAccounts.extractAccounts(structuredClone(list), { max, strictNames, onDrop: (d) => portDrops.push(d) }))
        const origRes = capture(() => orig.extractAccounts(structuredClone(list), { max, strictNames, onDrop: (d) => origDrops.push(d) }))
        counts.comparisons++
        assert.deepStrictEqual(portRes, origRes)
        assert.deepStrictEqual(portDrops, origDrops)
      }
    }
    const accounts = orig.extractAccounts(structuredClone(list), { max: 5, strictNames: false })
    for (const account of accounts) {
      cmp(
        () => portAccounts.accountNameOf(structuredClone(account), structuredClone(list)),
        () => orig.accountNameOf(structuredClone(account), structuredClone(list))
      )
    }
    const consensusName = orig.dominantPersonName(structuredClone(list)).name
    const combos = buildCombos(consensusName)
    const chosen = fullFormat ? combos : [combos[0], ...Array.from({ length: 5 }, () => combos[Math.floor(rng() * combos.length)])]
    for (const combo of chosen) {
      const opts = {
        accounts: combo.accEmpty ? [] : orig.extractAccounts(structuredClone(list), { max: 3, strictNames: combo.strict }),
        candidates: list,
        enginesUsed: combo.enginesUsed,
        failures: combo.failures,
        cached: combo.cached,
        artworkDropped: combo.artworkDropped,
        nameDropped: combo.nameDropped,
        droppedHandles: combo.droppedHandles,
        consensusName: combo.consensusName
      }
      // 有意差异：移植版标题是「找鸡结果」，原版是「鱼鱼找鸡结果」——归一化后比对其余全部
      const normalizeReply = (s: any) => String(s).replace(/\*\*鱼鱼找鸡结果\*\*/g, '**找鸡结果**')
      cmp(() => normalizeReply(portAccounts.formatReply(structuredClone(opts))), () => normalizeReply(orig.formatReply(structuredClone(opts))))
    }
  }

  test('candidate lists: synthetic fixtures', () => {
    for (const list of syntheticLists) {
      runList(list, { fullFormat: true })
      counts.lists.synthetic++
    }
    assert.ok(syntheticLists.length > 0)
  })

  test('candidate lists: local fixtures', () => {
    for (const list of localLists) {
      runList(list, { fullFormat: true })
      counts.lists.local++
    }
  })

  test('candidate lists: 500 seeded random', () => {
    for (const list of randomLists) {
      runList(list, { fullFormat: false })
      counts.lists.random++
    }
  })

  // ── 5. safe-fetch：isPrivateIp / looksLikeImageBuffer ────────────────────
  test('safe-fetch helpers', () => {
    const ips = [
      '10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.1.1', '172.16.0.1', '172.31.255.255', '172.32.0.1',
      '192.168.1.1', '100.64.0.1', '100.128.0.1', '198.18.0.1', '198.20.0.1', '192.0.0.1', '224.0.0.1',
      '255.255.255.255', '8.8.8.8', '1.1.1.1', '104.26.14.28',
      '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'febf::1', 'fec0::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:0:7f00:1', '::c0a8:101',
      '64:ff9b::c0a8:101', '64:ff9b:1::1', '64:ff9b::808:808',
      '2001:db8::1', '2001:2::1', '2002:c0a8:0101::1', '2002:0808:0808::1',
      'ff02::1', '2606:4700::1', '2404:6800:4005::200e',
      '', 'abc', 'fe80::1%eth0', '[::1]', '999.1.1.1'
    ]
    for (const ip of ips) {
      cmp(() => portSafeFetch.isPrivateIp(ip), () => origSafeFetch.isPrivateIp(ip))
    }
    const buffers = [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),          // png
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]),       // jpeg
      Buffer.from('GIF89a' + 'xxxxxxxx'),                                                // gif89
      Buffer.from('GIF87a' + 'xxxxxxxx'),                                                // gif87
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),        // webp
      Buffer.alloc(11),                                                                  // too short
      Buffer.from('definitely not an image!'),
      rngBytes(64)
    ]
    for (const buf of buffers) {
      cmp(() => portSafeFetch.looksLikeImageBuffer(buf), () => origSafeFetch.looksLikeImageBuffer(buf))
    }
  })

  function rngBytes(n) {
    const out = Buffer.alloc(n)
    for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256)
    return out
  }

  test('coverage summary', () => {
    console.log(`[differential] parser fixtures: ${JSON.stringify(counts.parsers)}`)
    console.log(`[differential] titles: ${counts.titles}`)
    console.log(`[differential] candidate lists: synthetic=${counts.lists.synthetic} local=${counts.lists.local} random=${counts.lists.random}`)
    console.log(`[differential] total comparisons: ${counts.comparisons}`)
  })
}

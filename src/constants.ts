// 引擎/浏览器共用的常量。单放一个文件是为了 engines ↔ browser 不成循环依赖。
import { hostOf } from './utils'

// 只允许把图发给这几个域名（写死在代码里，不读配置 —— 这是安全边界，不是可调项）。
// 2026-10-29 加：iqdb.org（动漫图库）、api.trace.moe（动画截图）。
// ascii2d 试过但被 Cloudflare 拦（headless 永远停在「正在进行安全验证」），不列进来。
export const UPLOAD_HOSTS = [
  'saucenao.com', 'yandex.com', 'yandex.ru', 'bing.com', 'baidu.com', 'google.com', 'lens.google.com',
  'iqdb.org', 'trace.moe',
  // SerpApi 的 Google Lens API：不传图片字节，只给图片的公网 URL 让它自己抓
  'serpapi.com',
  // 搜索类（只在 need-search 的场合用：必应/谷歌/DDG/Brave/Startpage）
  'duckduckgo.com', 'brave.com', 'startpage.com'
]

export function hostAllowed(url: string): boolean {
  const host = hostOf(url)
  if (!host) return false
  return UPLOAD_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed))
}

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
// 无头 Edge 的默认 UA 里带 HeadlessChrome，谷歌一眼就判机器人，改成一个正常的 Chrome UA。
export const BROWSER_UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

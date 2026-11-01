# koishi-plugin-bitchfinder（鱼鱼找鸡）

给一张图，反查这人是哪个 coser、账号在哪。

- 多引擎：**谷歌 Lens**（最准，能抓到推特主页）、SauceNAO（动漫/同人）、trace.moe（动漫截屏）、IQDB、百度识图。
- 零 token：不调用任何大模型，**不花 API 钱**。
- 忠实移植自 **鱼鱼找鸡 v1.0.0**（小鲸鱼，MIT），核心算法、阈值、文案与原版一致。

## 依赖

| 需要 | 说明 |
|---|---|
| `koishi-plugin-puppeteer`（必装） | Lens / 百度识图要在真浏览器里跑，用的是它的浏览器实例。**需要在它的 `args` 里加 `--disable-blink-features=AutomationControlled`**（实测不加时 Lens 3/3 被谷歌验证码拦，加了 3/3 通过；对其他用 puppeteer 的插件无副作用） |
| 能访问谷歌 | 只用 SauceNAO / trace.moe / IQDB 的话国内直连即可；要用 Lens，要么系统能连谷歌，要么在插件配置里填 `proxy`，要么给 puppeteer 插件的启动参数加 `--proxy-server=…` |
| `koishi-plugin-chatluna`（可选） | 装了会自动注册工具 `findbitch`，让模型按需反查 |

## 用法

**引用一张图**，发 `找鸡`（或直接带图发 `找鸡`，也可以 `找鸡 <图片网址>`）。它先回「收到，开始找鸡」，再回结果：

```
🎯 鱼鱼找鸡结果

🌐 平台：Twitter
👤 名字：阿薰kaOri
🆔 账号：@izayoill · https://x.com/izayoill
```

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `engines` | `lens` | 用哪些引擎。Lens 和百度走 puppeteer 浏览器，其余直接 HTTP。默认只开 Lens：真人/coser 图靠它最准；SauceNAO/trace.moe/IQDB 只认动漫图，真人照片只会返回「看着像」的画作 |
| `serpapiKey` | 空 | 可选：SerpApi 的 Google Lens key（付费 API，免费档每月 100 次）。填了且图片有公网地址时 Lens 走 SerpApi，不依赖能连谷歌的浏览器；失败自动回退浏览器 Lens。base64/本地图没有公网地址，只能走浏览器 |
| `timeoutMs` | `45000` | 单个引擎的超时（Lens/百度至少按 30 秒算） |
| `maxAccounts` | `3` | 最多报几个账号 |
| `strictConsensus` | `true` | 开 = 名字对不上的别人的号不报（少报不错报）；关 = 全都报出来自己挑 |
| `proxy` | 空 | 只让本插件的浏览器页面走这个代理（例如 `http://127.0.0.1:7890`）。留空 = 跟随 puppeteer 插件（它会自动使用 Koishi 全局代理） |
| `foundImage` | 空 | 查到账号时顺带发的图（本机文件路径，相对路径按 Koishi 根目录算）。留空 = 不发图 |
| `cooldownSec` | `30` | 同一个人在同一个会话里的冷却秒数（反查引擎有免费额度，刷爆了大家都不能用）。`0` = 不限 |
| `registerTool` | `true` | 装了 ChatLuna 时注册工具 `findbitch`，让模型按需反查 |

## 它是怎么认的（也是「为什么有时候查不到」的原因）

1. 各引擎返回「相似图的所在页面」；
2. 从页面里抽社交账号（推特/微博/B站/Instagram/Pixiv…），作者页比帖子页可信；
3. 同一角色常有好几个 coser，只留「标题里出现同一个人名」的那一撮（`strictConsensus`）；
4. 画作平台（pixiv）上是画师的号，不是 coser 本人；只翻到 pixiv 时，回话里会明说。

## 常见问题

**Lens 一直没结果 / 报 `GOOGLE_UNREACHABLE`**
谷歌连不上。要么开系统代理，要么在配置里填 `proxy`（只让浏览器页面走），要么给 puppeteer 插件的启动参数加 `--proxy-server=…`。

**报 `GOOGLE_CAPTCHA`**
先检查 puppeteer 的 `args` 里有没有 `--disable-blink-features=AutomationControlled`（见上面依赖表）——缺这一条必被拦，页面里补丁救不回来。还有的话说明谷歌要人机验证：换 `proxy` 出口，或者先用 `saucenao,tracemoe` 顶着。

**SauceNAO 报 403 / 429**
免费额度被刷完了，等一会儿（至少 60 秒），或者少查几张。

**查到一堆别人的号**
保持 `strictConsensus: true`（默认）。它是「只报标题里出现同一个名字的人」。

**findbitch 工具报「禁止访问内网/本机地址」**
内网/127.x/10.x URL 是有意拦的（防注入探测内网）。让模型传**本机文件路径**（如 `/tmp/x.png`）或 `base64://` 数据，不要传内网 URL。

**图片会不会被上传到网上**
会——反查必须把图发给引擎（谷歌 Lens / SauceNAO / trace.moe / IQDB / 百度…）。上传目标写死在代码里的 `UPLOAD_HOSTS` 白名单里，不读配置，防止被配置改去奇怪的域名。不想上传就别用。

## 许可证

- 本插件（Koishi 移植层）AGPL-3.0，见 `LICENSE`。
- 核心逻辑移植自 **鱼鱼找鸡 v1.0.0**（作者：小鲸鱼），按 MIT 授权使用：

```
MIT License

Copyright (c) 2026 小鲸鱼

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

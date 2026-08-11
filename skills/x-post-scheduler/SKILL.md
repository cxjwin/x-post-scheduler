---
name: x-post-scheduler
description: 把资讯文章链接变成 X (Twitter) 帖子并通过 Buffer 发布/排期：抓取原文 → 自主选风格写中文摘要短评（单版本）→ 生成海报（可选）→ 发布前人工确认（可在本文件内开启全自动）→ 立即发布或按用户指定时间排期 → 原文链接放首条评论。另含长文支线：用户说「发长文」「排期 Article」时经 Typefully 发布 X Article（Typefully 亦可作短推/推串排期的备选通道）。当用户给出文章链接（AI / 编程资讯为主）并希望发到 X 时使用本 skill——即使只丢一个链接不带说明，也应触发流程（默认会在发布前请用户确认）。一次给多个链接时，逐篇独立走完整流程。注意：提示词带「深度」二字（「深度读一下」「这篇走深度」）时不走本流水线，改用 deep-read skill（互动式深读 → 讨论校准 → 读后感/线程）。
---

# x-post-scheduler：资讯 → 摘要短评 + 海报 → Buffer 发布/排期

流程共 5 步，顺序执行：抓取 → 摘要（自主选风格，单版本）→ 海报（可选）→ **发布决策（默认人工确认，可开全自动）** → Buffer 发布/排期 → 发布后报告。
用户一次给多个链接时，每篇独立走完整流程。

## 第 0 步：配置从哪来

非敏感配置（署名 handle、图床路径、输出目录等）在 `x-post-scheduler.config.json`（工作目录）或 `~/.config/x-post-scheduler/config.json`，字段说明见仓库 README。脚本会自动读取，还会自动发现 Buffer 频道和 Typefully social set（各只有一个时）。API key 走环境变量或 `~/.config/{buffer,typefully}/key` 文件。

**发现缺 key 或缺配置时**：请用户在**自己的终端**运行配置向导——

```bash
node .claude/skills/x-post-scheduler/scripts/setup.mjs
```

向导交互式引导全部配置，key 输入不回显、当场验证、不经过对话。**绝不要让用户把 key 粘贴到聊天里**；如果用户已经贴了，提醒其立即轮换（进入对话上下文即视为泄露）。

以下命令假设 skill 安装在项目 `.claude/skills/` 下；用户级安装（`~/.claude/skills/`）时自行替换前缀。

## 第 1 步：抓取原文

用 WebFetch 抓取用户给的链接，提取：

- 标题、作者 / 来源（域名）、发布时间
- 正文核心要点（优先技术细节、数字、结论，而不是背景铺垫）

注意：

- 抓取失败（反爬、需要 JS 渲染）→ 改走浏览器工具抓取；仍失败则告知用户，请其粘贴正文。
- **微信公众号（mp.weixin.qq.com）链接 WebFetch 必被反爬验证挡住，直接走浏览器**（实测）：用 chrome-devtools 类浏览器工具（`new_page`、`take_snapshot`），`new_page` 打开链接后 `take_snapshot` 即可拿到全文（真实浏览器环境可过验证）。注意：只操作自己新建的标签页，不碰用户已开的标签页。
- 遇到明显付费墙或版权声明 → 明确提醒用户，且摘要要写得更克制：不复述付费部分的细节，以公开可见的信息 + 个人视角评论为主。公众号常见的「转载请注明来源」属于常规声明，如实标注来源即可，不必过度克制。

## 第 2 步：生成摘要短评（质量关键）

### 输出结构

1. 钩子一句：说清为什么这事值得关注（要具体，不许空喊）
2. 核心要点 2~3 个
3. 视角短评一句：一线从业者的判断或自嘲式吐槽

### 长度控制

先弄清用户的 X 订阅档位（问一次记住即可）：**Premium+ 长推上限约 2.5 万字符，没有硬性字数限制，以提炼核心要点为先**；免费账号则必须压进 280 计数字符（中日韩字符计 2、ASCII 计 1、URL 固定 23）。
无论档位都要注意折叠机制：超过 280 计数字符的推文在时间线上会折叠成「显示更多」，**折叠线以上的开头 1~2 句必须把钩子和最强的信息点放进去**，它们决定点开率。
默认把短推控制在几百字以内的紧凑篇幅；内容确实撑得起时（深度长文、多要点梳理），可以放开写成长推，此时用小标题或分段保持可读性。
原文链接放首评、不占正文。

**排版**：适当增加换行改善阅读体验——钩子句、要点块、结尾短评三部分之间**空一行**分隔；要点行之间不空行、保持成块。密集文字墙在 X 上点开率低，留白是排版的一部分。

### 人设与语气

默认人设：一线 AI 从业者 / 程序员视角，务实、有信息量、偶尔自嘲，不装腔——像在跟同行聊天，不像营销号在带节奏。
（这是本 skill 最该按账号主人改写的一节：改成你自己的行业、口吻和禁忌。）

### 硬性规则

- 必须用自己的话重写，禁止整段复制原文
- 禁止标题党词汇：「震惊」「炸裂」「颠覆」「王炸」「历史性时刻」「格局变了」
- 禁止空洞感叹（「太强了」「未来已来」这类）；每条必须包含至少一个具体信息点：数字、对比或明确结论
- 摘要不能详细到读者无需点原文——要留钩子：比如点出结论但不展开推导，或三条细节只给两条

### 风格自主决策（默认单版本，不出 A/B）

按文章类型自己选风格，目标是在 X 上吸睛且有人味，选定后只写一版：

| 文章类型 | 风格 | 要领 |
|---------|------|------|
| 爆料 / 竞品交锋 / 新品发布 | 锋利对比款 | 冲突性数字放首句，短句，结尾一句毒舌断言 |
| 人物 / 故事 | 人味款 | 用最具体的细节开场（一句话、一个场景），克制抒情，落在「具体的人」上 |
| 政策 / 监管 / 行业报告 | 冷静盘点款 | 数据密度取胜，结尾给从业者视角的实用判断（checklist/红线） |
| 方法论 / 工程实践 | 干货款 | 可操作要点，第一人称从业者口吻，「我也踩过」式共鸣 |

吸睛与人味的具体手法：首句必须有让人停下来的元素（反差数字、具体场景、直接断言）；允许第一人称和口语连接词；默认不用 emoji（除非账号既有风格如此）；自嘲优于嘲讽。
用户明确要求某种风格（「暖心一点」「毒舌一点」「出两版」）时，用户指令优先。

### 示例（把握尺度用，勿当模板套）

> Cursor 把 agent 跑分刷到第一，靠的不是新模型，是把上下文窗口砍到 1/3 换速度。
> ▸ 延迟降了 60%，补全接受率反而升了
> ▸ 大上下文 ≠ 好体验，检索质量才是瓶颈
> 干这行的都懂：用户要的是快，不是全。

## 第 3 步：渲染海报（可选）

**配图是可选项**：用户说「不配图」、图床未配置、或两条渲染通道都不可用时，跳过本步直接发纯文字帖（在报告里说明原因即可，不要阻塞流程）。
配图时先提炼海报数据：标题（可直接用原文标题，也可改写得更锋利）、3 个要点（每条 ≤ 20 字的短句）、来源域名、日期。

### 首选：Codex AI 海报（Codex CLI 可用时）

用 Codex CLI 内置生图（gpt-image-2）生成，元素可以丰富些，但要保持深色科技风的品牌一致性（`<输出目录>` 为配置的 output_dir，默认 `./output`）：

```bash
codex exec --skip-git-repo-check -C <输出目录> --sandbox workspace-write \
  '$imagegen 生成一张 1536x1024 横版深色科技风推文海报，主题是「<文章主题>」。背景要素：GitHub Dark 深蓝黑底色（#0d1117），<2~3 个与文章主题呼应的视觉元素，如断裂的曲线/芯片轮廓/电路纹理/数据散点>，右下角蓝绿渐变光晕，元素丰富但不喧宾夺主。海报文字全部为简体中文且必须准确无误：顶部小号等宽字体「// <来源域名>    <日期>」；中央加粗大标题「<标题>」；标题下方三条要点，每条前用「•」圆点：「<要点1>」「<要点2>」「<要点3>」；左下角灰色等宽字体「<配置的 handle>」。文字清晰锐利、层次分明，不得出现错别字或多余文字。保存为 <日期-slug>-ai.png'
```

- 关键经验：背景视觉元素要**扣文章主题**（scaling law 断裂曲线、监管加锁、芯片带宽等），这是 AI 海报比模板强的核心价值
- **要点符号用「•」或「-」，不要用「▸」**：Hiragino 等中文叠字字体缺 ▸ 字形，会渲染成带叉豆腐块（实测踩坑）。发现豆腐块/文字错误时，让 Codex 用保留的无字底图重新叠字即可，不必重新生图
- Codex 会自行走「gpt-image-2 生成无字底图 + Pillow 本地叠字」路线，中文准确率 100%，不用干预
- 耗时约 1 分钟，每张消耗 ChatGPT 订阅额度约 90k tokens；同一篇重生成前先问用户
- 产出为 1536x1024（gpt-image-2 不支持 1200x675），X 时间线显示无碍，无需裁切
- 未配置 handle 时，署名一句从 prompt 里去掉

### 兜底：HTML 模板（Codex 不可用/失败/用户说「用模板海报」时）

```bash
node .claude/skills/x-post-scheduler/scripts/render.js \
  --data '{"title":"标题","point1":"要点一","point2":"要点二","point3":"要点三","source":"example.com","date":"2026-07-04"}' \
  --out my-post.png
```

- PNG 输出到配置的 output_dir（默认 `./output/`，脚本会自动建目录）；不传 `--out` 时文件名自动用「日期-标题 slug」；`handle` 字段缺省时自动取配置。
- 脚本报 `puppeteer-core` 未安装或找不到系统浏览器时，把它打印的安装/配置指引转告用户（或经用户同意后代为执行）。渲染器复用本机 Chrome/Edge/Chromium，不下载独立 Chromium。
- 模板在 `templates/poster.html`，配色集中在顶部 CSS 变量，方便改成自己的品牌色。

### 收尾（两种方式通用）

用 Read 打开生成的 PNG 严格目检（文字错误、豆腐块、溢出、构图问题），有问题就重渲——**全自动模式下这是发布前最后一道质检，代替了用户的眼睛，标准要从严**。

## 第 4 步：发布决策（默认人工确认）

**默认流程**：展示推文全文 + 海报（Read 展示）+ 拟发时间，等用户明确确认（「发」）后才执行第 5 步。用户提出修改立即执行后再次确认。

时间规则：

- 用户未指定时间 → 确认后 `mode: shareNow` 立即发布
- 用户指定时间（「明晚 8 点」「13:30 发」）→ `customScheduled` 按时排期；若确认/处理时指定时间已过，就近立即发布并在报告中说明
- 指定时间但表述模糊（如深夜说「9 点」）→ 按最近的未来时点理解，并在报告中写明所选时间

### 全自动发布开关（账号主人信任本流程后可开启）

```
自动发布授权：未授权
```

账号主人把上面一行改成「已授权（YYYY-MM-DD）」即视为持续授权，此后：**贴链接即视为发布指令，无需逐条确认**——不指定时间立即发布，指定时间按时排期。第 6 条的发布后报告是自动模式的核心补偿机制，必须完整执行。

**红线回退（无论是否授权全自动，以下情形都必须停下展示内容等用户明确确认）：**

1. 文章涉及政治敏感话题、重大灾难/死亡事件、需要站队的争议性社会事件
2. 内容包含对具体个人或公司的负面指控，且原文未给出可核实的信源
3. 明显付费墙内容（版权风险）
4. 抓取到的正文与标题严重不符、疑似不实信息，无法在一次搜索内核实关键事实

拿不准是否踩线时，宁可停下来问。

## 第 5 步：通过 Buffer 发布/排期

1. 优先用 Buffer MCP 工具（若已配置）。**没有 Buffer MCP 时不必停下**——用脚本直连发布（能力与 create_post 等价，任何有 node 的环境可用）：

```bash
# 先做连通检查（不发帖）
node .claude/skills/x-post-scheduler/scripts/buffer-post.mjs --check
# 发布（文本写入临时文件避免转义问题；不带 --due-at 即立即发）
node .claude/skills/x-post-scheduler/scripts/buffer-post.mjs \
  --text-file /tmp/tweet.txt \
  --image-url "<图床 raw URL>" --alt "<海报描述>" \
  --first-comment "原文：<URL>" \
  [--due-at "2026-07-11T08:00:00+08:00"]
```

   token 自动从环境变量 `BUFFER_TOKEN`、`~/.config/buffer/key` 或 `~/.claude.json` 读取；频道未配置时自动发现（恰好一个 X 频道时）。都解析不到才停下来请用户配置；Buffer 整条通道不可用（无 token / 免费版排期额度满）时，可改走 Typefully 短推通道（见附录），发布决策规则不变。
2. 时间换算：用户用自然语言说时间（「明晚 8 点」「周五中午」），按**用户本地时区**换算成带偏移的 ISO 时间；先用 `date` 命令确认当前真实日期再算，不要凭感觉推。Buffer `get_account` 返回的 `currentTime` 可直接做锚点。
3. 有配图时，上传海报图到图床仓库（`<assets_dir>` 为配置的图床本地克隆；自动模式下在海报目检通过后即可执行，人工确认/红线情形则等用户确认后再推）：

```bash
cp <PNG路径> <assets_dir>/<日期-slug>.png \
  && git -C <assets_dir> add -A \
  && git -C <assets_dir> commit -m "poster: <slug>" \
  && git -C <assets_dir> push
```

   raw URL = `<assets_raw_base>/<日期-slug>.png`（前缀取配置，缺省时按 `https://raw.githubusercontent.com/<user>/<repo>/<branch>/` 推导）；push 后用 `curl -sI` 确认返回 200 再进入下一步。
   - **curl 返回 429 时不要等**（实测）：那是 GitHub 对本机 curl 的限流，Buffer 服务器从自己的 IP 取图不受影响——只要 push 成功就直接发帖，让 Buffer 自己验证。曾为等 429 恢复挂轮询，机器休眠导致帖子迟发一天半，教训。
   - **确认后因故障挂起的补发规则**：恢复执行时若距用户确认超过 12 小时，先向用户重新确认再发，不直接补发。
4. 创建排期帖：text 用选定文案，图片放海报 raw URL（altText 填海报标题），首评走 thread（见下方已验证配置）。
5. 首条评论放原文链接：
   - Buffer 的 thread / 首评能力可用 → 把「原文：{URL}」作为首评一起排期（脚本的 `--first-comment` 即此通道）
   - 不可用 → 把待发文本追加到项目根目录 `pending-replies.md`（格式见下），并提醒用户在推文发出后手动补评论
6. **发布后报告（自动模式的核心补偿机制，必须完整；人工确认模式下也要给发布结果）**：推文全文、海报图（Read 展示）、所选风格及一句理由、发布链接（`get_post` 的 `externalLink`）或排期时间（含时区）、Buffer 队列状态。并提醒：回「删掉」即可撤下（已排期的直接取消；已发出的删除 Buffer 记录并同步删推）。用户看报告提出的任何修改，立即执行（改文案 = 删旧发新）。

`pending-replies.md` 追加格式（文件不存在则创建）：

```markdown
## 2026-07-05 20:00 (Asia/Shanghai) — 推文标题或前 20 字
原文：https://example.com/article
```

## 附：Typefully 通道（长文 X Article + 短推备选）

短推默认走 Buffer；**长文 Article（标题 + 富文本 + 封面的文章格式）Buffer 做不了，走 Typefully API**（实测全链路可用；X 原生也不支持 Article 排期，Typefully 是目前的 API 通道）。触发场景：用户说「发长文」「排期这篇 Article」「把这篇 Markdown 发到 X」等。`typefully-post.mjs` 同时支持短推/推串（见本节末尾），作为 Buffer 的备选排期通道。

```bash
# 连通检查
node .claude/skills/x-post-scheduler/scripts/typefully-post.mjs --check
# 创建/排期 Article（正文直接吃 Markdown，标题自动取首个 H1）
node .claude/skills/x-post-scheduler/scripts/typefully-post.mjs \
  --markdown-file 文章.md \
  [--cover 封面.png] \
  [--no-gist | --gist-url "已有 Gist URL"] \
  [--publish-at "2026-07-16T08:00:00+08:00" | --publish-at now]   # 不带此参数=仅存草稿；now=立即发布
```

规则：

- **Article 发布保留人工确认**（这是作品级内容，不适用短推的自动发布授权）：默认先创建**草稿**，把预览链接（`private_url`）给用户，用户在 Typefully 里核对排版后，再按用户给的时间排期或立即发布
- 发布方式：`--publish-at` 传明确 ISO 时间则排期，传 `now` 则立即发布（脚本会把 `now` 转成近未来 ISO——**Typefully 不接受 "now" 字符串，直传会被静默当草稿存下、不发布**）；不带 `--publish-at` 仅存草稿
- **发布后必须回读真实状态**：创建响应里的 `status` 是瞬时值（`publish_at` 生效后其实可能已 published，响应仍显示 draft），脚本已内置轮询 `GET drafts/{id}` 确认最终状态并打印 `x_article_published_url`，别只信创建响应
- token 从环境变量 `TYPEFULLY_KEY` 或 `~/.config/typefully/key` 读取；social set 未配置时自动发现（恰好一个时）
- 多行代码块默认汇总成**一篇 Article 一个 secret Gist**：gist 内是单个 markdown 文档，「## 代码块 N」中文标题与正文代码图的标题栏一字不差，GitHub 渲染后每块自带复制按钮；每张代码图下附「复制 代码块 N」深链，按标题锚点（`#代码块-N` 的 percent-encoded 形式）直达对应小节。认证按已登录 `gh` CLI → `GH_TOKEN`/`GITHUB_TOKEN`。认证不可用时只警告并继续发文；`--no-gist` 可关闭，`--gist-url` 可复用已有 Gist，避免重建
- 已验证的 API 事实：`x_article.content_markdown` 为正文字段，**文章标题取自正文首个 H1**（`x_article` 下没有 `title` 字段，传了报 422 extra_forbidden）；封面走 `--cover`（顶层 `cover_media_id`）；frontmatter 会被脚本自动剥掉。改错草稿用 `DELETE /v2/social-sets/{ss}/drafts/{id}`（实测返回 204；已发布的 Article 删 Typefully 记录**不撤回** X 上的原生文章，需在 X 手动删）
- 发布 Article 需要账号有 X Premium

### X 化排版预处理（typefully-post.mjs 自动执行）

X Article 的 markdown 子集只支持标题(H1/H2)/粗体/引用/列表/链接——fenced code 会降级成引用、表格不渲染、行内反引号原样显示，而且**正文图必须是 Typefully 上传的媒体、用 `<typ:media media_id="..." />` 标签嵌入，外链 markdown 图 `![](url)` 不会渲染、只显示成链接文本**（实测踩过大坑）。`typefully-post.mjs` 发长文前自动调用 `md-assets.mjs` 按元素分流（`--no-transform` 可关闭）：

| 元素 | 处理 |
|------|------|
| 多行代码块 | 渲染成语法高亮 PNG，**图上带「代码块 N · 语言」标题栏**（freeze github-dark 出图后复合标题；**代码含中文或 freeze 不可用时退回系统浏览器深色模板**，freeze 对 CJK 缺字体防豆腐块），上传 Typefully 后以 `<typ:media>` 原位嵌入；图下附「复制 代码块 N」深链直达 gist 内同标题小节 |
| 单行代码块 | 转正文文本行（shell 类语言加「$ 」前缀），不出图 |
| 表格 ≤2 列且 ≤8 行 | 改写成「- **键**：值」列表（手机端列表比表格图好读，这是升级不是妥协） |
| 更大的表格 | 深色 GitHub 风 PNG（#0d1117 底，与海报视觉统一），同样走 `<typ:media>` 嵌入 |
| 行内代码 | `xxx` → 「xxx」（X 无等宽格式，反引号只会原样显示） |
| H3~H6 标题 | 降级成 **加粗行**（X Article 标题层级有限） |

- **正文图走 Typefully 媒体，不走 github 图床**：`typefully-post.mjs` 把图生成到本地临时目录，逐张 `media/upload`（POST 拿预签名 URL → 裸 PUT 字节 → 轮询 `ready`）拿 `media_id` 再替换成 `<typ:media>`。所以发 Article **不需要 `assets_dir` 图床**（那是短推 Buffer 用的），也不用担心图床图被删导致文章裂图
- **上传的 `file_name` 必须是 ASCII**：Typefully 校验 `^[a-zA-Z0-9_.()\-]+\.(png|jpg|...)$`，中文名会 422；脚本用 `code-1.png`/`table-1.png` 这类 ASCII 名，与本地中文 slug 解耦
- 依赖 freeze：`brew install charmbracelet/tap/freeze`；未安装不阻塞，所有代码块走 **puppeteer-core + 系统浏览器**兜底——所以**发带代码块/表格的长文，`npm install` 与本机 Chrome/Edge/Chromium 是必需条件**（`cd scripts && npm install`），也可用 `CHROME_PATH` 显式指定浏览器
- Gist 通道自检：`node .claude/skills/x-post-scheduler/scripts/gist.mjs --check`（只检查认证，不创建 Gist）
- 独立自测（`md-assets.mjs --test` 默认不 push、图片落在 `<output_dir>/md-assets-test/`，仅用于肉眼检查转换结果）：

```bash
node .claude/skills/x-post-scheduler/scripts/md-assets.mjs --test 文章.md
```

- 实测坑：node 里 `execFileSync` 调 freeze 时 stdin 必须给 `ignore`——给 `pipe` 的话 freeze 会认为输入来自 stdin，忽略文件参数报 "No input"（脚本内已处理，改脚本时别动这行）

### Typefully 短推/推串（Buffer 的备选排期通道）

`typefully-post.mjs` 也能发短推/推串（`platforms.x`）。短推默认仍走 Buffer，以下情形改走这条通道：Buffer 不可用或免费版排期额度满（10 条）、配图不想经 GitHub 图床（Typefully 本地文件直传，没有「排期帖没发出前图床图不能删」的约束）、或想用 `next-free-slot` 排进 Typefully 队列的下一个空档。

```bash
# 单条短推（--image 为本地文件路径，可重复、均挂首条，X 单推上限 4 张；无需图床）
node .claude/skills/x-post-scheduler/scripts/typefully-post.mjs \
  --text-file /tmp/tweet.txt \
  [--image 海报.png] [--first-comment "原文：<URL>"] \
  [--publish-at "2026-07-16T08:00:00+08:00" | --publish-at now | --publish-at next-free-slot]
# 推串：与 buffer-post.mjs 同格式（各条之间用单独一行 --- 分隔），--first-comment 追加为最后一条
node .claude/skills/x-post-scheduler/scripts/typefully-post.mjs --thread-file /tmp/thread.txt [同上可选参数]
# 发前自检：--dry-run 打印分条与每条加权字数（口径同 buffer-post.mjs），不联网、不建草稿
node .claude/skills/x-post-scheduler/scripts/typefully-post.mjs --thread-file /tmp/thread.txt --dry-run
```

- **第 4 步发布决策与红线回退同样适用本通道**：换通道不改确认规则，自动发布授权对两条短推通道一体生效
- 不带 `--publish-at` 仅存草稿（打印 `private_url` 预览链接）；`now` 的处理与 Article 相同（脚本转近未来 ISO 再排期）
- 已验证的 API 事实（实测）：短推走 `platforms.x`，`enabled: true` 必填、`posts[]` 每项一条推文（上限 50 条）；**配图挂在 `posts[].media_ids`**（每条上限 10，X 实际单推上限 4 张图），媒体上传与 Article 共用一条通道（ASCII 文件名约束同样适用）；`x_article` 平台是 standalone、**不能与 `x` 平台混在同一草稿**（脚本因此把 `--markdown-file` 与 `--text-file/--thread-file` 设计为互斥）；Typefully 媒体上传**没有 alt 文本字段**（配图需要无障碍描述时用 Buffer 通道的 `--alt`）；短推发布后的链接字段是 `x_published_url`（脚本轮询时已打印）

## 附：已验证的 Buffer API 事实（实测，供排错参考）

- 频道 ID 用 `list_channels` 确认；报「channel not found」时重新确认（脚本的自动发现即此流程）
- **图片限制：`assets[].image.url` 只收可公开访问的 URL，不能直接传本地 PNG 路径**。已用 `introspect_schema` 确认：GraphQL 没有任何媒体上传 mutation，不用再探查
- **图片清理策略（实测确认）**：`get_post` 返回的 `assets[].source` 保持原 raw URL，**Buffer 不转存图片**。因此：排期未发出的帖子，图床上的图绝不可删；帖子发出（status: sent）后随便删（X 已转存到 pbs.twimg.com）
- **thread 首评（实测确认可用）**：外层 `text` 与 `metadata.twitter.thread[0].text` 一致，图片资产同时放外层 `assets` 和 `thread[0].assets`，首评「原文：{URL}」作为 `thread[1]`，一次 `create_post` 即完成主推 + 首评。多条线程（deep-read skill 用）走同一通道：脚本 `--thread-file`（各条之间用单独一行 `---` 分隔）把全部条目放进 `thread[]`；>2 条属 MCP schema 文档能力、尚未单独实测，首发后到 X 核对整串
- 排期模式：明确时间用 `mode: customScheduled` + `dueAt`（ISO 8601 带时区偏移，**必须是未来时间**）；`schedulingType` 用 `automatic`（自动发布）
- 免费版限额：3 频道 / 10 条排期，够个人号用

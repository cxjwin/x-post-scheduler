# x-post-scheduler

把内容变成 X (Twitter) 帖子的 Claude Code Skill 套件：丢一个文章链接，agent 自动抓取、写摘要短评、生成海报、经 Buffer 发布或排期；也能写段子、发长文 Article，或加「深度」二字进入精读模式——讨论校准观点后排成读后感/线程。

![AI 海报示例：Codex gpt-image-2 生成底图 + Pillow 叠字，中文 100% 准确](docs/example-poster.png)

> **English**: A Claude Code skill suite that turns content into X (Twitter) posts. Drop an article link and the agent fetches it, writes a commentary-style summary in your voice, generates a themed poster (optional, via Codex `gpt-image-2` or a Puppeteer HTML template), and publishes/schedules through Buffer — with the source link as the first reply. Also includes an original-meme skill, an interactive deep-reading mode (full-text read → viewpoint discussion & calibration with you → reflection post or thread), and long-form X Article publishing via Typefully (with automatic Markdown→X-flavor preprocessing: code blocks → syntax-highlighted images, tables → lists or images; Typefully also doubles as an alternative channel for scheduling regular posts/threads, with local media upload — no image-hosting repo needed). Docs below are in Chinese; the scripts are zero-dependency Node and self-documenting.

## 四大功能

| 功能 | 入口 | 配图 | 发布通道 | 确认策略 |
|------|------|------|---------|---------|
| **资讯短推** | 丢一个文章链接 | 海报（可选：AI 生成 / HTML 模板 / 不配图） | Buffer（备选 Typefully，图免图床直传） | 默认发布前确认，可开全自动 |
| **深度读后感/线程** | 链接 + 提示词带「深度」 | 默认不配图 | Buffer（长推/线程），超长可走 Typefully | 全程讨论校准，必须人工确认（不适用自动授权） |
| **段子短推** | 「来条段子」「这个帖子二创一下」 | 原帖有图才二创配图（可选） | Buffer | 必须人工挑选（不适用自动授权） |
| **长文 Article** | 「发长文」「把这篇 Markdown 排期成 Article」 | 封面（可选） | Typefully | 先建草稿给预览链接，确认后排期 |

## 工作原理

```
文章链接 ─→ 抓取（WebFetch，反爬时走浏览器）
         ─→ 摘要短评（自主选风格：锋利对比/人味/冷静盘点/干货）
         ─→ 海报（可选：Codex gpt-image-2 AI 海报 → HTML 模板兜底 → 纯文字）
         ─→ 图床（你的 GitHub 公开仓库，raw URL 引用）
         ─→ Buffer 发布/排期（原文链接放首条评论）
         ─→ 发布后报告（推文链接 / 排期时间，回「删掉」即撤）

长文 Markdown ─→ X 化排版（代码块→高亮图 + Gist 复制链接，表格→列表/图，行内码→「」）
             ─→ Typefully 草稿（标题取 H1，可传封面）─→ 预览确认 ─→ 排期

链接 +「深度」─→ 细读全文 ─→ 总结 + 观点讨论底稿 ─→ 与你多轮讨论、校准立场
            ─→ 读后感长推 / 3~7 条线程（每条自动算计数字符）─→ 确认后 Buffer 发布/排期
```

设计上有两条底线：

1. **默认不自动发布。** 每次发布前展示全文 + 配图 + 拟发时间等你确认；确认成本低到只回一个「发」。信任建立后可在 SKILL.md 里打开全自动开关（见下），但涉政、灾难、无信源指控、付费墙这四条红线内容永远回退人工确认。
2. **不搬运、不侵权。** 摘要必须重写并留钩子引流原文；段子只提取梗格式、绝不碰原图原句。

## 前置依赖

| 依赖 | 用途 | 必需？ |
|------|------|-------|
| [Claude Code](https://claude.com/claude-code) | 运行 skill 的 agent | ✅ |
| Node.js ≥ 18 | 全部脚本（零 npm 依赖，`fetch` 内置） | ✅ |
| [Buffer](https://buffer.com) 账号 + API key | 短推发布/排期（免费版够用：3 频道 / 10 条排期） | ✅（短推） |
| GitHub 公开仓库 ×1 | 短推配图图床（Buffer 只收公开 URL，不能传本地文件；**长文 Article 正文图走 Typefully 媒体，不用图床**） | 短推配图时 |
| [Codex CLI](https://github.com/openai/codex) | AI 海报（`gpt-image-2` 生底图 + Pillow 叠字，中文 100% 准确） | 可选 |
| Puppeteer Core + 系统浏览器 | HTML 模板海报兜底、代码块/表格转图；复用已安装的 Chrome/Edge/Chromium，不另下载浏览器 | **发带代码/表格的长文必需**（`cd skills/x-post-scheduler/scripts && npm install`）；纯短推可省 |
| [Typefully](https://typefully.com) 账号 + API key | 长文 X Article 排期（X 原生不支持 Article 排期）；也可发短推/推串，作为 Buffer 的备选通道（配图本地直传，免图床） | 可选（长文/短推备选） |
| [freeze](https://github.com/charmbracelet/freeze) | 代码块语法高亮图（`brew install charmbracelet/tap/freeze`） | 可选（缺了走 Puppeteer 兜底） |
| [GitHub CLI](https://cli.github.com/) 或带 Gist 权限的 token | 为 Article 的代码图生成可复制源码链接（一篇文章一个 secret Gist） | 可选（失败只警告，不阻塞发文） |

发 Article 需要 X 账号有 Premium；长推不限字数需要 Premium+（免费账号 skill 会按 280 计数字符控制篇幅）。

## 安装（两条命令）

```bash
git clone https://github.com/cxjwin/x-post-scheduler.git && cd x-post-scheduler
node skills/x-post-scheduler/scripts/setup.mjs
```

第二条是**交互式配置向导**（约 2 分钟，零依赖），跟着提示走完就能用。它会：

- 把 skill 装进 `~/.claude/skills/`（或你指定的项目）
- 引导输入 Buffer / Typefully API key——**输入不回显，当场验证连通性**，写入 `~/.config/{buffer,typefully}/key`（权限 600）
- 自动发现你的 X 频道和 Typefully social set（多个才让你选）
- 图床仓库：已登录 `gh` 的话**一键创建 + 克隆**，没有就填已有克隆路径或先跳过
- 每一步都可跳过，重跑不会弄丢已配好的项——随时补配

## 手动配置（不想用向导，或想了解细节）

### 1. API key（敏感，走文件或环境变量，**永远不要粘贴进和 agent 的聊天里**）

```bash
# Buffer：https://publish.buffer.com/settings/api 生成
mkdir -p ~/.config/buffer && echo 'YOUR_BUFFER_KEY' > ~/.config/buffer/key
# Typefully（可选）：Settings → API 生成
mkdir -p ~/.config/typefully && echo 'YOUR_TYPEFULLY_KEY' > ~/.config/typefully/key
```

环境变量 `BUFFER_TOKEN` / `TYPEFULLY_KEY` 优先于文件。如果你在 Claude Code 里配置了 Buffer 官方 MCP（`~/.claude.json`），脚本也会自动从那里读 token。

### 2. 其余配置（非敏感）

复制 `config.example.json` 到 `~/.config/x-post-scheduler/config.json`（或放在工作目录下命名为 `x-post-scheduler.config.json`，就近优先）：

| 字段 | 说明 | 不填时 |
|------|------|--------|
| `handle` | 海报署名，如 `@your_handle` | 海报不署名 |
| `buffer_channel_id` | Buffer 的 X 频道 ID | **自动发现**：账号下只有一个 X 频道时自动选用 |
| `typefully_social_set` | Typefully social set ID | **自动发现**：只有一个时自动选用 |
| `assets_dir` | 图床仓库的本地克隆路径 | 需要配图的功能会提示先配置 |
| `assets_raw_base` | 图床 raw URL 前缀 | **自动推导**：从 `assets_dir` 的 git remote 算出 `https://raw.githubusercontent.com/<user>/<repo>/<branch>/` |
| `output_dir` | 海报/中间产物输出目录 | 工作目录下的 `./output/` |

对应环境变量（优先级更高）：`XPS_HANDLE`、`XPS_BUFFER_CHANNEL`、`XPS_TYPEFULLY_SOCIAL_SET`、`XPS_ASSETS_DIR`、`XPS_ASSETS_RAW_BASE`、`XPS_OUTPUT_DIR`。

### 3. 图床仓库（需要配图时）

```bash
# GitHub 上新建一个公开仓库（如 post-assets），克隆到本地，路径填进 assets_dir
git clone https://github.com/<you>/post-assets.git
```

注意：Buffer **不转存图片**（`assets[].source` 一直指向你的 raw URL），所以**排期未发出的帖子，图床上的图不能删**；帖子发出后 X 会转存到 `pbs.twimg.com`，之后随便清理。

### 4. 连通性自检

```bash
node skills/x-post-scheduler/scripts/buffer-post.mjs --check
node skills/x-post-scheduler/scripts/typefully-post.mjs --check   # 用长文或 Typefully 短推通道才需要
node skills/x-post-scheduler/scripts/gist.mjs --check             # Article 代码复制链接
```

## 使用

装好后直接在 Claude Code 里说人话：

```
https://example.com/some-article            ← 丢链接，走完整流程，发布前给你确认
https://example.com/some-article 明早 8 点发  ← 指定时间则排期
这篇暖心一点 / 毒舌一点 / 不配图            ← 风格和配图都可以指定
https://example.com/some-article 深度读一下   ← deep-read skill：总结+观点→讨论校准→读后感/线程
来条段子 / 看看今天有什么梗                  ← meme-post skill
把这篇 Markdown 发成长文 Article，周五中午    ← Typefully 长文支线
删掉                                        ← 发布后报告里随时反悔
```

### 开启全自动发布（可选，信任后再开）

编辑 `skills/x-post-scheduler/SKILL.md`「发布决策」一节，把授权行改为已授权并署日期。之后丢链接即视为发布指令：不指定时间立即发、指定时间按时排期，agent 发完交完整报告（全文/配图/链接/撤回方式）。四条红线内容仍会停下来等确认。

## 已踩过的坑（都写进 SKILL.md 了，agent 会自动规避）

- **GitHub raw 返回 429 不用等**——那是对你本机 curl 的限流，Buffer 服务器从自己的 IP 取图不受影响，push 成功就直接发。
- **海报要点符号用「•」别用「▸」**——中文字体缺 ▸ 字形，会渲染成豆腐块。
- **X Article 的 Markdown 子集很小，正文图还必须走 Typefully 媒体**——代码块降级成引用、表格不渲染、行内反引号原样显示，而且**外链 markdown 图 `![](url)` 不会内嵌、只显示成链接文本**（实测踩过）。`md-assets.mjs` + `typefully-post.mjs` 自动分流：多行代码/大表格→图片并**上传 Typefully、用 `<typ:media>` 标签嵌入**（不走 github 图床），多行代码另建一个 secret Gist 并在每张图下附复制深链；小表格→列表、行内码→「」、H3+→加粗行。Gist 认证不可用时只跳过复制链接，不阻塞 Article。
- **Typefully 的 Article 标题取自正文首个 H1**，`title` 字段不存在（传了报 422）；frontmatter 会被自动剥掉。
- **`dueAt` 必须是未来时间**——确认拖过了预定时间就近立即发，agent 会在报告里说明。
- **freeze 的 stdin 必须接 `/dev/null`**——给 pipe 它会忽略文件参数报 "No input"（脚本内已处理）。
- **Typefully `media/upload` 的 `file_name` 必须是 ASCII**——中文文件名会 422（校验 `^[a-zA-Z0-9_.()\-]+\.ext$`），脚本已用 `code-1.png` 这类 ASCII 名上传，与本地中文 slug 解耦。
- **`--publish-at now` 别直传给 Typefully**——它不认 "now" 字符串（会被静默当草稿存下、不发布），脚本已改成转近未来 ISO；且发布后要回读 `GET drafts/{id}` 确认真实状态（创建响应的 `status` 是瞬时值，可能显示 draft 但其实已 published）。
- **Typefully 短推配图挂在 `posts[].media_ids`，不在草稿顶层**——顶层没有 `media` 字段（schema 是 `additionalProperties: false`，多传会 422）；`x_article` 是 standalone 平台，**不能与 `x` 平台混在同一草稿**（脚本已把长文/短推做成互斥模式）；Typefully 媒体上传没有 alt 文本字段，配图需要无障碍描述时用 Buffer 通道的 `--alt`。

## 目录结构

```
skills/
├── x-post-scheduler/        # 资讯短推 + 长文 Article
│   ├── SKILL.md             # 流程、风格规范、红线、全部实测经验
│   ├── scripts/
│   │   ├── config.mjs       # 配置加载（config.json + 环境变量 + 自动发现）
│   │   ├── buffer-post.mjs  # Buffer 发布（零依赖，直连 MCP 端点；--thread-file 发线程，--dry-run 自检字数）
│   │   ├── typefully-post.mjs # Typefully 长文 Article + 短推/推串（--text-file/--thread-file，--dry-run 自检字数）
│   │   ├── md-assets.mjs    # Markdown → X 化排版预处理
│   │   ├── gist.mjs         # Article 代码块 → 单个多文件 Gist（可复制源码）
│   │   ├── browser.mjs      # 复用系统 Chrome/Edge/Chromium
│   │   └── render.js        # HTML 模板海报兜底（需 puppeteer-core）
│   └── templates/poster.html
├── deep-read/               # 深度阅读 → 讨论校准 → 读后感/线程
│   └── SKILL.md
└── meme-post/               # 热梗雷达 → 原创二创段子
    └── SKILL.md
```

`buffer-post.mjs` / `typefully-post.mjs` 不依赖 Claude Code——任何能跑 Node 的 agent（或你自己的 CLI）都能直接调用。

## License

MIT

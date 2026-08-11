#!/usr/bin/env node
// Typefully 发布脚本：通过 API v2 创建/排期 X 内容，两种模式：
//   长文 X Article（--markdown-file，platforms.x_article）和短推/推串（--text-file / --thread-file，platforms.x）。
// 零依赖，任何有 node 的环境可用。短推排期与 buffer-post.mjs 互为备选通道：
//   Buffer 要求配图是公网 URL（走 GitHub 图床）；Typefully 本地图直传（media/upload），
//   且 --publish-at next-free-slot 可排进 Typefully 队列的下一个空档。
//
// 用法：
//   node typefully-post.mjs --check
//       连通性检查（列出 social sets，不产生任何草稿）
//   node typefully-post.mjs --markdown-file article.md \
//       [--publish-at "2026-07-16T08:00:00+08:00" | --publish-at now | --publish-at next-free-slot] \
//       [--cover /path/to/cover.png] [--draft-title "内部草稿名"] [--social-set <id>] \
//       [--no-transform] [--no-gist | --gist-url <已有 gist URL>]
//       创建 X Article：正文为 Markdown，文章标题自动取自首个 # 一级标题。
//       不带 --publish-at 时仅存为草稿（可在 Typefully 里预览后再排期）。
//   node typefully-post.mjs --text-file tweet.txt \
//       [--image /path/img.png（可重复，均挂首条，X 单推上限 4 张）] \
//       [--first-comment "原文：https://..."] [--publish-at 同上] [--draft-title ...] [--social-set <id>]
//       发单条短推。配图为本地文件路径，直传 Typefully，不经 GitHub 图床。
//   node typefully-post.mjs --thread-file thread.txt [同上可选参数]
//       发推串：文件内各条推文之间用「单独一行 ---」分隔（与 buffer-post.mjs 同格式），
//       --first-comment 追加为最后一条。与 --text-file 互斥。
//   短推模式加 --dry-run：只打印分条结果和每条的 X 计数字符估算（口径同 buffer-post.mjs），
//       不做任何网络请求、不建草稿。
//
// token 来源（按序）：环境变量 TYPEFULLY_KEY → ~/.config/typefully/key 文件。
// social set 来源（按序）：--social-set → 配置（XPS_TYPEFULLY_SOCIAL_SET / config.json 的
//   typefully_social_set）→ 自动发现（账号下恰好一个时自动选用）。

import { readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join } from 'path';
import { transformMarkdownBody } from './md-assets.mjs';
import { loadConfig } from './config.mjs';
import { buildGistDoc, createCodeGist, extractCodeFiles } from './gist.mjs';

const BASE = 'https://api.typefully.com';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function getToken() {
  if (process.env.TYPEFULLY_KEY) return process.env.TYPEFULLY_KEY.trim();
  try { return readFileSync(`${homedir()}/.config/typefully/key`, 'utf8').trim(); } catch {}
  console.error('错误：未找到 Typefully key。请设置环境变量 TYPEFULLY_KEY，或写入 ~/.config/typefully/key（key 在 Typefully Settings → API 生成）。');
  process.exit(1);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--check') a.check = true;
    else if (k === '--markdown-file') a.mdFile = argv[++i];
    else if (k === '--text-file') a.textFile = argv[++i];
    else if (k === '--thread-file') a.threadFile = argv[++i];
    else if (k === '--image') (a.images ??= []).push(argv[++i]);
    else if (k === '--first-comment') a.firstComment = argv[++i];
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--publish-at') a.publishAt = argv[++i];
    else if (k === '--cover') a.cover = argv[++i];
    else if (k === '--draft-title') a.draftTitle = argv[++i];
    else if (k === '--social-set') a.socialSet = argv[++i];
    else if (k === '--no-transform') a.noTransform = true;
    else if (k === '--no-gist') a.noGist = true;
    else if (k === '--gist-url') a.gistUrl = argv[++i];
  }
  return a;
}

async function api(method, path, token, body, rawBody) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(rawBody ? {} : { 'Content-Type': 'application/json' }),
    },
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data?.error) {
    console.error(`Typefully API 错误（HTTP ${res.status}）：`, JSON.stringify(data?.error || data).slice(0, 500));
    process.exit(1);
  }
  return data;
}

// 上传单个媒体到 Typefully：POST 拿预签名 URL → 裸 PUT 字节 → 轮询 ready → 返回 media_id。
// 封面和 X Article 正文图都走这里。file_name 必须是 ASCII：Typefully 校验
// ^[a-zA-Z0-9_.()\-]+\.(png|jpg|jpeg|webp|gif|mp4|mov|pdf)$，中文文件名会 422，
// 所以用调用方给的 ASCII label + 原扩展名，与本地文件名（可能是中文 slug）解耦。
async function uploadMedia(token, socialSet, filePath, label) {
  const ext = filePath.split('.').pop().toLowerCase();
  const up = await api('POST', `/v2/social-sets/${socialSet}/media/upload`, token, { file_name: `${label}.${ext}` });
  if (!up.upload_url || !up.media_id) {
    console.error('媒体上传接口返回异常：', JSON.stringify(up).slice(0, 300));
    process.exit(1);
  }
  const put = await fetch(up.upload_url, { method: 'PUT', body: readFileSync(filePath) });
  if (!put.ok) { console.error(`媒体 PUT 上传失败：HTTP ${put.status}（${label}.${ext}）`); process.exit(1); }
  // 上传后需处理完成才能被草稿引用，否则报 "still processing"
  for (let i = 0; i < 40; i++) {
    const st = await api('GET', `/v2/social-sets/${socialSet}/media/${up.media_id}`, token);
    if (st.status === 'ready') return up.media_id;
    if (st.status === 'failed') { console.error(`媒体处理失败：${up.media_id}（${st.error_reason || ''}）`); process.exit(1); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`媒体处理超时：${up.media_id}`);
  process.exit(1);
}

async function listSocialSets(token) {
  const sets = await api('GET', '/v2/social-sets', token);
  return Array.isArray(sets) ? sets : sets.results || sets.data || [sets];
}

// social set 自动发现：恰好一个时直接用；多个时列出并退出。
async function resolveSocialSet(token, cfg, arg) {
  if (arg) return arg;
  if (cfg.typefullySocialSet) return cfg.typefullySocialSet;
  const items = await listSocialSets(token);
  if (items.length === 1) {
    console.error(`social set 自动发现：${items[0].id}（${items[0].name} / @${items[0].username}）`);
    return String(items[0].id);
  }
  console.error('错误：账号下有多个 social set，请在配置中指定 typefully_social_set：');
  for (const s of items) console.error(`  ${s.id}  ${s.name}  @${s.username}`);
  process.exit(1);
}

// X 计数字符估算（与 buffer-post.mjs 的 xWeight 保持同一口径，改动请两边同步）：
// URL 记 23；twitter-text v3 权重 1 的区间（基本拉丁等）记 1，其余（含 CJK；emoji 按码点会略高估）记 2。
function xWeight(s) {
  let n = 0;
  const rest = s.replace(/https?:\/\/\S+/g, () => { n += 23; return ''; });
  for (const ch of rest) {
    const c = ch.codePointAt(0);
    n += (c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037)) ? 1 : 2;
  }
  return n;
}

// 创建草稿并打印结果（长文/短推两种模式共用）。
// publish_at 用 rawPublishAt 在这里最后一刻处理：不用 "now" 字符串——生产验证过它会被静默当
// 草稿存下（官方 spec 后来注明 "now" 是异步发布、status 短暂停留在 draft，需另查 publish_state），
// 转成近未来 ISO 走排期路径最稳；且必须在所有慢操作（排版转图、媒体上传）之后才计算，
// 否则时间戳可能已成过去时。明确的 ISO 时间 / next-free-slot 原样传。
async function createDraftAndReport(token, socialSet, payload, rawPublishAt, { titleFallback } = {}) {
  const wantNow = rawPublishAt === 'now';
  const publishAt = wantNow ? new Date(Date.now() + 30000).toISOString() : rawPublishAt;
  if (publishAt) payload.publish_at = publishAt;

  const draft = await api('POST', `/v2/social-sets/${socialSet}/drafts`, token, payload);
  const draftId = draft.draft_id || draft.id;
  console.log(`结果：status=${draft.status} draft_id=${draftId}`);
  if (draft.draft_title || titleFallback) console.log(`标题：${draft.draft_title || titleFallback}`);
  if (draft.private_url) console.log(`预览链接：${draft.private_url}`);

  // 发布后回读真实状态：创建响应里的 status 是瞬时值（publish_at 生效后其实可能已 published，
  // 但响应仍显示 draft），有 publish_at 时轮询 GET 确认最终状态并取发布链接。
  if (!publishAt) return;
  for (let i = 0; i < 30; i++) {
    const d = await api('GET', `/v2/social-sets/${socialSet}/drafts/${draftId}`, token);
    if (d.status === 'published') {
      console.log(`已发布：${d.x_article_published_url || d.x_published_url || '(X 链接稍后生成)'}`);
      break;
    }
    if (d.status === 'scheduled' && !wantNow) {
      console.log(`已排期：${d.scheduled_date}（到点自动发布）`);
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const a = parseArgs(process.argv.slice(2));

// 模式互斥：x_article 平台是 standalone（API 不允许与 x 平台同草稿混用），长文/短推二选一；
// 各模式专属旗标误用时明确报错，避免静默忽略造成意外。
const tweetMode = Boolean(a.textFile || a.threadFile);
if (a.textFile && a.threadFile) {
  console.error('错误：--text-file 与 --thread-file 只能二选一。');
  process.exit(1);
}
if (a.mdFile && tweetMode) {
  console.error('错误：--markdown-file（长文）与 --text-file/--thread-file（短推）只能二选一。');
  process.exit(1);
}
if (tweetMode && (a.cover || a.noTransform || a.noGist || a.gistUrl)) {
  console.error('错误：--cover/--no-transform/--no-gist/--gist-url 仅用于长文模式；短推配图请用 --image <本地图片路径>。');
  process.exit(1);
}
if (!tweetMode && (a.images || a.firstComment || a.dryRun)) {
  console.error('错误：--image/--first-comment/--dry-run 仅用于短推模式（--text-file/--thread-file）；长文排版自检请用 md-assets.mjs --test。');
  process.exit(1);
}

// 短推分条：--thread-file 按「单独一行 ---」分隔为多条；--text-file 整个文件为单条（与 buffer-post.mjs 同约定）。
const segments = a.threadFile
  ? readFileSync(a.threadFile, 'utf8').split(/^[ \t]*-{3,}[ \t]*\r?$/m).map((s) => s.trim()).filter(Boolean)
  : a.textFile ? [readFileSync(a.textFile, 'utf8').trim()].filter(Boolean) : [];

if (tweetMode && !segments.length) {
  console.error(a.threadFile
    ? '错误：--thread-file 内容为空（各条之间用单独一行 --- 分隔）。'
    : '错误：--text-file 内容为空。');
  process.exit(1);
}

// dry-run 在读 token 之前退出：不需要任何凭据、不做任何网络请求。
if (a.dryRun) {
  segments.forEach((s, i) => {
    const w = xWeight(s);
    console.log(`--- [${i + 1}/${segments.length}] 计数字符 ≈ ${w}${w > 280 ? '（超 280：免费档发不出；Premium+ 可发但时间线折叠）' : ''} ---`);
    console.log(s);
  });
  if (a.firstComment) console.log(`--- [首评] 计数字符 ≈ ${xWeight(a.firstComment)} ---\n${a.firstComment}`);
  if (a.images) console.log(`--- [配图] ${a.images.length} 张，挂首条：${a.images.join('，')} ---`);
  process.exit(0);
}

const token = getToken();
const cfg = loadConfig();

if (a.check) {
  for (const s of await listSocialSets(token)) console.log(`连通正常：social_set ${s.id} | ${s.name} | @${s.username}`);
  process.exit(0);
}

if (!a.mdFile && !tweetMode) {
  console.error('错误：缺少 --markdown-file（长文）或 --text-file/--thread-file（短推）。也可用 --check 做连通性检查。');
  process.exit(1);
}

const socialSet = await resolveSocialSet(token, cfg, a.socialSet);

// —— 短推/推串模式：platforms.x（enabled 必填，posts 每项一条推文、上限 50 条）——
// 配图挂在 posts[].media_ids（每条上限 10，X 实际单推上限 4 张图）；本地文件直传 Typefully，
// 不经 GitHub 图床。注意：Typefully 媒体上传接口没有 alt 文本字段（Buffer 通道才支持 alt）。
if (tweetMode) {
  const mediaIds = [];
  for (const [i, img] of (a.images || []).entries()) {
    mediaIds.push(await uploadMedia(token, socialSet, img, `post-media-${i + 1}`));
  }
  if (mediaIds.length > 4) console.error(`警告：X 单条推文最多 4 张图，当前 ${mediaIds.length} 张，发布可能失败。`);
  if (mediaIds.length) console.log(`配图已上传：${mediaIds.length} 张（挂首条）`);

  const posts = segments.map((t, i) => (i === 0 && mediaIds.length ? { text: t, media_ids: mediaIds } : { text: t }));
  if (a.firstComment) posts.push({ text: a.firstComment });

  const payload = {
    ...(a.draftTitle ? { draft_title: a.draftTitle } : {}),
    platforms: { x: { enabled: true, posts } },
  };
  await createDraftAndReport(token, socialSet, payload, a.publishAt);
  process.exit(0);
}

// —— 长文 X Article 模式 ——

let md = readFileSync(a.mdFile, 'utf8').trim();
// 去掉开头的 YAML frontmatter（--- ... ---）：X Article 要求正文首块必须是 H1，
// 而 Obsidian 等笔记库的草稿普遍带 frontmatter，不剥掉会被当成正文首行导致校验失败。
if (md.startsWith('---')) {
  const lines = md.split('\n');
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close !== -1) md = lines.slice(close + 1).join('\n').trim();
}
const h1 = md.match(/^#\s+(.+)$/m);
if (!h1) console.error('警告：Markdown 中没有一级标题（# ...），文章标题可能为空——建议补一个 H1。');

// X 化排版预处理（详见 md-assets.mjs 头注释）：多行代码块/大表格 → 图片，单行代码 → 文本行，
// 小表格 → 列表，行内代码 → 「」，H3+ → 加粗行。--no-transform 可关闭。
// 关键：X Article 正文图必须走 Typefully 上传媒体 + <typ:media> 标签——外链 markdown 图
// （![](url)）在 X Article 里不渲染、只显示成链接文本。所以这里把图生成到本地临时目录
// （push:false，不推 github 图床，也不依赖 assets_dir），逐张上传 Typefully 后把占位图
// 替换成 <typ:media media_id> 标签。短推走 Buffer 才用图床外链，两套机制不要混。
if (!a.noTransform) {
  const slug = (h1 ? h1[1] : basename(a.mdFile, '.md')).trim();
  const tmpDir = join(tmpdir(), 'xps-article-media');
  const codeFiles = extractCodeFiles(md);
  let gistUrl = a.gistUrl || null;
  if (codeFiles.length && !gistUrl && !a.noGist) {
    try {
      // 单文档 gist：全部代码块组织进一个 markdown 文件，「## 代码块 N」标题
      // 与正文代码图的标题栏一字不差，图下深链按标题锚点直达对应块。
      const gist = await createCodeGist({
        files: [buildGistDoc(codeFiles)],
        description: `X Article：${h1 ? h1[1].trim() : slug}`,
      });
      gistUrl = gist.url;
      console.log(`代码 Gist：${gist.url}（${codeFiles.length} 个代码块，单文档，secret）`);
    } catch (e) {
      console.error(`警告：代码 Gist 创建失败，文章仍会继续，但代码图下没有复制链接：${e.message || e}`);
    }
  }
  const { md: transformed, assets, stats } = await transformMarkdownBody(md, {
    slug,
    push: false,
    outDir: tmpDir,
    codeCopyBaseUrl: gistUrl,
  });
  if (transformed !== md) {
    md = transformed;
    let idx = 0;
    for (const asset of assets) {
      idx++;
      const mid = await uploadMedia(token, socialSet, asset.localPath, `${asset.kind}-${idx}`);
      md = md.replace(new RegExp(`!\\[[^\\]]*\\]\\(${esc(asset.url)}\\)`, 'g'), `<typ:media media_id="${mid}" />`);
    }
    const parts = [];
    if (stats.codeImg) parts.push(`代码块→图 ${stats.codeImg}`);
    if (stats.codeLine) parts.push(`单行代码→文本 ${stats.codeLine}`);
    if (stats.tableImg) parts.push(`表格→图 ${stats.tableImg}`);
    if (stats.tableList) parts.push(`小表格→列表 ${stats.tableList}`);
    if (stats.inline) parts.push(`行内代码→「」 ${stats.inline}`);
    if (stats.heading) parts.push(`H3+→加粗 ${stats.heading}`);
    if (assets.length) parts.push(`${assets.length} 张图上传 Typefully(typ:media)`);
    console.log(`X 化排版：${parts.join('，')}。`);
    const leftover = md.match(/!\[[^\]]*\]\([^)]+\)/g);
    if (leftover) console.error(`警告：${leftover.length} 张正文图未转成 typ:media，X Article 里可能不显示：${leftover.slice(0, 3).join(' ')}`);
  }
}

// 可选封面：走顶层 cover_media_id（与正文图不同，封面不用 typ:media 标签）。
// 复用 uploadMedia（内部已轮询 ready，不用再手动 sleep）。
let coverMediaId = null;
if (a.cover) {
  coverMediaId = await uploadMedia(token, socialSet, a.cover, 'cover');
  console.log(`封面已上传：media_id=${coverMediaId}`);
}

// 创建 X Article（长文）：正文和封面都必须嵌套在 platforms.x_article 下。
// Typefully 要求 platforms 为必填字段，content_markdown 和 cover_media_id 在顶层会被拒绝（422 extra_forbidden）。
// 注意：文章标题自动取自正文首个 H1，x_article 下没有 title 字段（传了报 422）。
const payload = {
  ...(a.draftTitle ? { draft_title: a.draftTitle } : {}),
  platforms: {
    x_article: {
      content_markdown: md,
      ...(coverMediaId ? { cover_media_id: coverMediaId } : {}),
    },
  },
};

await createDraftAndReport(token, socialSet, payload, a.publishAt, { titleFallback: '(取自 H1)' });

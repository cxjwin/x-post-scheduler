#!/usr/bin/env node
// Typefully 长文发布脚本：通过 API v2 创建/排期 X Article（也可用于普通草稿检查）。
// 零依赖，任何有 node 的环境可用。与 buffer-post.mjs 互补：短推走 Buffer，长文 Article 走这里。
//
// 用法：
//   node typefully-post.mjs --check
//       连通性检查（列出 social sets，不产生任何草稿）
//   node typefully-post.mjs --markdown-file article.md \
//       [--publish-at "2026-07-16T08:00:00+08:00" | --publish-at now | --publish-at next-free-slot] \
//       [--cover /path/to/cover.png] [--draft-title "内部草稿名"] [--social-set <id>] [--no-transform]
//       创建 X Article：正文为 Markdown，文章标题自动取自首个 # 一级标题。
//       不带 --publish-at 时仅存为草稿（可在 Typefully 里预览后再排期）。
//
// token 来源（按序）：环境变量 TYPEFULLY_KEY → ~/.config/typefully/key 文件。
// social set 来源（按序）：--social-set → 配置（XPS_TYPEFULLY_SOCIAL_SET / config.json 的
//   typefully_social_set）→ 自动发现（账号下恰好一个时自动选用）。

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { basename } from 'path';
import { transformMarkdownBody } from './md-assets.mjs';
import { loadConfig } from './config.mjs';

const BASE = 'https://api.typefully.com';

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
    else if (k === '--publish-at') a.publishAt = argv[++i];
    else if (k === '--cover') a.cover = argv[++i];
    else if (k === '--draft-title') a.draftTitle = argv[++i];
    else if (k === '--social-set') a.socialSet = argv[++i];
    else if (k === '--no-transform') a.noTransform = true;
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

const a = parseArgs(process.argv.slice(2));
const token = getToken();
const cfg = loadConfig();

if (a.check) {
  for (const s of await listSocialSets(token)) console.log(`连通正常：social_set ${s.id} | ${s.name} | @${s.username}`);
  process.exit(0);
}

if (!a.mdFile) {
  console.error('错误：缺少 --markdown-file（或使用 --check 做连通性检查）。');
  process.exit(1);
}

const socialSet = await resolveSocialSet(token, cfg, a.socialSet);

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

// X 化排版预处理（详见 md-assets.mjs 头注释）：多行代码块/大表格 → 图片挂图床，
// 单行代码 → 文本行，小表格 → 列表，行内代码 → 「」，H3+ → 加粗行。--no-transform 可关闭。
if (!a.noTransform) {
  const slug = (h1 ? h1[1] : basename(a.mdFile, '.md')).trim();
  const { md: transformed, assets, stats } = await transformMarkdownBody(md, { slug });
  if (transformed !== md) {
    md = transformed;
    const parts = [];
    if (stats.codeImg) parts.push(`代码块→图 ${stats.codeImg}`);
    if (stats.codeLine) parts.push(`单行代码→文本 ${stats.codeLine}`);
    if (stats.tableImg) parts.push(`表格→图 ${stats.tableImg}`);
    if (stats.tableList) parts.push(`小表格→列表 ${stats.tableList}`);
    if (stats.inline) parts.push(`行内代码→「」 ${stats.inline}`);
    if (stats.heading) parts.push(`H3+→加粗 ${stats.heading}`);
    console.log(`X 化排版：${parts.join('，')}${assets.length ? `；${assets.length} 张图已挂图床` : ''}。`);
  }
}

// 可选封面：media/upload 拿预签名 URL → PUT 上传 → 引用 media_id
let coverMediaId = null;
if (a.cover) {
  const fileBytes = readFileSync(a.cover);
  const up = await api('POST', `/v2/social-sets/${socialSet}/media/upload`, token, { file_name: basename(a.cover) });
  if (!up.upload_url || !up.media_id) {
    console.error('封面上传接口返回异常：', JSON.stringify(up).slice(0, 300));
    process.exit(1);
  }
  const put = await fetch(up.upload_url, { method: 'PUT', body: fileBytes });
  if (!put.ok) { console.error(`封面 PUT 上传失败：HTTP ${put.status}`); process.exit(1); }
  coverMediaId = up.media_id;
  console.log(`封面已上传：media_id=${coverMediaId}`);
  // Typefully 封面上传后需短暂处理才能被草稿引用，否则报 "still processing"
  await new Promise(r => setTimeout(r, 8000));
}

// 创建 X Article（长文）：正文和封面都必须嵌套在 platforms.x_article 下。
// Typefully 要求 platforms 为必填字段，content_markdown 和 cover_media_id 在顶层会被拒绝（422 extra_forbidden）。
// 注意：文章标题自动取自正文首个 H1，x_article 下没有 title 字段（传了报 422）。
const payload = {
  ...(a.draftTitle ? { draft_title: a.draftTitle } : {}),
  ...(a.publishAt ? { publish_at: a.publishAt } : {}),
  platforms: {
    x_article: {
      content_markdown: md,
      ...(coverMediaId ? { cover_media_id: coverMediaId } : {}),
    },
  },
};

const draft = await api('POST', `/v2/social-sets/${socialSet}/drafts`, token, payload);
console.log(`结果：status=${draft.status} draft_id=${draft.draft_id || draft.id}`);
console.log(`标题：${draft.draft_title || '(取自 H1)'}`);
if (draft.scheduled_date) console.log(`排期时间：${draft.scheduled_date}`);
if (draft.private_url) console.log(`预览链接：${draft.private_url}`);
if (draft.x_published_url) console.log(`已发布：${draft.x_published_url}`);

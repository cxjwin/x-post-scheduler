#!/usr/bin/env node
// Buffer 发布脚本：不依赖任何 MCP 客户端，直连 mcp.buffer.com 的 JSON-RPC 端点。
// 零依赖，任何有 node 的环境可用（能力与 Buffer MCP 的 create_post 工具等价）。
//
// 用法：
//   node buffer-post.mjs --check
//       连通性检查（调 get_account，不产生任何发帖）
//   node buffer-post.mjs --text-file tweet.txt \
//       [--image-url https://...png --alt "海报描述"] \
//       [--first-comment "原文：https://..."] \
//       [--due-at "2026-07-11T08:00:00+08:00"] \
//       [--channel <channelId>]
//       发帖：不带 --due-at 即立即发布，带则定时排期。
//       推文文本从 --text-file 读取（避免 shell 转义问题）。
//
// token 来源（按序尝试）：环境变量 BUFFER_TOKEN → ~/.config/buffer/key → ~/.claude.json 的 buffer MCP 配置。
// 频道来源（按序尝试）：--channel → 配置（XPS_BUFFER_CHANNEL / config.json 的 buffer_channel_id）
//   → 自动发现（账号下恰好一个 X 频道时自动选用，多个则列出请你配置）。

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { loadConfig } from './config.mjs';

const ENDPOINT = 'https://mcp.buffer.com/mcp';

function getToken() {
  if (process.env.BUFFER_TOKEN) return process.env.BUFFER_TOKEN.trim();
  try {
    return readFileSync(`${homedir()}/.config/buffer/key`, 'utf8').trim();
  } catch {}
  try {
    const cfg = JSON.parse(readFileSync(`${homedir()}/.claude.json`, 'utf8'));
    const auth = cfg?.mcpServers?.buffer?.headers?.Authorization || '';
    if (auth.startsWith('Bearer ')) return auth.slice(7);
  } catch {}
  console.error('错误：未找到 Buffer token。请设置环境变量 BUFFER_TOKEN，或写入 ~/.config/buffer/key（key 在 https://publish.buffer.com/settings/api 生成）。');
  process.exit(1);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--check') a.check = true;
    else if (k === '--text-file') a.textFile = argv[++i];
    else if (k === '--image-url') a.imageUrl = argv[++i];
    else if (k === '--alt') a.alt = argv[++i];
    else if (k === '--first-comment') a.firstComment = argv[++i];
    else if (k === '--due-at') a.dueAt = argv[++i];
    else if (k === '--channel') a.channel = argv[++i];
  }
  return a;
}

async function call(name, args, token) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  // 端点可能返回纯 JSON 或 SSE（data: 行）
  const jsonText = raw.includes('data: ')
    ? raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
    : raw;
  let rpc;
  try { rpc = JSON.parse(jsonText); } catch {
    console.error(`错误：无法解析响应（HTTP ${res.status}）：${raw.slice(0, 300)}`);
    process.exit(1);
  }
  const text = rpc?.result?.content?.[0]?.text ?? '';
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (rpc?.error || rpc?.result?.isError || data?.error) {
    console.error('Buffer API 错误：', JSON.stringify(rpc?.error || data?.error || text));
    process.exit(1);
  }
  return data;
}

// 频道自动发现：恰好一个 X (twitter) 频道时直接用；零个或多个时列出并退出。
async function resolveChannel(token, cfg) {
  if (cfg.bufferChannelId) return cfg.bufferChannelId;
  const acc = await call('get_account', {}, token);
  const orgId = acc.organizations?.[0]?.id;
  if (!orgId) {
    console.error('错误：get_account 未返回组织信息，无法自动发现频道。');
    process.exit(1);
  }
  const res = await call('list_channels', { organizationId: orgId }, token);
  const channels = Array.isArray(res) ? res : res.channels || res.data || [];
  const xs = channels.filter((c) => ['twitter', 'x'].includes(String(c.service).toLowerCase()));
  if (xs.length === 1) {
    console.error(`频道自动发现：${xs[0].name || xs[0].displayName}（${xs[0].id}）`);
    return xs[0].id;
  }
  console.error(xs.length === 0 ? '错误：该 Buffer 账号下没有 X (Twitter) 频道。' : '错误：账号下有多个 X 频道，请在配置中指定 buffer_channel_id：');
  for (const c of channels) console.error(`  ${c.id}  ${c.service}  ${c.name || c.displayName}`);
  process.exit(1);
}

const a = parseArgs(process.argv.slice(2));
const token = getToken();
const cfg = loadConfig();

if (a.check) {
  const acc = await call('get_account', {}, token);
  console.log(`连通正常：${acc.email}（组织 ${acc.organizations?.[0]?.name}，当前时间 ${acc.currentTime}）`);
  process.exit(0);
}

if (!a.textFile) {
  console.error('错误：缺少 --text-file（或使用 --check 做连通性检查）。');
  process.exit(1);
}

const text = readFileSync(a.textFile, 'utf8').trim();
const channelId = a.channel || await resolveChannel(token, cfg);

const assets = a.imageUrl
  ? [{ image: { url: a.imageUrl, metadata: { altText: a.alt || '配图' } } }]
  : [];

const thread = [{ text, ...(assets.length ? { assets } : {}) }];
if (a.firstComment) thread.push({ text: a.firstComment });

const payload = {
  channelId,
  schedulingType: 'automatic',
  mode: a.dueAt ? 'customScheduled' : 'shareNow',
  ...(a.dueAt ? { dueAt: a.dueAt } : {}),
  text,
  ...(assets.length ? { assets } : {}),
  ...(thread.length > 1 || assets.length ? { metadata: { twitter: { thread } } } : {}),
};

const post = await call('create_post', payload, token);
console.log(`发布结果：status=${post.status} id=${post.id} dueAt=${post.dueAt || '-'}`);

if (post.id) {
  const detail = await call('get_post', { postId: post.id }, token);
  if (detail.externalLink) console.log(`推文链接：${detail.externalLink}`);
}

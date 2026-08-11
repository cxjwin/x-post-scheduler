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
//       [--channel <channelId>] [--dry-run]
//       发单条：不带 --due-at 即立即发布，带则定时排期。
//       推文文本从 --text-file 读取（避免 shell 转义问题）。
//   node buffer-post.mjs --thread-file thread.txt [其余参数同上]
//       发线程：文件内推文之间用单独一行 --- 分隔；或不写 ---、直接用行首编号
//       「1/ 」「2/ 」…（可带总数如「1/5 」）自动拆分——编号行须在文件开头或空行
//       之后、斜杠后带空格、序号从 1 连续递增（两种写法并存时以 --- 为准）。
//       某条要配图时在该条内写一行「[img] <公开图片URL> | <alt描述>」（alt 可省，X 每条最多 4 张）。
//       --image-url 附到首条；--first-comment 自动追加为线程最后一条（放原文链接）。
//       发布前打印每条加权字数（免费档单条上限 280，超限标 ⚠ 但不阻塞——档位由调用方判断）。
//   --dry-run：只打印将要提交的 payload 不实际发帖（不需要 token，排查线程拆分/配图用）。
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
    else if (k === '--thread-file') a.threadFile = argv[++i];
    else if (k === '--image-url') a.imageUrl = argv[++i];
    else if (k === '--alt') a.alt = argv[++i];
    else if (k === '--first-comment') a.firstComment = argv[++i];
    else if (k === '--due-at') a.dueAt = argv[++i];
    else if (k === '--channel') a.channel = argv[++i];
    else if (k === '--dry-run') a.dryRun = true;
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

// 行首编号拆分：识别「1/ 」「2/ 」…（可带总数如「1/5 」）作为推文边界。
// 防误拆三道闸（正文里「1/3 的用户」这类分数不能被当编号）：
//   1) 编号行必须在文件开头或空行之后，且斜杠后是空格/行尾；
//   2) 「N/M」带总数形式的 M 是总条数惯例——与实际候选数对不上的按正文分数丢弃（迭代到稳定）；
//   3) 剩余序号必须恰为 1..k 连续递增：候选 <2 返回 null（不按编号拆），
//      ≥2 但不连续则报错退出（宁可不发，不静默拆错）。
// 编号前的未编号引子段（如有）作为首条；编号保留在正文里（那是 X 上的可见惯例）。
function splitByNumbering(lines) {
  let marks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+)\/(\d+)?(?:\s|$)/);
    if (m && (i === 0 || lines[i - 1].trim() === '')) {
      marks.push({ i, n: +m[1], total: m[2] ? +m[2] : undefined });
    }
  }
  for (;;) {
    const next = marks.filter((x) => x.total === undefined || x.total === marks.length);
    if (next.length === marks.length) break;
    marks = next;
  }
  if (marks.length < 2) return null;
  if (!marks.every((x, k) => x.n === k + 1)) {
    console.error(`错误：检测到行首编号（${marks.map((x) => x.n + '/').join(' ')}）但不是从 1 连续递增，无法安全按编号拆分。请检查编号，或改用单独一行 --- 分隔推文。`);
    process.exit(1);
  }
  const segs = [];
  if (lines.slice(0, marks[0].i).join('').trim()) segs.push(lines.slice(0, marks[0].i));
  for (let k = 0; k < marks.length; k++) {
    segs.push(lines.slice(marks[k].i, marks[k + 1] ? marks[k + 1].i : lines.length));
  }
  return segs;
}

// 线程文件解析：有单独一行 ---（3 个及以上 -）时按 --- 分隔（显式优先）；
// 没有 --- 时尝试按行首编号拆分（见 splitByNumbering）；都识别不到则整个文件为一条。
// 段内「[img] <公开URL> | <alt>」指令行转成该条的图片资产（alt 可省），不留在正文里。
function parseThreadFile(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  let segs;
  if (lines.some((l) => /^-{3,}$/.test(l.trim()))) {
    segs = [];
    let buf = [];
    for (const line of lines) {
      if (/^-{3,}$/.test(line.trim())) { segs.push(buf); buf = []; }
      else buf.push(line);
    }
    segs.push(buf);
  } else {
    segs = splitByNumbering(lines) || [lines];
  }
  const thread = [];
  for (const segLines of segs) {
    const assets = [];
    const kept = [];
    for (const line of segLines) {
      const m = line.match(/^\[img\]\s*(\S+?)\s*(?:\|\s*(.+?)\s*)?$/);
      if (m) assets.push({ image: { url: m[1], metadata: { altText: m[2] || '配图' } } });
      else kept.push(line);
    }
    const text = kept.join('\n').trim();
    if (text || assets.length) thread.push({ text, ...(assets.length ? { assets } : {}) });
  }
  return thread;
}

// X 加权字数（twitter-text v3 规则简化版）：URL 一律计 23（t.co 包装）；
// 拉丁字母/常用西文标点区段计 1，CJK、emoji 等其余字符计 2。免费档单条上限 280。
function weightedLength(text) {
  const urls = text.match(/https?:\/\/\S+/g) || [];
  let n = urls.length * 23;
  for (const ch of text.replace(/https?:\/\/\S+/g, '')) {
    const c = ch.codePointAt(0);
    n += c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247) ? 1 : 2;
  }
  return n;
}

const a = parseArgs(process.argv.slice(2));
const cfg = loadConfig();

if (a.check) {
  const acc = await call('get_account', {}, getToken());
  console.log(`连通正常：${acc.email}（组织 ${acc.organizations?.[0]?.name}，当前时间 ${acc.currentTime}）`);
  process.exit(0);
}

if (!a.textFile && !a.threadFile) {
  console.error('错误：缺少 --text-file 或 --thread-file（或使用 --check 做连通性检查）。');
  process.exit(1);
}
if (a.textFile && a.threadFile) {
  console.error('错误：--text-file 与 --thread-file 只能二选一。');
  process.exit(1);
}

// 组装线程数组：单推是长度为 1 的特例，主推恒为 thread[0]。
const thread = a.threadFile
  ? parseThreadFile(a.threadFile)
  : [{ text: readFileSync(a.textFile, 'utf8').trim() }];
if (!thread.length) {
  console.error('错误：--thread-file 解析后没有任何推文（检查内容与 --- 分隔行）。');
  process.exit(1);
}

// --image-url（海报）附到首条最前面；--first-comment（原文链接）追加为最后一条。
if (a.imageUrl) {
  thread[0].assets = [
    { image: { url: a.imageUrl, metadata: { altText: a.alt || '配图' } } },
    ...(thread[0].assets || []),
  ];
}
if (a.firstComment) thread.push({ text: a.firstComment });

// 打印每条加权字数（单推也打印），超限只警告不阻塞（免费/Premium 档位由调用方判断）。
if (a.threadFile) console.error(`线程共 ${thread.length} 条：`);
thread.forEach((t, i) => {
  const n = weightedLength(t.text);
  const img = t.assets ? `，图 ${t.assets.length} 张${t.assets.length > 4 ? '  ⚠ X 每条最多 4 张' : ''}` : '';
  console.error(`  第 ${i + 1} 条：${n} 计数字符${img}${n > 280 ? '  ⚠ 超 280（免费档会被 X 拒发；Premium+ 可发但时间线折叠）' : ''}`);
});

const first = thread[0];
const payload = {
  channelId: '',
  schedulingType: 'automatic',
  mode: a.dueAt ? 'customScheduled' : 'shareNow',
  ...(a.dueAt ? { dueAt: a.dueAt } : {}),
  text: first.text,
  ...(first.assets ? { assets: first.assets } : {}),
  ...(thread.length > 1 || first.assets ? { metadata: { twitter: { thread } } } : {}),
};

if (a.dryRun) {
  payload.channelId = a.channel || cfg.bufferChannelId || '(发布时自动发现)';
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const token = getToken();
payload.channelId = a.channel || await resolveChannel(token, cfg);

const post = await call('create_post', payload, token);
console.log(`发布结果：status=${post.status} id=${post.id} dueAt=${post.dueAt || '-'}`);

if (post.id) {
  const detail = await call('get_post', { postId: post.id }, token);
  if (detail.externalLink) console.log(`推文链接：${detail.externalLink}`);
}

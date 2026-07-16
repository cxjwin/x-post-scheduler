#!/usr/bin/env node
// setup.mjs — x-post-scheduler 交互式配置向导（零依赖）。
//
//   node skills/x-post-scheduler/scripts/setup.mjs
//
// 一条命令完成全部配置：安装 skill → Buffer key → Typefully key（可选）→ 署名 handle
// → 图床仓库（可用 gh 一键创建）。每一步都当场验证连通性；API key 在终端里输入且不回显，
// 不经过任何聊天上下文。可重复运行（已配好的项会检测并跳过/复用）。

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'x-post-scheduler');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const BUFFER_KEY_PATH = path.join(HOME, '.config', 'buffer', 'key');
const TYPEFULLY_KEY_PATH = path.join(HOME, '.config', 'typefully', 'key');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// 自建行队列：rl.question 只捕获「提问之后」的下一行，用户一次粘贴多行（或管道输入）时
// 未被挂住的行会被 readline 丢弃。队列化后先到的输入排队等后到的问题，一行不丢。
const pendingLines = [];
const lineWaiters = [];
let stdinClosed = false;
let muteEcho = false;
const origWrite = rl._writeToOutput?.bind(rl);
rl._writeToOutput = (s) => { if (!muteEcho && origWrite) origWrite(s); };
rl.on('line', (l) => {
  const w = lineWaiters.shift();
  if (w) w(l); else pendingLines.push(l);
});
rl.on('close', () => {
  stdinClosed = true;
  while (lineWaiters.length) lineWaiters.shift()('');
});
function nextLine() {
  if (pendingLines.length) return Promise.resolve(pendingLines.shift());
  if (stdinClosed) return Promise.resolve('');
  return new Promise((res) => lineWaiters.push(res));
}

async function ask(q, def = '') {
  if (stdinClosed && !pendingLines.length) return ''; // EOF 后不再套默认值，走各步骤的跳过分支
  const hint = def ? `（回车=${def}）` : '';
  process.stdout.write(`${q}${hint} `);
  const a = (await nextLine()).trim();
  return a || def;
}

// 隐藏输入：问题正常打印，输入内容完全不回显（防止 key 留在终端回滚缓冲区里）
async function askHidden(q) {
  if (stdinClosed && !pendingLines.length) return '';
  process.stdout.write(q + ' ');
  muteEcho = true;
  const a = (await nextLine()).trim();
  muteEcho = false;
  process.stdout.write('\n');
  return a;
}

function writeKeyFile(p, key) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, key + '\n', { mode: 0o600 });
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', ...opts }).toString().trim();
}

function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function step(n, title) { console.log(`\n【${n}】${title}`); }

// ---------- Buffer / Typefully API（与 buffer-post.mjs / typefully-post.mjs 同一协议，验证用） ----------

async function bufferCall(name, args, token) {
  const res = await fetch('https://mcp.buffer.com/mcp', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const jsonText = raw.includes('data: ')
    ? raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
    : raw;
  const rpc = JSON.parse(jsonText);
  const data = JSON.parse(rpc?.result?.content?.[0]?.text ?? '{}');
  if (rpc?.error || rpc?.result?.isError || data?.error) {
    throw new Error(JSON.stringify(rpc?.error || data?.error).slice(0, 200));
  }
  return data;
}

async function typefullySets(token) {
  const res = await fetch('https://api.typefully.com/v2/social-sets', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(JSON.stringify(data?.error || data).slice(0, 200));
  return Array.isArray(data) ? data : data.results || data.data || [data];
}

function findExistingBufferToken() {
  if (process.env.BUFFER_TOKEN) return { token: process.env.BUFFER_TOKEN.trim(), from: '环境变量 BUFFER_TOKEN' };
  try { return { token: fs.readFileSync(BUFFER_KEY_PATH, 'utf8').trim(), from: BUFFER_KEY_PATH }; } catch {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    const auth = cfg?.mcpServers?.buffer?.headers?.Authorization || '';
    if (auth.startsWith('Bearer ')) return { token: auth.slice(7), from: '~/.claude.json 的 Buffer MCP 配置' };
  } catch {}
  return null;
}

function findExistingTypefullyToken() {
  if (process.env.TYPEFULLY_KEY) return { token: process.env.TYPEFULLY_KEY.trim(), from: '环境变量 TYPEFULLY_KEY' };
  try { return { token: fs.readFileSync(TYPEFULLY_KEY_PATH, 'utf8').trim(), from: TYPEFULLY_KEY_PATH }; } catch {}
  return null;
}

// ---------- 向导主流程 ----------

console.log('━━━ x-post-scheduler 配置向导 ━━━');
console.log('全程约 2 分钟。API key 输入时不回显；随时 Ctrl+C 退出，重跑不会弄丢已配好的项。');

const config = (() => {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
})();

// 【1】安装 skill（从仓库克隆处运行时才需要）
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const inInstalled = scriptDir.split(path.sep).join('/').includes('/.claude/skills/');
if (!inInstalled && fs.existsSync(path.join(repoRoot, 'skills'))) {
  step(1, '安装 skill 到 Claude Code');
  console.log('  [1] 全局安装（~/.claude/skills/，所有项目可用）');
  console.log('  [2] 装进某个项目（<项目>/.claude/skills/，只在该项目生效）');
  console.log('  [3] 跳过（稍后自己复制）');
  const c = await ask('  选择 [1/2/3]', '1');
  let target = null;
  if (c === '1') target = path.join(HOME, '.claude', 'skills');
  else if (c === '2') {
    const proj = await ask('  项目路径：');
    if (proj) target = path.join(path.resolve(proj.replace(/^~/, HOME)), '.claude', 'skills');
  }
  if (target) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(path.join(repoRoot, 'skills'))) {
      fs.cpSync(path.join(repoRoot, 'skills', name), path.join(target, name), { recursive: true });
    }
    ok(`已安装到 ${target}`);
  }
} else {
  step(1, '安装 skill —— 检测到已在安装位置运行，跳过');
}

// 【2】Buffer API key（短推发布，必需）
step(2, 'Buffer API key（短推发布必需）');
let bufferToken = null;
{
  const existing = findExistingBufferToken();
  if (existing) {
    try {
      const acc = await bufferCall('get_account', {}, existing.token);
      ok(`检测到已有 key（来源：${existing.from}），验证通过：${acc.email}`);
      bufferToken = existing.token;
    } catch {
      warn(`检测到已有 key（来源：${existing.from}），但验证失败（可能已轮换），请重新输入。`);
    }
  }
  while (!bufferToken) {
    console.log('  打开 https://publish.buffer.com/settings/api 生成 API key');
    const key = await askHidden('  粘贴 key（输入不回显，直接回车=跳过）：');
    if (!key) { warn('已跳过——之后重跑本向导即可补配。'); break; }
    try {
      const acc = await bufferCall('get_account', {}, key);
      writeKeyFile(BUFFER_KEY_PATH, key);
      ok(`验证通过：${acc.email}（已写入 ${BUFFER_KEY_PATH}，权限 600）`);
      bufferToken = key;
    } catch (e) {
      warn(`验证失败：${e.message}，请检查后重试。`);
    }
  }
  // 频道自动发现：一个 → 无需配置；多个 → 选一个固化进 config
  if (bufferToken) {
    try {
      const acc = await bufferCall('get_account', {}, bufferToken);
      const res = await bufferCall('list_channels', { organizationId: acc.organizations[0].id }, bufferToken);
      const channels = Array.isArray(res) ? res : res.channels || res.data || [];
      const xs = channels.filter((c) => ['twitter', 'x'].includes(String(c.service).toLowerCase()));
      if (xs.length === 1) {
        ok(`X 频道：${xs[0].name || xs[0].displayName}（唯一，发帖时自动选用，无需配置）`);
      } else if (xs.length === 0) {
        warn('该 Buffer 账号还没连接 X 频道——去 Buffer 后台连接后即可使用。');
      } else {
        console.log('  账号下有多个 X 频道：');
        xs.forEach((c, i) => console.log(`    [${i + 1}] ${c.name || c.displayName}（${c.id}）`));
        const pick = await ask(`  用哪个？[1-${xs.length}]`, '1');
        const picked = xs[Number(pick) - 1] || xs[0];
        config.buffer_channel_id = picked.id;
        ok(`已选定：${picked.name || picked.displayName}`);
      }
    } catch (e) {
      warn(`频道检测失败（${e.message}），发帖时脚本会再次自动发现。`);
    }
  }
}

// 【3】Typefully API key（长文 Article，可选）
step(3, 'Typefully API key（长文 X Article 用，可选）');
{
  let tfToken = null;
  const existing = findExistingTypefullyToken();
  if (existing) {
    try {
      const sets = await typefullySets(existing.token);
      ok(`检测到已有 key（来源：${existing.from}），验证通过：@${sets[0]?.username}`);
      tfToken = existing.token;
    } catch {
      warn(`检测到已有 key（来源：${existing.from}），但验证失败，请重新输入。`);
    }
  }
  if (!tfToken) {
    console.log('  不发长文可直接回车跳过。key 在 Typefully 的 Settings → API 生成');
    const key = await askHidden('  粘贴 key（输入不回显，直接回车=跳过）：');
    if (key) {
      try {
        const sets = await typefullySets(key);
        writeKeyFile(TYPEFULLY_KEY_PATH, key);
        ok(`验证通过：@${sets[0]?.username}（已写入 ${TYPEFULLY_KEY_PATH}，权限 600）`);
        tfToken = key;
      } catch (e) {
        warn(`验证失败：${e.message}——已跳过，之后重跑本向导补配。`);
      }
    }
  }
  if (tfToken) {
    const sets = await typefullySets(tfToken);
    if (sets.length === 1) {
      ok(`social set：${sets[0].name}（唯一，自动选用，无需配置）`);
    } else if (sets.length > 1) {
      console.log('  账号下有多个 social set：');
      sets.forEach((s, i) => console.log(`    [${i + 1}] ${s.name} @${s.username}（${s.id}）`));
      const pick = await ask(`  用哪个？[1-${sets.length}]`, '1');
      const picked = sets[Number(pick) - 1] || sets[0];
      config.typefully_social_set = String(picked.id);
      ok(`已选定：${picked.name}`);
    }
  }
}

// 【4】署名 handle
step(4, '海报署名');
{
  const cur = config.handle || '';
  const h = await ask('  你的 X 用户名（如 @yourname，回车跳过=海报不署名）', cur);
  if (h) config.handle = h.startsWith('@') ? h : `@${h}`;
}

// 【5】图床仓库（配图用，可选）
step(5, '图床仓库（发图必需：Buffer 只收公开 URL）');
{
  if (config.assets_dir && fs.existsSync(config.assets_dir)) {
    ok(`已配置：${config.assets_dir}，跳过`);
  } else {
    let ghReady = false;
    try { sh('gh auth status'); ghReady = true; } catch {}
    console.log('  [1] 已有 GitHub 公开仓库的本地克隆（输入路径）');
    if (ghReady) console.log('  [2] 用 gh 一键创建公开仓库并克隆（检测到 gh 已登录）');
    console.log('  [3] 暂时跳过（先发纯文字帖，之后重跑向导补配）');
    const c = await ask(`  选择 [1${ghReady ? '/2' : ''}/3]`, '3');
    if (c === '1') {
      const p = path.resolve((await ask('  本地克隆路径：')).replace(/^~/, HOME));
      try {
        sh('git rev-parse --git-dir', { cwd: p });
        const remote = sh('git remote get-url origin', { cwd: p });
        config.assets_dir = p;
        if (/github\.com/.test(remote)) {
          ok(`已配置：${p}（raw URL 前缀会从 git remote 自动推导）`);
        } else {
          const base = await ask('  该仓库不在 GitHub，请输入图片可公开访问的 URL 前缀：');
          if (base) config.assets_raw_base = base.endsWith('/') ? base : base + '/';
          ok(`已配置：${p}`);
        }
      } catch {
        warn('该路径不是 git 仓库，已跳过——之后重跑向导补配。');
      }
    } else if (c === '2' && ghReady) {
      const name = await ask('  仓库名', 'post-assets');
      const parent = path.resolve((await ask('  克隆到哪个目录下', HOME)).replace(/^~/, HOME));
      try {
        sh(`gh repo create ${name} --public --add-readme --clone`, { cwd: parent });
        config.assets_dir = path.join(parent, name);
        ok(`已创建并克隆：${config.assets_dir}`);
      } catch (e) {
        warn(`创建失败：${String(e.message).slice(0, 150)}——之后重跑向导补配。`);
      }
    }
  }
}

// 写入 config.json + 总结
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
console.log(`\n━━━ 配置完成 ━━━`);
console.log(`配置已写入 ${CONFIG_PATH}：`);
console.log('  ' + JSON.stringify(config));
console.log('\n可选增强（用到再装）：');
console.log('  · AI 海报：安装 Codex CLI（npm install -g @openai/codex，需 ChatGPT 订阅）');
console.log('  · 模板海报/代码转图：cd <skill目录>/scripts && npm install   （安装 puppeteer）');
console.log('  · 代码语法高亮图：brew install charmbracelet/tap/freeze');
console.log('\n开始使用：在 Claude Code 里丢一个文章链接即可；连通自检：');
console.log('  node <skill目录>/scripts/buffer-post.mjs --check');
rl.close();

#!/usr/bin/env node
// gist.mjs — X Article 代码块的「可复制」配套通道：一篇文章一个 GitHub Gist，
// gist 内是**一个 markdown 文件**，用「## 代码块 N」中文标题串起全部代码块。
//
// 背景：X Article 不支持代码块，md-assets.mjs 把多行代码块渲染成高亮图片（图上
// 带同款「代码块 N」标题栏），读者无法复制。本模块把这些代码块原文按序组织成
// 单个 markdown 文档打包进一个 gist：
//   - 文档结构：## 代码块 1 → 语言围栏代码 → ## 代码块 2 → …（buildGistDoc）；
//     GitHub 渲染后每个围栏块自带复制按钮，中文标题与文中代码图标题一字不差，
//     读者打开一个链接即可对照复制全部代码
//   - 每个标题在 gist 页面有稳定锚点：## 代码块 1 → user-content-代码块-1，
//     链接片段用 #代码块-1（实测 GitHub 自家目录即此格式，空格转 -；嵌入 X 正文
//     时用 percent-encoded 形式防链接解析截断，见 gistDocAnchor）
//   - gist 描述放文章标题，整个 gist 即这篇文章的代码附录
//   - 围栏长度按内容自适应（内容含 ``` 时升级为更长围栏，防嵌套冲突）
//
// 默认创建 secret gist（未列出：仅持链接可见、不进个人 gist 公开列表、不被搜索
// 索引）。Article 走「先草稿后人工确认」流程，gist 在草稿阶段就会创建——未列出
// 保证文章尚未发布（甚至被放弃）时代码不会被公开广播；对读者体验没有任何差别。
// 放弃草稿时记得 `gh gist delete <id>` 同步清理。
//
// 认证（按序）：gh CLI（已 `gh auth login`）→ GH_TOKEN / GITHUB_TOKEN 环境变量
// 直连 REST API。两者都不可用时抛错，由调用方降级（文章照发，只是没有复制链接）。
//
// 自检：node gist.mjs --check   只探测可用认证通道，不创建任何 gist

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// 围栏语言 → gist 文件扩展名（gist 按扩展名做语法高亮；未知语言给 txt）
const LANG_EXT = {
  javascript: 'js', js: 'js', mjs: 'mjs', cjs: 'cjs', jsx: 'jsx',
  typescript: 'ts', ts: 'ts', tsx: 'tsx',
  python: 'py', py: 'py',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellsession: 'sh',
  yaml: 'yml', yml: 'yml', json: 'json', jsonc: 'jsonc', toml: 'toml', ini: 'ini',
  markdown: 'md', md: 'md', html: 'html', xml: 'xml', css: 'css', scss: 'scss',
  rust: 'rs', golang: 'go', go: 'go', java: 'java', kotlin: 'kt', swift: 'swift',
  ruby: 'rb', php: 'php', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', 'c#': 'cs',
  sql: 'sql', diff: 'diff', dockerfile: 'dockerfile', makefile: 'mk',
  plaintext: 'txt', text: 'txt', txt: 'txt',
};

export function gistFileName(i, lang) {
  const l = String(lang || '').toLowerCase();
  const ext = LANG_EXT[l] || (/^[a-z0-9]{1,8}$/.test(l) ? l : 'txt');
  return `${String(i).padStart(2, '0')}.${ext}`;
}

// gist 页面的文件锚点规则：file- + 文件名小写、非字母数字一律替换为 -
// （多文件 gist 用；当前 Article 流程为单文档 gist，深链走 gistDocAnchor 标题锚点）
export function gistFileAnchor(fileName) {
  return 'file-' + fileName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// 文档内第 i 块的中文标题与其 GitHub 锚点。
// GitHub 对「## 代码块 1」生成 id="user-content-代码块-1"、可用片段 #代码块-1
//（实测本仓库 README 的中文标题即此规则：空格→-，CJK 原样保留）。
// 返回 percent-encoded 形式：X 正文/推文里的 URL 含原始中文时可能被链接解析截断。
export function gistDocHeading(i) {
  return `代码块 ${i}`;
}
export function gistDocAnchor(i) {
  return encodeURIComponent(gistDocHeading(i).replace(/ /g, '-'));
}

/**
 * 把 extractCodeFiles 的结果组织成单个 markdown 文档（一个 gist 只放这一个文件）。
 * 结构：## 代码块 N + 语言围栏代码，标题与 md-assets.mjs 渲染的代码图标题栏一致。
 * 围栏长度自适应：内容里出现 ≥3 个连续反引号时加长围栏，避免嵌套冲突。
 * @param {Array<{content:string, lang:string}>} files extractCodeFiles 的返回值
 * @returns {{name:string, content:string}} 可直接作为 createCodeGist 的唯一文件
 */
export function buildGistDoc(files) {
  const sections = files.map((f, idx) => {
    const runs = f.content.match(/`+/g) || [];
    const longest = runs.reduce((n, s) => Math.max(n, s.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `## ${gistDocHeading(idx + 1)}\n\n${fence}${f.lang || ''}\n${f.content}\n${fence}`;
  });
  return { name: 'code.md', content: sections.join('\n\n') + '\n' };
}

/**
 * 从 Markdown 抽取需要转图的多行 fenced code block，并生成 Gist 文件列表。
 * 文件编号只计算多行块，与 md-assets.mjs 的代码图片编号保持一致。
 * @param {string} md
 * @returns {Array<{name:string, content:string, lang:string}>}
 */
export function extractCodeFiles(md) {
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  const files = [];
  let m;
  while ((m = re.exec(md)) !== null) {
    const lang = m[1].trim().toLowerCase();
    const content = m[2].replace(/\n$/, '');
    if (!content.includes('\n')) continue;
    files.push({
      name: gistFileName(files.length + 1, lang),
      content,
      lang,
    });
  }
  return files;
}

function findGh() {
  for (const c of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const p = execFileSync('which', ['gh'], { stdio: 'pipe' }).toString().trim();
    if (p) return p;
  } catch {}
  return null;
}

function createViaGh(gh, files, description, isPublic) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xps-gist-'));
  try {
    for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.content);
    const out = execFileSync(
      gh,
      ['gist', 'create', ...files.map((f) => f.name), '--desc', description, ...(isPublic ? ['--public'] : [])],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const m = out.match(/https:\/\/gist\.github\.com\/\S+/);
    if (!m) throw new Error(`gh 未返回 gist URL：${out.slice(0, 120)}`);
    const url = m[0].trim();
    return { url, id: url.split('/').pop() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function createViaApi(token, files, description, isPublic) {
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'x-post-scheduler',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description,
      public: isPublic,
      files: Object.fromEntries(files.map((f) => [f.name, { content: f.content }])),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}：${JSON.stringify(data.message || data).slice(0, 160)}`);
  return { url: data.html_url, id: data.id };
}

/**
 * 创建一篇文章的配套代码 gist。
 * @param {{files: Array<{name:string, content:string}>, description: string, isPublic?: boolean}} opts
 * @returns {Promise<{url: string, id: string}>}
 */
export async function createCodeGist({ files, description, isPublic = false }) {
  // GitHub 不接受空文件内容；代码块理论上非空，兜底占位防 422
  const safe = files.map((f) => ({ name: f.name, content: f.content && f.content.trim() ? f.content : '(空)' }));
  const errors = [];
  const gh = findGh();
  if (gh) {
    try {
      return createViaGh(gh, safe, description, isPublic);
    } catch (e) {
      errors.push(`gh CLI：${(e.stderr?.toString() || e.message || String(e)).trim().split('\n')[0]}`);
    }
  } else {
    errors.push('未安装 gh CLI');
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    try {
      return await createViaApi(token, safe, description, isPublic);
    } catch (e) {
      errors.push(`REST API：${e.message}`);
    }
  } else {
    errors.push('未设置 GH_TOKEN/GITHUB_TOKEN');
  }
  throw new Error(errors.join('；'));
}

// ---- 自检（只探测认证通道，不创建 gist）----
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv.includes('--check')) {
    console.error('用法：node gist.mjs --check   探测 gist 认证通道（不创建任何 gist）');
    process.exit(1);
  }
  const gh = findGh();
  if (gh) {
    try {
      execFileSync(gh, ['auth', 'status'], { stdio: 'pipe' });
      console.log(`gist 通道可用：gh CLI（${gh}，已登录）`);
      process.exit(0);
    } catch {
      console.log(`gh CLI 已安装但未登录（${gh}），请运行：gh auth login`);
    }
  } else {
    console.log('gh CLI 未安装（brew install gh）');
  }
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    console.log('gist 通道可用：GH_TOKEN/GITHUB_TOKEN 环境变量（REST API 直连，token 需 gist 权限）');
  } else {
    console.log('GH_TOKEN/GITHUB_TOKEN 未设置——两条通道都不可用时发文章会跳过 gist（仅警告，不阻塞）。');
  }
}

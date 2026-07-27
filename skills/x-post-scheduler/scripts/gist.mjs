#!/usr/bin/env node
// gist.mjs — X Article 代码块的「可复制」配套通道：一篇文章一个 GitHub Gist，
// 每个多行代码块一个文件。
//
// 背景：X Article 不支持代码块，md-assets.mjs 把多行代码块渲染成高亮图片，读者
// 无法复制。本模块把这些代码块原文打包成**一个** gist（不是一块一个 gist——gist
// 原生支持多文件，一文一 gist 才不会刷屏个人 gist 列表、评论区也只需要一条链接）：
//   - 文件名 01.sh / 02.py …（gist 页面按文件名字母序展示，零填充数字前缀保证
//     展示顺序与文中出现顺序一致）
//   - 每个文件在 gist 页面有稳定锚点（01.sh → #file-01-sh），正文可在每张代码图
//     下方挂「复制这段代码」深链，读者点开直达对应文件
//   - gist 描述放文章标题，整个 gist 即这篇文章的代码索引
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
export function gistFileAnchor(fileName) {
  return 'file-' + fileName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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

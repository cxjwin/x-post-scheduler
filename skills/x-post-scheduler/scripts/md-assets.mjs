#!/usr/bin/env node
// md-assets.mjs — X 化排版预处理：发 X Article 前把 markdown 转成 X 渲染友好的形式。
//
// X Article 的 markdown 子集只支持 标题(H1/H2)/粗体/引用/列表/链接/图片：fenced code 会被
// 降级成 blockquote、GFM 表格直接不支持、行内代码反引号原样显示。本模块在 typefully-post.mjs
// 发长文前自动调用，按元素类型分流：
//
//   代码块  多行 → 语法高亮 PNG（freeze 渲染；含中文/freeze 不可用时退回 puppeteer 深色模板）
//           单行 → 正文普通文本行（shell 类语言加「$ 」前缀），不出图
//   表格    2 列且 ≤8 行 → 改写成「- **键**：值」列表（手机端列表比表格图好读）
//           其余 → 深色 GitHub 风表格 PNG（与海报视觉统一）
//   行内码  `xxx` → 「xxx」（X 没有等宽格式，反引号只会原样显示）
//   标题    H3~H6 → **加粗行**（X Article 标题层级有限）
//
// 图片写入图床仓库（配置的 assets_dir）并 git push（push: false 时只写本地、不 push，供自测）；
// raw URL 前缀取配置的 assets_raw_base，缺省时从图床仓库的 git remote 自动推导。
//
// 用法（被 typefully-post.mjs import）：
//   import { transformMarkdownBody } from './md-assets.mjs';
//   const { md, assets, stats } = await transformMarkdownBody(mdBody, { slug });
//
// 独立自测（默认不 push、图片写到 <output_dir>/md-assets-test/，加 --push 才推图床）：
//   node md-assets.mjs --test 文章.md [--push]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { loadConfig, deriveRawBase } from './config.mjs';
import { launchBrowser } from './browser.mjs';
import { gistDocAnchor, gistDocHeading } from './gist.mjs';

// 小表格判定：不超过这个规模就改写成列表而不是出图
const SMALL_TABLE_MAX_COLS = 2;
const SMALL_TABLE_MAX_ROWS = 8;

// 单行代码块加「$ 」前缀的语言（明确是 shell 命令才加）
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shellsession']);

// freeze 的 --language 用 chroma 词法器名，做几个常用别名映射
const FREEZE_LANG_ALIAS = {
  mjs: 'javascript', cjs: 'javascript', js: 'javascript',
  ts: 'typescript', sh: 'bash', shell: 'bash', zsh: 'bash',
  yml: 'yaml', txt: 'text', plaintext: 'text',
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(s) {
  return String(s)
    .replace(/[^\p{Script=Han}a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'md';
}

function hasCJK(s) {
  return /[　-〿㐀-鿿豈-﫿＀-￯]/.test(s);
}

function findFreeze() {
  for (const c of ['/opt/homebrew/bin/freeze', '/usr/local/bin/freeze']) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const p = execSync('which freeze', { stdio: 'pipe' }).toString().trim();
    if (p) return p;
  } catch {}
  return null;
}

// ---- 抽取 fenced code block（先抽，避免表格误吞代码里的 | 行）----
function extractCodeBlocks(md) {
  const re = /```[^\n]*\n[\s\S]*?```/g;
  const blocks = [];
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(md)) !== null) {
    const full = m[0];
    const lm = full.match(/```([^\n]*)\n/);
    const lang = lm ? lm[1].trim().toLowerCase() : '';
    const code = full.replace(/```[^\n]*\n/, '').replace(/```$/, '').replace(/\n$/, '');
    const id = `CODEBLOCK_${blocks.length}`;
    blocks.push({ id, lang, code });
    out += md.slice(last, m.index) + `\n@@${id}@@\n`;
    last = m.index + full.length;
  }
  out += md.slice(last);
  return { text: out, blocks };
}

// ---- 抽取 GFM 表格（行以 | 起，且下一行是分隔行 ---）----
function extractTables(md) {
  const lines = md.split('\n');
  const tables = [];
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isRow = /^\s*\|/.test(line) && line.includes('|');
    if (isRow) {
      const next = lines[i + 1];
      const isSep = next && /^\s*\|?[\s:|-]+\|?[\s:|-]*$/.test(next) && next.includes('-');
      if (isSep) {
        const tbl = [line];
        let j = i + 1;
        while (j < lines.length && /^\s*\|/.test(lines[j]) && lines[j].includes('|')) {
          tbl.push(lines[j]);
          j++;
        }
        const id = `TABLEBLOCK_${tables.length}`;
        tables.push({ id, md: tbl.join('\n') });
        out.push(`@@${id}@@`);
        i = j;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return { text: out.join('\n'), tables };
}

function parseTable(md) {
  const rows = md.trim().split('\n').map((r) => r.trim()).filter(Boolean);
  const cellsOf = (r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  return { header: cellsOf(rows[0]), data: rows.slice(2).map(cellsOf) }; // rows[1] 是分隔行
}

// ---- 纯文本降级：行内代码 / H3+ 标题 ----
function convertInlineCode(text, stats) {
  return text.replace(/`([^`\n]+)`/g, (_, inner) => {
    stats.inline++;
    return `「${inner}」`;
  });
}

function downgradeHeadings(text, stats) {
  // 注意用 [ \t] 而不是 \s：\s 会吞掉行尾换行和后面的空行，导致加粗行与下一段黏连
  return text.replace(/^#{3,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, title) => {
    stats.heading++;
    return `**${title.replace(/\*\*/g, '')}**`;
  });
}

// ---- 小表格 → 列表 ----
function tableToList(header, data, stats) {
  const items = data.map(([k = '', v = '']) => {
    const key = k.replace(/\*\*/g, '');
    return v ? `- **${key}**：${v}` : `- **${key}**`;
  });
  return convertInlineCode(items.join('\n'), stats);
}

// ---- 渲染：代码块（freeze 语法高亮，深色主题匹配品牌）----
function renderCodeWithFreeze(freezeBin, code, lang, outPath) {
  const tmp = path.join(os.tmpdir(), `freeze-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmp, code);
  try {
    const language = FREEZE_LANG_ALIAS[lang] || lang || 'text';
    execFileSync(freezeBin, [
      tmp,
      '--language', language,
      '--theme', 'github-dark',
      '--background', '#0d1117',
      '--window',
      '--padding', '24',
      '--font.size', '15',
      '--line-height', '1.5',
      '--border.radius', '10',
      '--output', outPath,
      // stdin 必须 ignore（接 /dev/null）：给 pipe 的话 freeze 会认为输入来自 stdin，
      // 忽略文件参数并报 "No input"（实测踩坑）
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---- 渲染：代码块 puppeteer 兜底（CJK 安全，freeze 缺字体时的保真通道）----
// title 为「代码块 N」标题（与 gist 文档里的标题一致，读者按标题对照复制）。
function codeHtml(code, lang, title) {
  const bar = title ? (lang ? `${title} · ${lang}` : title) : lang;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;}
  body{margin:0;background:#0d1117;padding:22px 26px;font-family:'SF Mono',Menlo,Consolas,'PingFang SC','Microsoft YaHei',monospace;color:#c9d1d9;display:inline-block;}
  .bar{color:#8b949e;font-size:13px;margin-bottom:10px;font-family:-apple-system,'PingFang SC',sans-serif;letter-spacing:.04em;}
  pre{margin:0;white-space:pre;font-size:15px;line-height:1.6;tab-size:2;}
  </style></head><body>
  ${bar ? `<div class="bar">${escapeHtml(bar)}</div>` : ''}
  <pre>${escapeHtml(code)}</pre></body></html>`;
}

// freeze 出的彩色 PNG 复合一条同款标题栏（freeze 自身不支持标题；标题栏底色与
// freeze --background 一致，视觉上连成一张图）。字号在实测 freeze 输出缩放后标定。
async function wrapPngWithTitle(png, title) {
  const w = png.readUInt32BE(16); // PNG IHDR：宽高在固定偏移
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;}
  body{margin:0;background:#0d1117;display:inline-block;}
  .bar{color:#8b949e;font-family:-apple-system,'PingFang SC',sans-serif;letter-spacing:.04em;
       padding:20px 0 2px 30px;font-size:24px;}
  img{display:block;width:${w}px;}
  </style></head><body>
  <div class="bar">${escapeHtml(title)}</div>
  <img src="data:image/png;base64,${png.toString('base64')}"></body></html>`;
  return renderHtmlToPng(html, w, 1);
}

// ---- 渲染：表格（深色 GitHub 风，与海报视觉统一）----
function tableHtml(header, data) {
  const thead = header.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const tbody = data.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#0d1117;padding:20px 24px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#c9d1d9;display:inline-block;}
  table{border-collapse:collapse;font-size:14px;}
  th,td{border:1px solid #30363d;padding:9px 16px;text-align:left;white-space:nowrap;}
  th{background:#161b22;font-weight:600;color:#e6edf3;}
  tbody tr:nth-child(even) td{background:#10151c;}
  </style></head><body>${`<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`}</body></html>`;
}

async function renderHtmlToPng(html, minWidth, deviceScaleFactor = 2) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: minWidth, height: 10, deviceScaleFactor });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // 内容比视口宽时（长代码行/宽表格）按实际宽度重设，避免截断
    const w = await page.evaluate(() => Math.ceil(document.body.scrollWidth) + 1);
    if (w > minWidth) {
      await page.setViewport({ width: Math.min(w, deviceScaleFactor === 1 ? 3600 : 1800), height: 10, deviceScaleFactor });
    }
    const el = await page.$('body');
    return await el.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

function pushToImageBed(bedDir, files) {
  if (files.length === 0) return;
  const names = files.map((f) => JSON.stringify(path.basename(f)));
  execSync(`git add ${names.join(' ')}`, { cwd: bedDir, stdio: 'pipe' });
  // 图片字节是确定的（puppeteer/freeze 渲染同一内容 → 同一字节），重发内容不变的文章时
  // git 检测不到变化，直接 commit 会报 "nothing to commit" 抛错。所以先看有没有暂存变化：
  // 没有就说明图已在图床、直接跳过（用现有 URL），有才 commit/push。
  const staged = execSync('git diff --cached --name-only', { cwd: bedDir, stdio: 'pipe' }).toString().trim();
  if (!staged) return;
  execSync(`git commit -m "md-assets: ${files.length} asset(s)"`, { cwd: bedDir, stdio: 'pipe' });
  execSync(`git push origin HEAD`, { cwd: bedDir, stdio: 'pipe' });
}

/**
 * X 化排版：按元素类型分流转换 markdown 正文。
 * @param {string} mdBody 已去掉 frontmatter 的 markdown 正文
 * @param {{slug:string, push?:boolean, outDir?:string, rawBase?:string, codeCopyBaseUrl?:string}} opts
 *   slug 用于图床文件名；push=false 时图片只写本地不推图床（自测用）；
 *   outDir/rawBase 缺省时取配置（assets_dir / assets_raw_base，后者可从 git remote 推导）；
 *   codeCopyBaseUrl 存在时，每张代码图下附对应 Gist 文件的复制链接
 * @returns {Promise<{md:string, assets:Array<{kind:string,url:string,localPath:string}>, stats:object}>}
 */
export async function transformMarkdownBody(mdBody, {
  slug,
  push = true,
  outDir,
  rawBase,
  codeCopyBaseUrl,
}) {
  const cfg = loadConfig();
  const base = slugify(slug);
  const stats = { codeImg: 0, codeLine: 0, tableImg: 0, tableList: 0, inline: 0, heading: 0 };

  const { text: afterCode, blocks } = extractCodeBlocks(mdBody);
  const { text: afterTable, tables } = extractTables(afterCode);

  // 正文纯文本降级（占位符不含反引号和 #，不受影响；代码块内容已抽走，不会被误伤）
  let text = downgradeHeadings(afterTable, stats);
  text = convertInlineCode(text, stats);

  // 只有真的要出图时才要求图床配置（纯文字文章不需要 assets_dir）
  const needsImages =
    blocks.some((b) => b.code.includes('\n')) ||
    tables.some((t) => {
      const { header, data } = parseTable(t.md);
      return !(header.length <= SMALL_TABLE_MAX_COLS && data.length <= SMALL_TABLE_MAX_ROWS);
    });
  let bedDir = outDir || cfg.assetsDir;
  let urlBase = rawBase || cfg.assetsRawBase;
  if (needsImages) {
    if (!bedDir) {
      throw new Error('文章包含需要转图的代码块/表格，但未配置图床目录。请在配置中设置 assets_dir（一个 GitHub 公开仓库的本地克隆），或用 --no-transform 关闭预处理。');
    }
    if (!urlBase) urlBase = deriveRawBase(cfg.assetsDir || bedDir);
    if (!urlBase) {
      if (push) throw new Error('无法确定图床 raw URL 前缀：assets_dir 的 git remote 不是 GitHub。请在配置中显式设置 assets_raw_base。');
      urlBase = '<ASSETS_RAW_BASE>/'; // 自测模式给占位符，方便肉眼检查转换结果
    }
  }

  const assets = [];
  const replacements = []; // { id, text }
  const freezeBin = findFreeze();
  if (needsImages) fs.mkdirSync(bedDir, { recursive: true });

  let ci = 0;
  for (const b of blocks) {
    if (!b.code.includes('\n')) {
      // 单行代码块 → 普通文本行，shell 命令加「$ 」前缀
      const line = b.code.trim();
      const prefixed = SHELL_LANGS.has(b.lang) && !line.startsWith('$') ? `$ ${line}` : line;
      replacements.push({ id: `@@${b.id}@@`, text: prefixed });
      stats.codeLine++;
      continue;
    }
    ci++;
    const name = `${base}-code-${ci}.png`;
    const p = path.join(bedDir, name);
    // 图上标题与 gist 文档标题同源（「代码块 N」），读者按标题在 gist 里对照复制
    const label = gistDocHeading(ci);
    let rendered = false;
    if (freezeBin && !hasCJK(b.code)) {
      try {
        renderCodeWithFreeze(freezeBin, b.code, b.lang, p);
        fs.writeFileSync(p, await wrapPngWithTitle(fs.readFileSync(p), b.lang ? `${label} · ${b.lang}` : label));
        rendered = true;
      } catch {} // freeze 失败（未知语言等）静默退回 puppeteer
    }
    if (!rendered) {
      fs.writeFileSync(p, await renderHtmlToPng(codeHtml(b.code, b.lang, label), 920));
    }
    const copyUrl = codeCopyBaseUrl
      ? `${codeCopyBaseUrl.replace(/#.*$/, '')}#${gistDocAnchor(ci)}`
      : null;
    assets.push({
      kind: 'code',
      id: `@@${b.id}@@`,
      url: urlBase + encodeURIComponent(name),
      localPath: p,
      copyUrl,
      label,
    });
    stats.codeImg++;
  }

  let ti = 0;
  for (const t of tables) {
    const { header, data } = parseTable(t.md);
    if (header.length <= SMALL_TABLE_MAX_COLS && data.length <= SMALL_TABLE_MAX_ROWS) {
      // 小表格 → 列表
      replacements.push({ id: `@@${t.id}@@`, text: tableToList(header, data, stats) });
      stats.tableList++;
      continue;
    }
    ti++;
    const name = `${base}-table-${ti}.png`;
    const p = path.join(bedDir, name);
    fs.writeFileSync(p, await renderHtmlToPng(tableHtml(header, data), 760));
    assets.push({ kind: 'table', id: `@@${t.id}@@`, url: urlBase + encodeURIComponent(name), localPath: p });
    stats.tableImg++;
  }

  if (push && assets.length) pushToImageBed(bedDir, assets.map((a) => a.localPath));

  let out = text;
  for (const r of replacements) out = out.split(r.id).join(r.text);
  for (const a of assets) {
    const alt = a.kind === 'code' ? (a.label || '代码块') : '表格';
    const copyLink = a.copyUrl ? `\n\n[复制 ${a.label}](${a.copyUrl})` : '';
    out = out.split(a.id).join(`![${alt}](${a.url})${copyLink}`);
  }
  out = out.replace(/\n{3,}/g, '\n\n'); // 占位符前后补的换行会产生连续空行，收敛成一个
  return { md: out, assets, stats };
}

// ---- 独立自测 ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--test');
  if (i === -1) {
    console.error('用法：node md-assets.mjs --test 文章.md [--push]');
    process.exit(1);
  }
  const cfg = loadConfig();
  const testOutDir = path.join(cfg.outputDir, 'md-assets-test');
  const file = argv[i + 1];
  const push = argv.includes('--push');
  const slug = path.basename(file, '.md');
  let body = fs.readFileSync(file, 'utf8').trim();
  if (body.startsWith('---')) {
    const lines = body.split('\n');
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (close !== -1) body = lines.slice(close + 1).join('\n').trim();
  }
  transformMarkdownBody(body, { slug, push, outDir: push ? undefined : testOutDir })
    .then(({ md, assets, stats }) => {
      console.log(`分流统计：代码块→图 ${stats.codeImg}｜单行代码→文本 ${stats.codeLine}｜表格→图 ${stats.tableImg}｜小表格→列表 ${stats.tableList}｜行内代码→「」 ${stats.inline}｜H3+→加粗 ${stats.heading}`);
      console.log(`图片资源 ${assets.length} 个${push ? '（已推图床）' : `（未 push，本地：${testOutDir}）`}：`);
      for (const a of assets) console.log(`  [${a.kind}] ${a.localPath}`);
      console.log('\n===== 转换后的 markdown =====\n');
      console.log(md);
    })
    .catch((e) => {
      console.error('转换失败：', e.message || e);
      process.exit(1);
    });
}

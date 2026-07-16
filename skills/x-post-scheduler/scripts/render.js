#!/usr/bin/env node
/**
 * x-post-scheduler 海报渲染脚本（HTML 模板兜底通道，需 puppeteer）
 *
 * 用法：
 *   node render.js --data '{"title":"...","point1":"...","point2":"...","point3":"...","source":"example.com","date":"2026-07-04","handle":"@your_handle"}' [--out xxx.png]
 *
 * 输出目录：环境变量 XPS_OUTPUT_DIR > 配置文件 output_dir > 工作目录下 ./output/
 * （--out 传相对文件名则放进该目录，传绝对路径则原样使用）
 * data.handle 缺省时自动取配置的 handle。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIDTH = 1200;
const HEIGHT = 675;
const TEMPLATE = path.join(__dirname, '..', 'templates', 'poster.html');
const FIELDS = ['title', 'point1', 'point2', 'point3', 'source', 'date', 'handle'];

// 与 config.mjs 同一套配置源（render.js 是 CJS，独立实现这几行小逻辑）
function loadFileConfig() {
  const candidates = [
    path.join(process.cwd(), 'x-post-scheduler.config.json'),
    path.join(os.homedir(), '.config', 'x-post-scheduler', 'config.json'),
  ];
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return {};
}
const fileConfig = loadFileConfig();
const OUTPUT_DIR = process.env.XPS_OUTPUT_DIR || fileConfig.output_dir || path.join(process.cwd(), 'output');

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.error('[x-post-scheduler] 未找到 puppeteer，请先安装：');
  console.error('  cd ' + __dirname + ' && npm install');
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') args.data = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(title) {
  const s = String(title)
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'post';
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.data) {
    console.error('缺少 --data 参数。用法：');
    console.error('  node render.js --data \'{"title":"...","point1":"...",...}\' [--out xxx.png]');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(args.data);
  } catch (e) {
    console.error('[x-post-scheduler] --data 不是合法 JSON：' + e.message);
    process.exit(1);
  }
  if (data.handle === undefined) data.handle = process.env.XPS_HANDLE || fileConfig.handle || '';

  let html = fs.readFileSync(TEMPLATE, 'utf8');
  for (const key of FIELDS) {
    if (data[key] === undefined) console.error('[x-post-scheduler] 警告：缺少字段 ' + key + '，以空白填充');
    html = html.split('{{' + key + '}}').join(escapeHtml(data[key] ?? ''));
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outFile = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.join(OUTPUT_DIR, args.out))
    : path.join(OUTPUT_DIR, today + '-' + slugify(data.title) + '.png');

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: outFile, type: 'png' });
  } finally {
    await browser.close();
  }

  console.log(outFile);
})().catch((err) => {
  console.error('[x-post-scheduler] 渲染失败：' + err.message);
  process.exit(1);
});

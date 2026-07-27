#!/usr/bin/env node
// browser.mjs — 系统浏览器启动器：puppeteer-core 复用本机已装的 Chrome，不下载 Chromium。
//
// 查找顺序：
//   1. CHROME_PATH / PUPPETEER_EXECUTABLE_PATH 环境变量（显式指定，失败则直接报错不兜底）
//   2. puppeteer-core 的 channel:'chrome'（自动定位系统 Google Chrome 稳定版）
//   3. 常见安装路径兜底（Edge / Chromium / Brave）
// 都找不到时报错并给出安装/配置指引。
//
// render.js（海报模板）和 md-assets.mjs（代码/表格转图）共用这里，保证整套 skill
// 只有一条浏览器获取逻辑。

import fs from 'fs';

const CANDIDATES = process.platform === 'darwin'
  ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
  : [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/microsoft-edge',
    ];

export async function launchBrowser() {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    throw new Error(
      '未找到 puppeteer-core。请先运行：cd skills/x-post-scheduler/scripts && npm install',
    );
  }
  const opts = { headless: true, args: ['--no-sandbox'] };
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (envPath) return puppeteer.launch({ ...opts, executablePath: envPath });
  const errors = [];
  try {
    return await puppeteer.launch({ ...opts, channel: 'chrome' });
  } catch (e) {
    errors.push(`Chrome channel：${e.message}`);
  }
  let found = false;
  for (const p of CANDIDATES) {
    if (!fs.existsSync(p)) continue;
    found = true;
    try {
      return await puppeteer.launch({ ...opts, executablePath: p });
    } catch (e) {
      errors.push(`${p}：${e.message}`);
    }
  }
  if (found) {
    throw new Error(`找到系统浏览器但启动失败：${errors.join('；')}`);
  }
  throw new Error(
    '未找到可用的系统浏览器。请安装 Google Chrome（或 Edge / Chromium），' +
    '或设置 CHROME_PATH 环境变量指向浏览器可执行文件。',
  );
}

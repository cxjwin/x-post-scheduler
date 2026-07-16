// config.mjs — x-post-scheduler 共享配置加载。
// 优先级：环境变量 > 工作目录 x-post-scheduler.config.json > ~/.config/x-post-scheduler/config.json > 默认值。
// 所有字段均可缺省：频道/social set 支持 API 自动发现，图床仅在需要配图时才要求配置。
// API key 不在这里管理（见 buffer-post.mjs / typefully-post.mjs 各自的 token 来源说明）。

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_PATHS = [
  join(process.cwd(), 'x-post-scheduler.config.json'),
  join(homedir(), '.config', 'x-post-scheduler', 'config.json'),
];

export function loadConfig() {
  let file = {};
  for (const p of CONFIG_PATHS) {
    if (!existsSync(p)) continue;
    try { file = JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
      console.error(`警告：配置文件 ${p} 不是合法 JSON（${e.message}），已忽略。`);
    }
    break;
  }
  const env = process.env;
  return {
    handle: env.XPS_HANDLE || file.handle || '',
    bufferChannelId: env.XPS_BUFFER_CHANNEL || file.buffer_channel_id || '',
    typefullySocialSet: env.XPS_TYPEFULLY_SOCIAL_SET || file.typefully_social_set || '',
    assetsDir: env.XPS_ASSETS_DIR || file.assets_dir || '',
    assetsRawBase: env.XPS_ASSETS_RAW_BASE || file.assets_raw_base || '',
    outputDir: env.XPS_OUTPUT_DIR || file.output_dir || join(process.cwd(), 'output'),
  };
}

// 从图床本地克隆的 git remote 推导 raw URL 前缀：
// git@github.com:user/repo.git 或 https://github.com/user/repo(.git)
//   → https://raw.githubusercontent.com/user/repo/<当前分支>/
// 非 GitHub 托管时返回 null，需在配置里显式给 assets_raw_base。
export function deriveRawBase(assetsDir) {
  try {
    const remote = execSync('git remote get-url origin', { cwd: assetsDir, stdio: 'pipe' }).toString().trim();
    const m = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) return null;
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: assetsDir, stdio: 'pipe' }).toString().trim();
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}/`;
  } catch {
    return null;
  }
}

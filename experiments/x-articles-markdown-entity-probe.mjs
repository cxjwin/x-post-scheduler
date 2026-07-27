#!/usr/bin/env node
// x-articles-markdown-entity-probe.mjs — 实验：X 官方 Articles API 是否接受未文档化的 MARKDOWN entity。
//
// 背景：X Article 编辑器（DraftJS）的数据模型里存在隐藏的 MARKDOWN atomic entity
//（逆向浏览器扩展 "X Article Markdown Paste" 所得：entityType:"MARKDOWN"、
//  data:{markdown:"```lang\n...\n```"}、mutability:"MUTABLE"），X 渲染端能把它显示成
//  真正可复制的等宽代码块。官方 create-draft 文档（docs.x.com/x-api/articles/
//  create-draft-article）的 block 白名单没有 code-block、entity 示例只有 image/link/post。
//  本脚本验证：API 校验层会不会放行这个 entity。
//
// 用法：
//   node x-articles-markdown-entity-probe.mjs --check          # 验证凭据（GET /2/users/me，不写任何东西）
//   node x-articles-markdown-entity-probe.mjs                  # 跑探针：对照组草稿 → MARKDOWN 变体草稿（只建私密草稿，不发布）
//   node x-articles-markdown-entity-probe.mjs --publish <id>   # 【会公开发布！】人工确认草稿渲染 OK 后，验证公网渲染用
//
// 凭据（永远不要粘进和 agent 的聊天里；在自己的终端写入文件）：
//   OAuth 1.0a（推荐，免浏览器授权流）：developer.x.com 建 App →
//     User authentication settings 启用 OAuth 1.0a + Read and Write →
//     Keys and tokens 页生成四个值（Access Token 必须在权限设为 Read/Write 之后生成），写入：
//       ~/.config/x-api/consumer_key
//       ~/.config/x-api/consumer_secret
//       ~/.config/x-api/access_token
//       ~/.config/x-api/access_secret
//     （对应环境变量 X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET，优先于文件）
//   OAuth 2.0 用户 token（如果你已有，scope 需含 tweet.read tweet.write users.read）：
//     写入 ~/.config/x-api/oauth2_token（或环境变量 X_OAUTH2_TOKEN），存在时优先使用。
//
// 已知前提与未知数：
//   - 发 Article 需要账号有 X Premium（草稿创建是否也要求，探针会揭晓）
//   - Articles 端点要求的 API 资费层级未文档化（Free 层可能直接 403），错误会原样打印——那也是实验数据
//   - 草稿删除端点未文档化，探针草稿请在 x.com 的 Article 编辑器里手动删除

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHmac, randomBytes } from 'crypto';

const API = 'https://api.x.com';
const CFG_DIR = join(homedir(), '.config', 'x-api');

function readCfg(name) {
  try { return readFileSync(join(CFG_DIR, name), 'utf8').trim(); } catch { return ''; }
}

function getAuth() {
  const o2 = process.env.X_OAUTH2_TOKEN || readCfg('oauth2_token');
  if (o2) return { mode: 'oauth2', token: o2 };
  const ck = process.env.X_API_KEY || readCfg('consumer_key');
  const cs = process.env.X_API_SECRET || readCfg('consumer_secret');
  const at = process.env.X_ACCESS_TOKEN || readCfg('access_token');
  const as = process.env.X_ACCESS_SECRET || readCfg('access_secret');
  if (ck && cs && at && as) return { mode: 'oauth1', ck, cs, at, as };
  console.error(
    '错误：未找到 X API 凭据。请在自己的终端把四个 OAuth 1.0a 值写入 ~/.config/x-api/\n' +
    '（consumer_key / consumer_secret / access_token / access_secret，生成方式见脚本头部注释），\n' +
    '或设置环境变量 X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET。'
  );
  process.exit(1);
}

// RFC 3986 百分号编码（OAuth 1.0a 要求比 encodeURIComponent 更严格）
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// OAuth 1.0a HMAC-SHA1 签名。JSON body 不参与签名（仅 oauth_* 参数 + URL query）。
function oauth1Header(auth, method, url) {
  const p = {
    oauth_consumer_key: auth.ck,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: auth.at,
    oauth_version: '1.0',
  };
  const u = new URL(url);
  const all = { ...p };
  u.searchParams.forEach((v, k) => { all[k] = v; });
  const paramStr = Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join('&');
  const base = [method.toUpperCase(), enc(u.origin + u.pathname), enc(paramStr)].join('&');
  const key = `${enc(auth.cs)}&${enc(auth.as)}`;
  p.oauth_signature = createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(p).sort().map((k) => `${enc(k)}="${enc(p[k])}"`).join(', ');
}

async function api(auth, method, path, body) {
  const url = API + path;
  const headers = { 'User-Agent': 'x-post-scheduler-markdown-entity-probe' };
  headers.Authorization = auth.mode === 'oauth2' ? `Bearer ${auth.token}` : oauth1Header(auth, method, url);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function show(label, r) {
  const body = r.json ? JSON.stringify(r.json, null, 2) : r.text.slice(0, 800);
  console.log(`\n—— ${label} ——\nHTTP ${r.status}\n${body}`);
}

function articleIdOf(r) {
  const j = r.json;
  return j?.data?.id || j?.data?.article_id || j?.id || null;
}

// ---- 探针载荷 ----
const key5 = () => Math.random().toString(36).slice(2, 7);
const textBlock = (text, type = 'unstyled') => ({ key: key5(), text, type, entity_ranges: [], inline_style_ranges: [] });

// 对照组：只用文档白名单里的 block 类型。它失败 = 凭据/资费/格式问题，与 MARKDOWN 无关。
function controlPayload() {
  return {
    title: 'API 探针 A：对照组（可删）',
    content_state: {
      blocks: [
        textBlock('对照组：本草稿只用文档化的 block 类型，用于验证凭据与请求格式本身可用。'),
        textBlock('一个二级标题', 'header-two'),
        textBlock('一个引用块', 'blockquote'),
      ],
      entities: [],
    },
  };
}

const SAMPLE_MD = '```python\ndef hello(name: str) -> str:\n    return f"hello, {name}"\n\nprint(hello("world"))\n```';

// MARKDOWN entity 探针：atomic block（text 为单个空格，entity_range 覆盖它——DraftJS 惯例）
function markdownPayload(v) {
  return {
    title: `API 探针 B（${v.label}，可删）`,
    content_state: {
      blocks: [
        textBlock('下面应当渲染成一个可复制的代码块（MARKDOWN entity 探针）：'),
        { key: key5(), text: ' ', type: 'atomic', entity_ranges: [{ offset: 0, length: 1, key: 0 }], inline_style_ranges: [] },
        textBlock('探针结束。若上方是代码块而非空白/占位，说明 API 放行且渲染成立。'),
      ],
      entities: [
        { key: '0', value: { type: v.type, mutability: v.mutability, data: { markdown: SAMPLE_MD } } },
      ],
    },
  };
}

// v1 用编辑器内部同款大小写（扩展逆向所得，已证明存在于线上文章数据模型）；
// v2 用官方文档示例的小写风格（docs 里 link/image/post、mutability 均为小写）。
const VARIANTS = [
  { label: 'v1 MARKDOWN/MUTABLE 编辑器同款', type: 'MARKDOWN', mutability: 'MUTABLE' },
  { label: 'v2 markdown/mutable 文档风格', type: 'markdown', mutability: 'mutable' },
];

async function main() {
  const argv = process.argv.slice(2);
  const auth = getAuth();
  console.log(`凭据模式：${auth.mode === 'oauth2' ? 'OAuth 2.0 user token' : 'OAuth 1.0a'}`);

  if (argv.includes('--check')) {
    const me = await api(auth, 'GET', '/2/users/me');
    show('GET /2/users/me', me);
    process.exit(me.status === 200 ? 0 : 1);
  }

  const pi = argv.indexOf('--publish');
  if (pi !== -1) {
    const id = argv[pi + 1];
    if (!id) { console.error('用法：--publish <article_id>'); process.exit(1); }
    console.log('警告：publish 会把该草稿公开发布到你的 X 账号。');
    const r = await api(auth, 'POST', `/2/articles/${id}/publish`);
    show(`POST /2/articles/${id}/publish`, r);
    process.exit(r.status < 300 ? 0 : 1);
  }

  // ---- 默认流程：探针（只建草稿，不发布）----
  const me = await api(auth, 'GET', '/2/users/me');
  show('凭据自检 GET /2/users/me', me);
  if (me.status !== 200) {
    console.error('\n凭据不可用，停止。请先跑通 --check。');
    process.exit(1);
  }

  const control = await api(auth, 'POST', '/2/articles/draft', controlPayload());
  show('探针 A（对照组，纯文档化 block）POST /2/articles/draft', control);
  if (control.status >= 300) {
    console.error(
      '\n对照组即失败 → 问题在凭据权限/账号资格/资费层级/请求格式，与 MARKDOWN entity 无关。\n' +
      '常见原因：App 权限不是 Read+Write、Access Token 在改权限前生成、账号无 X Premium、API 资费层级不含 Articles 端点。\n' +
      '上面的错误体就是结论，请据此排查后重跑。'
    );
    process.exit(1);
  }
  const controlId = articleIdOf(control);

  const results = [];
  for (const v of VARIANTS) {
    const r = await api(auth, 'POST', '/2/articles/draft', markdownPayload(v));
    show(`探针 B（${v.label}）POST /2/articles/draft`, r);
    const id = articleIdOf(r);
    results.push({ v, ok: r.status < 300, id, status: r.status });
    if (r.status < 300) break; // 一个变体通过即可，不再多建草稿
  }

  console.log('\n========== 实验小结 ==========');
  console.log(`对照组：HTTP ${control.status}${controlId ? `，draft id ${controlId}` : ''}`);
  for (const x of results) console.log(`${x.v.label}：HTTP ${x.status}${x.id ? `，draft id ${x.id}` : ''}`);
  const passed = results.find((x) => x.ok);
  if (passed) {
    console.log(
      '\nAPI 放行了 MARKDOWN entity。下一步人工目检渲染（API 收 ≠ 渲染成立）：\n' +
      (passed.id ? `  打开 https://x.com/i/articles/edit/${passed.id} ` : '  在 x.com 的 Articles 草稿列表里打开探针 B ') +
      '看代码块是否以等宽/可复制形式显示；\n' +
      '  确认后可用 --publish <id> 公开发布做最终公网渲染验证（看完记得在 X 上删除）。\n' +
      '探针草稿（含对照组）不再需要时在 Article 编辑器里删除即可（API 无删除端点）。'
    );
  } else if (results.length) {
    console.log('\n两个变体都被拒 → API 校验层不放行未文档化 entity，此路不通（对照组通过说明这不是环境问题）。');
    console.log('结论支持回退方案：管线内走「高亮图 + Gist 复制链接」。');
  }
}

main().catch((e) => { console.error('探针异常：', e?.message || e); process.exit(1); });

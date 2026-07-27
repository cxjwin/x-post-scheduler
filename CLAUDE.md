# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code skill suite that turns content into X (Twitter) posts: news article → Chinese commentary-style summary + poster → Buffer publish/schedule; plus long-form X Articles via Typefully, an original-meme skill, and an interactive deep-reading skill (link +「深度」keyword → full read → viewpoint discussion/calibration with the user → reflection post or thread). The deliverables are the SKILL.md files (agent workflow instructions) and the Node scripts they invoke. There is no build step, test suite, or linter — verification is running the scripts directly.

All docs and code comments are in Chinese; keep that convention when editing. Scripts use built-in Node APIs where possible (Node ≥ 18, built-in `fetch`); the sole npm dependency is `puppeteer-core`, used only for the HTML poster fallback and code/table image rendering. It reuses an installed system Chrome/Edge/Chromium and never downloads Chromium.

## Commands

```bash
# Interactive setup wizard (installs skill, API keys, config; safe to re-run)
node skills/x-post-scheduler/scripts/setup.mjs

# Connectivity checks (no posts created)
node skills/x-post-scheduler/scripts/buffer-post.mjs --check
node skills/x-post-scheduler/scripts/typefully-post.mjs --check
node skills/x-post-scheduler/scripts/gist.mjs --check

# Test Markdown→X transform without pushing; images land in <output_dir>/md-assets-test/
node skills/x-post-scheduler/scripts/md-assets.mjs --test article.md

# Preview thread split + per-tweet weighted char counts, no network calls (segments separated by --- lines)
node skills/x-post-scheduler/scripts/buffer-post.mjs --dry-run --thread-file thread.txt

# Install puppeteer-core (only needed by render.js and md-assets.mjs image fallback)
cd skills/x-post-scheduler/scripts && npm install
```

Note: paths inside the SKILL.md files use `.claude/skills/x-post-scheduler/...` (the post-install location); the source in this repo lives at `skills/x-post-scheduler/...`.

## Architecture

Three skills; `meme-post` and `deep-read` are SKILL.md-only and share all scripts/config with `x-post-scheduler`. `deep-read` is deliberately interactive (summary + viewpoint draft → user discussion → calibrated final post); its SKILL.md forbids skipping the discussion step.

**SKILL.md files are the core product.** They encode the agent workflow, editorial rules, red lines, and hard-won API facts (the「已验证的 API 事实」sections). When changing script behavior or flags, update the corresponding SKILL.md section and the README (config table +「已踩过的坑」list) — those are the contract agents rely on.

Script layering (`skills/x-post-scheduler/scripts/`):

- `config.mjs` — shared config loader. Priority: `XPS_*` env vars > `./x-post-scheduler.config.json` > `~/.config/x-post-scheduler/config.json` > defaults. `deriveRawBase()` computes the `raw.githubusercontent.com` prefix from the assets repo's git remote. All fields optional: channel/social-set support API auto-discovery (when exactly one exists).
- `buffer-post.mjs` — short tweets. Talks to Buffer's MCP endpoint (`https://mcp.buffer.com/mcp`) via raw JSON-RPC over `fetch` — not the REST API — so any Node environment can publish without an MCP client. Token: `BUFFER_TOKEN` → `~/.config/buffer/key` → `~/.claude.json` buffer MCP headers. First comment rides as `metadata.twitter.thread[1]` in a single `create_post`; `--thread-file` (segments split on standalone `---` lines) builds a full multi-tweet thread the same way, and `--dry-run` prints per-segment weighted char estimates (CJK 2 / ASCII 1 / URL 23) without any network call.
- `typefully-post.mjs` — long-form X Articles via Typefully API v2. Calls `transformMarkdownBody()` from `md-assets.mjs` before creating the draft (`--no-transform` to skip). Uploads body images as Typefully media (POST presigned URL → PUT bytes → poll `ready`) and embeds them with `<typ:media>` tags — Articles do not use the GitHub assets repo. Multi-line code also gets a per-article secret Gist so image readers can copy the original source (`--no-gist` disables this; `--gist-url` reuses one).
- `md-assets.mjs` — Markdown → X-flavor preprocessing: multi-line code → syntax-highlighted PNG (freeze; falls back to the system browser when freeze is missing or code contains CJK), optional Gist deep link below each code image, tables ≤2 cols ≤8 rows → `- **key**: value` lists, bigger tables → dark GitHub-style PNG, inline code → 「」, H3–H6 → bold lines.
- `gist.mjs` — extracts multi-line fenced blocks, assigns stable numbered filenames/anchors, and creates one secret multi-file Gist per Article. Auth priority: logged-in `gh` CLI → `GH_TOKEN`/`GITHUB_TOKEN`; failure is non-blocking.
- `browser.mjs` — shared `puppeteer-core` launcher. Priority: explicit browser env path → Chrome channel → common installed Chrome/Edge/Chromium/Brave paths.
- `render.js` — HTML template poster fallback (`puppeteer-core` + system browser, `templates/poster.html`, colors in CSS variables at top). It is CommonJS, unlike the ESM `.mjs` scripts, and re-implements its own minimal config loading.
- `setup.mjs` — zero-dependency interactive wizard; keys are read without echo and validated live, never passing through chat.

## Constraints verified through production failures — do not "fix" these

- In `md-assets.mjs`, `execFileSync` calls to freeze must keep `stdin: 'ignore'`; with `'pipe'`, freeze ignores the file argument and errors "No input".
- Typefully `media/upload` `file_name` must be ASCII (`^[a-zA-Z0-9_.()\-]+\.ext$`); scripts upload as `code-1.png` etc., decoupled from Chinese local slugs.
- Typefully does not accept `"now"` for publish-at (silently stored as draft). The script converts it to near-future ISO, and re-reads `GET drafts/{id}` afterward because the creation response's `status` is transient.
- X Article title comes from the body's first H1 — `x_article` has no `title` field (422 if sent). External markdown images `![](url)` render as link text only; body images must be Typefully media via `<typ:media>`.
- Buffer never re-hosts images (`assets[].source` keeps pointing at the raw URL): images for still-scheduled posts must not be deleted from the assets repo. Buffer's GraphQL has no media-upload mutation; image URLs must be public.
- A GitHub raw 429 from local curl is client-side rate limiting only — Buffer's servers fetch fine; push then post, never wait/poll.
- Poster bullet character: 「•」, never 「▸」 (missing glyph in Chinese overlay fonts renders tofu).

## Safety design (deliberate, preserve when editing SKILL.md)

- Publishing defaults to human confirmation. The auto-publish toggle is the「自动发布授权」line inside `x-post-scheduler/SKILL.md`; four red-line content categories (politics/disasters, unsourced accusations, paywalled content, suspected misinformation) always fall back to manual confirmation regardless.
- `meme-post` is never covered by the auto-publish authorization, and must never copy original text or images — only meme formats/mechanics, with a similarity self-check.
- `deep-read` is never covered by the auto-publish authorization either; the discussion/calibration step is mandatory, and stances the user has not endorsed must not appear in the final post.
- API keys never go through chat; if a user pastes one, instruct them to rotate it.

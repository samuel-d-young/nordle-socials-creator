# Nordle for Buffer Commit

Nordle is entered in Buffer's first build contest (28 October to 13 November 2026). Existing projects may enter if they say clearly what was built in the window. This page says it.

## What existed before 28 October 2026

The whole studio: the Studio (calendar, wall, review queue, plan, insights), the picture and video editors, Claude as designer with three-layer checks, the calendar, stock libraries, and publishing through Buffer with a pasted API key (scheduling, moving and deleting posts to keep Buffer in step, "When to post" from sent posts). Its history is in the repository.

## What was built in the window

| What | Where to look |
|---|---|
| **Sign in with Buffer**: OAuth 2.0 authorization code with PKCE (public client), single-use refresh tokens renewed under a lock, a hosted HTTPS return page that forwards only to the user's own computer, and a public landing page | `src/publish/buffer-oauth.mjs`, `src/server/routes/buffer-oauth.mjs`, `app/studio-buffer-signin.js`, `app/oauth-callback.*`, `site/` (docs/PUBLISHING.md, "Sign in with Buffer") |
| **Automatic analytics from Buffer**: sent posts and their results are read every few hours into Insights, within Buffer's request allowance | `src/publish/auto-pull.mjs`, `src/performance/from-buffer.mjs` |
| **Options for reading Buffer**: how often (every 1, 3, 6, 12 or 24 hours), whether to copy numbers, whether to copy posts made by hand, how far back, how many at a time, whether to save pictures; in Insights, Options | `src/publish/pull-options.mjs`, `src/server/routes/buffer-pull.mjs`, `app/buffer-pull-options.js` |
| **Posts made by hand in Buffer appear on the calendar**, read only (sync never moves or deletes them) | `src/publish/buffer-import.mjs`, `src/publish/sync.mjs` (skips them) |
| **TikTok channels** through Buffer | `src/publish/adapters/buffer.mjs`, `tests/buffer-tiktok.test.mjs` |
| Security hardening found by a review during the window (case-insensitive hidden folders, a narrower headless-run tool list, no shell for launchers, renderer sandbox, redirect header stripping) | `SECURITY.md` |

## Buffer API used

- OAuth: `https://auth.buffer.com/auth` (authorization code + PKCE, S256) and `https://auth.buffer.com/token` (code exchange and refresh). Scopes requested: `account:read`, `posts:read`, `posts:write`, `offline_access`.
- GraphQL at `https://api.buffer.com`: `account { organizations }` and channels; `createPost` (Instagram, Facebook, TikTok; reels, carousels, images, stories; scheduled or draft); `editPost` (move a post's time); `deletePost`; `post`; and `posts` with filters for scheduled and sent posts, returning words, pictures and results.
- Buffer's request allowance is respected: every optional read keeps a reserve, and the automatic reading waits at least as long as the owner chose (default six hours).

## Try it

1. `git clone https://github.com/samuel-d-young/nordle-socials-creator nordle && cd nordle`
2. `node setup.mjs` then `node server.mjs --open`, and open the Studio at `http://127.0.0.1:5400/`.
3. Publishing, then **Sign in with Buffer**. The first run also copies a made-up sample brand, so there is something to schedule.

Building posts with Claude needs Claude Code signed in; reviewing, editing, scheduling and the Buffer features do not.

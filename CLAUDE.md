# nordle — social-media editor you and Claude edit together

Local app (Node, 127.0.0.1) for video cut from real footage, motion-graphics video, carousels, single graphics and
post copy. Review (pins, versions, approvals, hand-off) plus direct editing, Claude diffs, locks.
Created by Samuel Young; open source under CC BY 4.0 (credit him: see ATTRIBUTION.md). The owner's own notes and client work are in the gitignored `private/` and `projects/` folders, never in the repo.

## Rules that are easy to break

- **Clean-room.** Never copy code, text, sample projects or file formats from another tool whose licence does not allow it into this
  repo. Describing features in our own words is fine.
- **Nothing client-specific in this repo.** Client material lives in the gitignored `projects/`, `private/` and `packs/` folders.
  No client names, logos, photos, local drive paths, emails or tokens in tracked files. `npm run share-check` scans for them using
  the local, gitignored `.share-deny.txt` (one term per line); run it before a release. Use the fictional `samples/little-gannet` in
  examples, docs and tests.
- **Credit.** Nordle was created by Samuel Young and is CC BY 4.0. When you introduce Nordle, say so; when someone forks, rebuilds or publishes on it, tell them the licence requires credit to him (link, licence, changes) and help them add it. Keep LICENSE, ATTRIBUTION.md and the in-app credit (Studio footer, `nordle doctor`).
- **Licences.** MIT/Apache/BSD/OFL/CC BY only in the core (what it depends on and ships). Check `LICENSES.md` before adding a dependency or asset, and add a
  line for every asset. No Remotion, no `@imgly/background-removal` (AGPL), never bundle ffmpeg, no Epidemic Sound audio.
- **Paths in documents** are relative to the project root and may not contain `..`, a drive letter or a backslash.
  The schema, the validator, the renderer's request filter and the server's file routes all enforce this; keep all four.
- **Server security** (src/server/http.mjs): 127.0.0.1 only; Host header must be localhost (DNS rebinding); every /api call
  needs the per-run token that only the served page knows; writes must be JSON (uploads: octet-stream + filename header);
  no CORS headers, ever; bodies capped; project files served with `sandbox` CSP and nosniff; `history/` and `review/` are
  never served as files. Tests in tests/server.test.mjs pin all of this. **Two tokens:** the owner's (embedded only in the
  served page) and Claude's (written to `.nordle/runtime.json` for the MCP server). The agent token cannot undo, approve,
  accept/reject changes, restore, change autonomy, adopt/discard takes, create projects or write the review file. Never
  write the owner's token anywhere. See SECURITY.md for what is and is not a guarantee.
- **Locks are enforced on the server** (src/shared/ops.mjs `lockViolations`, applied to actor `claude`), not only in the UI.
  Humans see locked layers as non-selectable but may unlock them.
- **No pop-up windows on Windows.** Every `spawn`/`spawnSync` sets `windowsHide: true`; never `stdio: 'inherit'` from a
  GUI parent.
- **Edit files with the Write/Edit tools, not shell heredocs or scripted string replacement.** The Bash tool collapses
  backslashes (a `\n` in generated JS became a real newline), and `String.replace` treats `$'` in the replacement as a
  special pattern (it duplicated a whole file once). If you must script an edit, use split/join.
- **Never pass `null` to `Element.append` / `replaceChildren`**: it prints the text "null". Use `h()` (it skips nulls) or
  `.filter(Boolean)`.
- **Do not rebuild a carousel with a plain `node nordle.mjs build` if its project has its own helper scripts** in `projects/<brand>/specs/`
  (they run the stock build, then rewrite every page that carries a `house` block; a plain build drops that look and overwrites the saved
  document). Reels are different: `node nordle.mjs reel` is the right command.
- Commit with the GitHub noreply address (set repo-locally), never a work or personal email. Commit and push only when the owner asks.

## Layout

- `nordle.mjs` CLI (doctor, validate, render, verify). `server.mjs` starts the editor (`npm start`, port 5400).
- `schemas/` JSON Schemas (`nordle.doc|brand|platforms|pack|review/0.1`). `data/platforms.json` sizes, safe zones, limits.
  `fonts/` bundled OFL fonts + `manifest.json`.
- `src/shared/` runs in Node **and the browser**: `ops.mjs` (JSON Patch with exact inverses, lock check), `tokens.mjs`.
- `src/render/`: `html.mjs` document -> HTML (browser-safe; all lengths from --cw/--ch/--u; caller passes `fontManifest`
  and `urls`), `browser.mjs` Playwright session with request interception, `render.mjs`, `checks.mjs` + `verify.mjs`,
  `sheet.mjs`, `context.mjs`, `urls.mjs` (Node-side settings).
- `src/server/`: `http.mjs` routes + security, `store.mjs` documents/history/undo/locks/review/versions/approvals,
  `handoff.mjs` "Copy for Claude" text, `browserpool.mjs`.
- `mcp.mjs` the MCP server entry (stdio). `src/mcp/`: `protocol.mjs` (JSON-RPC/MCP, hand-written, no SDK), `tools.mjs` (the
  `nordle_*` tools), `client.mjs` (finds/starts the editor server via `.nordle/runtime.json`). `skills/nordle/SKILL.md` and
  `docs/AGENT-GUIDE.md` (also returned by `nordle_get_guide`) are what teach Claude to use it: keep them true to the tools.
- `src/shared/diff.mjs`: describes a change in words and keeps "regions" so one change can be taken back exactly.
  Autonomy (suggest / review / apply), pending changes, Explore takes live in `src/server/store.mjs` (`claudePatch`,
  `ReviewSession.decide`, `createTakes`).
- `app/` the editor (vanilla ES modules, no build step): `main.js` layout/router, `state.js`, `doc.js` (all edits and
  review actions), `canvas.js` (iframe + selection/drag/resize/rotate/snap/pins), `props.js`, `left.js` (pages, layers),
  `review.js`, `copy.js`, `topbar.js`, `home.js`, `dom.js`, `api.js`.
- `app/video-*.js` the **video editor** (a document with `kind: "video"` gets route `video`, not `edit`; the picture editor's panels do not
  run for it). `video-editor.js` layout, tabs, keyboard and following the document; `video-state.js` its own store (playhead, selection,
  zoom: apart from `state.js` because the playhead moves while playing) and time helpers; `video-data.js` what it asks the server for
  (waveforms, words, check, formats, preview files, proxies, render jobs); `video-actions.js` every edit (asks `src/shared/cutlist.mjs` for
  operations, sends them with `commit()`); `video-timeline.js` + `video-drag.js` + `video-wave.js` + `video-toolbar.js` the lanes, pointer
  editing, waveform drawing and buttons; `video-monitor.js` (Frame, Cut, Source); `video-transcript.js`; `video-inspector.js`;
  `video-check.js`; `video-export.js`; styles in `video.css`. Docs: `docs/VIDEO.md` "Editing in the editor". Tests: `tests/video-editor.test.mjs`.
  Keep new class names prefixed (`vt-`, `vm-`, `vtr-`, `vi-`, `vx-`): `.alt`, `.sel` and `.count` already mean something in `studio.css` and `styles.css`.
- `tools/`: `validate.mjs`, `doctor.mjs`, `make-sample-media.mjs`. `tests/`: validate, ops, render, server, editor (e2e).
- `samples/little-gannet/`: fictional sample brand. `projects/` (gitignored) is where the editor keeps your work; the sample
  is copied there on first run. `sources/`, `out/`, `history/`, `review/` are generated per project.

## Commands

- `npm start` runs the editor and opens it. `npm run doctor`, `npm run validate`, `npm test` (about 690 tests, 4 to 6 minutes; the browser-driven ones are timing-sensitive on a slow or busy computer, so rerun a failing file alone before suspecting the code), `npm run verify`.
- Connect Claude Code: `node setup.mjs --register` (or `claude mcp add nordle -- node /full/path/to/nordle/mcp.mjs`); the MCP server starts the editor if needed.
- `node nordle.mjs render <doc|project> [--sheet] [--safe] [--size ..] [--page ..]`, `node nordle.mjs verify <doc|project>`.
- First time on a machine: `npx playwright-core install chromium`.

## Conventions

- Ids match `^[a-z0-9][a-z0-9_-]*$`. Brand values are referenced as `$brand.colors.accent`, `$brand.fonts.display`.
- `layout`: `x,y,w,h` numbers are percentages of the canvas (x,w of width; y,h of height); `anchor` says which point of
  the layer sits at x,y. `size` (font) is px on a 1080-wide reference and scales. Group children are positioned from the
  group's origin. `radius` numbers are px on the 1080 reference.
- Edits are JSON Patch ops sent to `POST .../patch` with `baseVersion`; the server validates the whole document, saves it,
  appends `history/<doc>.jsonl`, and broadcasts over SSE (`origin` = the sending tab, so a tab ignores its own echo).
- Per-size changes live in `layer.overrides[sizeId]` (layout, style, hidden, text, animate).
- Keep a darker accent in the brand for text on light backgrounds; `verify` says when you need one.
- Platform presets are data and all start `verified:false` until checked against the platform's current guidance.
- Native drag-and-drop cannot be started by a scripted mouse; e2e tests dispatch the DragEvents (`htmlDrag`).

## Added after Phase 3 (designer-first, video, calendar, checks, Studio)

- **Plug-in points** (add a file, don't edit the core): server routes `src/server/routes/*.mjs` (shape in `routes/index.mjs`), MCP tools
  `src/mcp/tools/*.mjs` (`(client, helpers) => tool[]`), CLI commands `src/cli/*.mjs` (`{name, usage, summary, run(args)}`; loaded lazily
  so they cannot break `doctor|validate|render|verify|critique`). Tests are `tests/*.test.mjs` (the npm script runs the glob).
- **Claude as designer.** `src/shared/patterns.mjs` (layout patterns: cover, statement, list, item, stat, quote, image-hero, split,
  cta, person) + `src/shared/brand-style.mjs` (the brand's `posts` house-style block in brand.json: headline sizes/accents, kicker,
  text zone, gradients, footer, logo by tone, Swipe pill, photo fade, end-card slots) + `src/render/critique.mjs`
  (`data/design-rubric.json`; score out of 100, pass 88). `node nordle.mjs build <project> <spec>` = spec -> post -> critique -> sheet
  (`src/shared/build-spec.mjs`). Reels: `src/shared/reel-spec.mjs` + `node nordle.mjs reel <project> <spec> [--sheet|--render]`.
- **Video engine** `src/video/*` (ffmpeg from the PATH, never bundled; overlays via the same HTML renderer): see `docs/VIDEO.md`.
  Editing a timeline (split, trim, move, delete, cut by words, bring back) is `src/shared/cutlist.mjs`: pure and browser-safe, it only
  returns JSON Patch; `node nordle.mjs cut`, the `nordle_cut_*` tools and `POST .../cut/words` sit on top (`docs/VIDEO.md` "Cutting").
  Footage is read in place through **mounts** (`nordle.local.json`, paths `mount:<name>/...`), never copied.
- **Checks** `src/verify/*`: three layers (auto / designer / independent reviewer) recorded per document version in
  `<project>/checks/<doc>.json`; `nordle check|packet|record|finish`. Rule packs (`examples/packs/ahpra-dental`) are wording lint,
  not legal advice. `facts.json` is the only source for phones, addresses, names, titles.
- **Calendar** `src/calendar/*` + `docs/CALENDAR.md`: ideas -> owner approval -> auto-build near the date (off by default). Write the
  calendar only through `src/calendar/service.mjs` (it locks and enforces status rules). Owner-only actions need the human token.
- **Studio** (`app/studio*.js`, `src/studio/*`, `src/server/routes/studio.mjs`): the front door. Design notes in `docs/UI-DESIGN.md`.
- **Client material** (brand projects with photos, footage paths, captions) lives only in the gitignored `projects/` and `private/`.
- **Publishing** `src/publish/*` + `docs/PUBLISHING.md`: adapters (`bundle` export folder; `buffer` GraphQL, unverified against the live API; Buffer needs public
  HTTPS media URLs). Plan -> owner runs (human token only) -> audit log in `<project>/publish/log.jsonl`. Tokens live in the gitignored `.nordle/publish.json`, never in a project.
- **Stock libraries** `src/stock/*` + `docs/STOCK.md`: a library plugs in as data (a JSON definition; presets for Pexels, Pixabay, Freesound, unverified), as a folder of the
  owner's own stock (Envato Elements has no download API), or as code (`src/stock/libraries/*.mjs`). `nordle stock`, `/api/stock/*`, `nordle_stock_*` tools. Owner adds libraries and keys
  (never in a reply); files land in `<project>/assets/stock/` with a licence ledger and a "not looked at yet" catalog entry. Nordle never buys or signs in anywhere.
  The Studio's **Stock window** is `app/studio-stock.js` (+ `.stk-*` in `studio.css`; tests `tests/studio-stock.test.mjs`, which use a fake fetch via `configure({ fetch })` and a temp
  `NORDLE_PUBLISH_DIR`, never the real settings): keys are typed there once and never come back to the page. Thumbnails go through `GET /api/stock/thumb` (`src/stock/pictures.mjs`), which only
  fetches addresses a recent search returned: keep it that way, it is a proxy. Libraries are used by Claude automatically while it builds (`stockBrief` / `stockLines`), and a folder can be added during setup (`app/studio-stock-setup.js`); any test that saves a stock library must set a temporary `NORDLE_PUBLISH_DIR`.
- **Brands** `src/brand/*` + `src/server/routes/brand.mjs` + `app/studio-brand.js`: each brand has a simple style guide (a subset of `brand.json`: name, colours, the two fonts, voice, handle and website; schema-checked on save, the rest of the file untouched), and **Add a brand** makes a project from a guide the owner has checked, optionally drafted by `scanBrand` (local folder, website, Instagram public preview, pasted captions; saves nothing, takes an injected `fetchImpl` for tests). Stock libraries can be limited to some brands (`brands` on the library; empty = all). A brand may carry an `industry` ({ label, regulated?, rules? }): `src/brand/industry.mjs` finds it from the words the brand uses about itself (keyword counting that names its evidence; the owner can type their own), `industryRules()` puts "check the rules of this field where the business operates" into the prompts, and `tests/brand-industry.test.mjs` keeps the wizard's list and the server's in step. Set-up can also read several folders, files the person adds (staged in the system temp folder by `POST /api/brand/upload`, kept in the brand's `assets/brand/` when it is made; `src/brand/guide-text.mjs` reads a written style guide literally: colours, fonts, tone, phrases to avoid) and uses the system's folder window through `POST /api/brand/pick-folder` (`src/server/folder-picker.mjs`, injectable for tests). Tests: `tests/brand-files.test.mjs`, `tests/folder-picker.test.mjs`, `tests/brand.test.mjs`, `tests/studio-brand.test.mjs`.
- **Request changes starts the designer** (`src/studio/revise.mjs`, `autoRevise` calendar setting) and **automatic scheduling** (`src/publish/auto.mjs`, owner-enabled, off by default): see
  `docs/CALENDAR.md` and `docs/PUBLISHING.md`. The server (`server.mjs`) passes `createReviser()` / `createAutoScheduler()` to `createNordleServer`; tests use fakes.
- **Buffer is kept in step with Nordle** (`src/publish/sync.mjs`, `auto-sync.mjs`, `node nordle.mjs publish sync <project> [--yes]`, `docs/PUBLISHING.md` last section): moved calendar posts are moved in Buffer, posts for items that are not signed off are deleted, posts it did not make are left alone. A calendar item that is already `scheduled` cannot take a new result: rewrite its targets by `markUnscheduled` then `markScheduled`.
- **Claude at work** `src/calendar/jobs.mjs` + `POST /calendar/run` + `GET /calendar/run-status` ("Ask Claude now", "Build it now"; tests inject a fake `claudeRunner`: ALWAYS pass one in a test that starts a run, or the real `claude` starts); the Studio post gets a `build` block (`buildOf` in `src/studio/data.mjs`) and `buildLine()` in `app/studio-ui.js` shows it. Tests: `tests/claude-at-work.test.mjs`.
- **Brand kit** `docs/BRAND-KIT.md`: logo kinds (`src/brand/logos.mjs`, `assets/logos/`, `logoFor` picks white on dark), a screenshot of a brand page and example posts ("train") read by Claude (`src/brand/screenshot.mjs`, `src/brand/train.mjs`; tests inject `brandReader` / `exampleReader`, never start the real one; estimated colours are snapped to the real pixels), UI in `app/studio-logos.js`. Claude Code is found by `src/calendar/claude-bin.mjs` (PATH, installer folders, the desktop app's copy).
- **Reel options and guidance** `src/shared/reel-options.mjs` (browser-safe: styles auto/footage/motion/voiceover, what a reel uses, length, `reelPromptLines` for the build prompt), `item.reel` + `item.guidance` in the calendar service/schema/MCP, `app/studio-reel.js` (the chooser used by the Create page and the idea editor). Voice-over reels: `voiceover` + scene `say` in `src/shared/reel-spec.mjs`, phrases found by `src/shared/voice-sync.mjs`; `nordle reel` loads the word timings. Tests: `tests/reel-options.test.mjs`, `tests/reel-voiceover.test.mjs`. No text-to-speech is bundled: the voice-over is always the owner's own recording. Shape (`reel.shape`: vertical, portrait, square, landscape) maps to a size through `reelSizeOf`. Motion graphics: `src/shared/motion-kit.mjs` (scenes of `type: "motion"`: recipes kinetic, number, list, quote, bars, ticker, reveal, logo) on engine features added to `schemas/doc.schema.json`, `src/render/html.mjs` (radial gradients, `blur`, `blend`, `path` shapes) and `src/video/overlay-runtime.mjs` + `overlay.mjs` (presets blur-in, tracking-in, count-up, draw, spin-in, loops float/sway/pulse/drift ...). Tests: `tests/motion-kit.test.mjs`; when you change the kit, build a sheet (`nordle reel ... --sheet`) in vertical AND landscape and look at it. Jobs: `src/calendar/jobs.mjs` queues a second request for a brand while Claude is busy (one at a time, up to 20, same request not twice) and `retryWhileLocked` waits out another run; a change asked for while a post is being built is kept as `pendingChanges` and applied by `linkDoc`, then `reviser.sweep` starts the designer (tests: `tests/job-queue.test.mjs`, `tests/queue-edits.test.mjs`).
- **Signing in to Claude Code without a terminal** `src/calendar/claude-login.mjs` + `src/server/routes/claude.mjs` (`GET /api/claude`, owner-only `POST /api/claude/login`): starts `claude auth login --claudeai`, the browser approves, `claudeSignIn()` in `app/studio-ui.js` is the button (top banner, screenshot reader, Create job error). Signing out / switching account: `logoutClaude()` (`claude auth logout`), owner-only `POST /api/claude/logout` (refused while a Claude job runs; the account email is returned to the owner only, never to Claude's token), and the rail's **Claude account** window `app/studio-claude.js`. Tests inject `claudeLoginFns` ({ start, cancel, state, logout, busy }); never start the real login or logout in a test. Tests: `tests/claude-signin.test.mjs`.
- **The standard is "go all out"** (the owner's rule, built in): every build prompt carries it (`standardLines` in `src/calendar/prompts.mjs`), every video must pass the `motion` check (`src/verify/motion.mjs`, required in `requiredChecks`, pass 85; tests `tests/motion-check.test.mjs`), pictures the design check (88), and the reel builder's defaults use staggered, varied entrances. Keep new defaults and kit scenes passing it.
- **Being made banner** `app/studio-making.js` + `src/server/routes/making.mjs` (`GET /api/making`: job line + revisions in memory) on every page; List rows use `makingState`/`makingChip`. Any redraw must go through `keepTyping(root, draw)` (studio-ui.js) so typing is never interrupted; notices are click-through except their buttons.
- **Create page** Simple mode (default) is `app/studio-create-simple.js` (say it, pick from a board of frame strips, Claude makes them; `?mode=advanced` in the address or the switch for the rest); Advanced is `app/studio-create.js` + `src/calendar/suggest.mjs` + `GET /calendar/suggest`: options for next month from the brand's facts, occasions, the missing mix and (with results) what did well; the owner ticks and adds them to the calendar. Tests: `tests/create-suggest.test.mjs`. Docs: `docs/CALENDAR.md` "The Create page".
- **Performance review** `src/performance/*` + `docs/PERFORMANCE.md`: `metrics.json` per project (CSV import / manual), analysis relative to the account's own history,
  weekly or monthly REVIEW prompt -> `reviews/<period>.md` + plan changes through the calendar service (edited approved ideas return to `idea` for the owner). Studio **Insights** view.
- **Owner rulings are data, not memory** (for example "never name a single branch"). They live in `brand.json` `voice.bannedPhrases`, `facts.json` (`bannedClaims`, network-level contacts only)
  and `doNotUse` in the catalogs, so `nordle check` enforces them.

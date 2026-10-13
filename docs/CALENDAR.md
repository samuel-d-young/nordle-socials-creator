# The content calendar: plan months ahead, approve the ideas, posts build themselves

The calendar is `calendar.json` in a project folder. Claude **proposes** ideas into it, the owner **approves, edits or rejects**
them in the Studio, and as an approved idea's date comes within the lead time Claude **builds** the post (a document made with
the build or video tools, checked, linked to the item). The owner **signs it off**, and posts it later. Nordle posts nothing
by itself (the owner can hand signed-off posts to Buffer or an export folder from the Studio: `docs/PUBLISHING.md`), and the two automatic parts (auto-build, auto-propose) are **off** until the owner switches them on.

```
 idea ──owner approves──> approved ──date within leadDays──> building ──> built ──owner signs off──> signed-off ──> (scheduled) ──> posted
   │                         ▲                                   │          │
   └─owner rejects─> rejected │                      failure: back to approved   └─owner asks for changes─> changes ──> (Claude revises) ──> built
```

| status | meaning | who sets it |
|---|---|---|
| `idea` | proposed, waiting for a yes | Claude (or the owner) |
| `approved` | the owner said yes: build it when its date is near | **the owner** (or "delegated", below) |
| `building` | a run is working on it right now | the runner |
| `built` | a post exists and is waiting for sign-off | Claude (link) or `nordle build` |
| `changes` | the owner sent a built post back with a comment | **the owner** |
| `signed-off` | ready to schedule | **the owner** |
| `scheduled` | handed to a publishing adapter (Buffer) for its date and time, on every channel chosen for it; `item.publish` (with `targets`, one per channel) says where | **the owner**, by running a plan (`docs/PUBLISHING.md`) |
| `rejected`, `posted` | no; or it has gone out | **the owner** |

## Who may do what

Two tokens exist (see `SECURITY.md`): the owner's, only in the served page, and Claude's, in `.nordle/runtime.json`.

* **Claude can**: read the plan, propose ideas (they arrive as `idea`), edit an idea's fields, link a finished post to an item.
* **Only the owner can**: approve, un-approve, reject, sign off, ask for changes, mark posted, retry a stuck item, change the
  settings, approve all ideas, override the idea checks. These are 403s for Claude's token (route level), absent from Claude's
  MCP tools, and refused by the command line when it runs inside one of Claude's headless runs (`NORDLE_AGENT_RUN=1`).
* If Claude edits what an idea the owner approved *says* (title, idea, hook, date, format, pillar, ...), the item goes back to
  `idea`: the owner approved the old version, not the new one. Notes and time changes do not reset it.
* A built, signed-off or posted item only takes notes from Claude.

**Delegated approval.** "the owner is asleep and said go ahead" is `settings.ideaApproval = "delegated"` (owner sets it, or the owner
passes `--delegated` to `calendar add` on the command line). Ideas Claude then proposes arrive `approved` with
`ideaApproval: "delegated"`, so the record shows the owner did not look at them first. Everything else (checks, quotas) is unchanged.

## The files

* `calendar.json` (`schemas/calendar.schema.json`): `settings` and `items`. Settings (all optional):
  `leadDays` (7), `perMonth` (`{reel:8, carousel:3, post:2}` = 13), `autoBuild` (false), `autoPropose` (false), `horizonMonths` (3),
  `postTimes`, `pillars` (`[{id,name,about,share}]`), `regions` (`["VIC"]`, `["WA"]`: which states' holidays, school terms and
  occasions apply; set it), `ideaApproval` (`owner` | `delegated`), `compliance` (`["ahpra"]`; dental and other health brands are
  treated as regulated even without it), `maxBuildAttempts` (3), `review` (`{cadence: weekly|monthly, weekday?, autoReview?}`: the
  performance review rhythm, see `docs/PERFORMANCE.md`; `calendar run` mentions a due review and writes it only with `autoReview`).
  `timezone` at the top (default `Australia/Melbourne`).
* `data/occasions-au.json`: the Australian dates library (below).
* `<project>/history/calendar-runs/*.json`: a log of every headless run (exit code, outcome, Claude's own summary, cost, the
  command line, stderr tail). `<project>/.calendar-run.lock` while a run is going; `<project>/.calendar.lock` for a moment during a write.

## Quotas and slots

The default is 13 a month: 8 reels plus 5 others (3 carousels and 2 single posts). Rejected ideas do not count. The "others" share
one pool: five carousels and no single posts is a full month. `calendar slots <project> 2026-11` (or `nordle_calendar_slots`)
shows the free dates that would fill a month: evenly spread over weekdays, one a day, existing items kept, public holidays and
past days avoided, the same format kept off back-to-back days and no more than two reels in a row.

## What counts as a good idea (the checks)

Every idea Claude proposes is checked before it is saved; the owner's own items are only *warned* about. Errors refuse the idea
with the reason; warnings are saved with it.

* errors: a date in the past or not real; the title or hook uses a banned phrase (`brand.voice.bannedPhrases` and anything in quotes in
  `voice.dont`); the same hook as another item; the same angle as another item within 90 days; an unknown pillar (when pillars are
  defined); the month already at its quota (reels, or the other formats together); missing idea/hook/pillar; and for health brands
  the Australian health-advertising no-gos (before-and-after, testimonials, reviews and ratings, "guarantee", "painless",
  "cure", "no risk", "miracle", implant time periods).
* warnings: a banned phrase used only in the description (and not being negated: "no results" is fine); "best", "safe", offers and
  giveaways; a figure (price, percentage, phone number, "N years") that is not in `facts.json`; two items on one day; the same format on
  consecutive days; a pillar over its share; an occasion that is not in the library, whose date needs verifying, that calls for a quiet
  tone, or that is far from the post's date; a day that is a public holiday in the brand's regions.

## The Australian occasions library

`data/occasions-au.json` holds rules, not lists of years: public holidays (national, VIC, WA), Melbourne Cup Day, Halloween, Movember,
Black Friday and Cyber Monday, Christmas and New Year with their observed days, Easter, Mother's and Father's Day, EOFY, the private
health-fund year-end reset, World Smile Day, World Oral Health Day, Dental Health Week, school terms and holidays for VIC and WA, and a
few established awareness days. Each has a date rule, regions, tags, relevance to a dental audience, a `confidence`, a `verify` flag,
and `advice` (`closed`, `respectful`, `avoid-promo`, `post-ok`).

**It is a planning aid, not an authority.** School dates (all of them), Dental Health Week, NAIDOC Week, R U OK? Day, WA's King's
Birthday, the Grand Final holiday, observed Christmas days, Diwali and the fund-year reset are `verify: true`: the plan may use them,
a post must not state the date until someone has confirmed it from the source named on the entry. Nothing is listed that we could not
stand behind; an unsure day was left out rather than guessed. `calendar occasions [project] --from --to` lists them.

## Commands

```
node nordle.mjs calendar status [project]
node nordle.mjs calendar list <project> [--month 2026-11] [--status idea]
node nordle.mjs calendar add <project> --date 2026-11-12 --format carousel --title ".." --pillar p --idea ".." --hook ".." [--media ".." --occasion ".."]
node nordle.mjs calendar add <project> --file ideas.json [--approved | --delegated] [--force]      (a list, or {ideas:[..]})
node nordle.mjs calendar approve <project> <item> | --all-ideas [--month 2026-11]       reject | unapprove | signoff | posted | retry
node nordle.mjs calendar changes <project> <item> --comment "warmer cover"
node nordle.mjs calendar link <project> <item> <doc>
node nordle.mjs calendar settings <project> [--auto-build on] [--lead-days 10] [--regions VIC] [--per-month reel=8,carousel=3,post=2] [--idea-approval delegated] ...
node nordle.mjs calendar slots <project> 2026-11        due <project>        occasions [project]        lint <project> [item]
node nordle.mjs calendar prompt <project> [item | --month 2026-11,2026-12] [--revise]
node nordle.mjs calendar run [project | --all] [--yes] [--dry-run] [--propose] [--limit 5] [--item id] [--timeout-min 25]
node nordle.mjs calendar schedule-install [--time 06:00] [--all | project]
```

`<project>` is a folder, or an id under `projects/` (or the folders in `NORDLE_PROJECTS`). `--today 2026-11-05` pretends it is that day
(also `NORDLE_TODAY`). Exit codes: 0 fine, 1 failed or refused, 2 usage, 3 an owner-only step was refused.

`calendar add` from the command line is strict like Claude's tools: a refused idea prints why. `--force` keeps it anyway (owner only).
By default a command-line add creates an `idea`; `--approved` is the owner's own item; `--delegated` is "go ahead without asking me".

## Request changes does the change (`autoRevise`)

In the Studio, **Request changes** records what was asked (your note and your open comments) and then starts the designer on that post at once
(`src/studio/revise.mjs`, which runs this same headless runner for that one item with `yes`): you do not wait for a daily run. `settings.autoRevise` is
on unless you set it false (`calendar settings <project> --auto-revise off`). One revision at a time per project (others queue), a project another
process is building in is retried every 30 seconds, and Undo on the request stops a run that is going. While it works the post says "Claude is changing
this post now" and cannot be approved or sent back again; when it finishes the post returns as **Updated** with your comments ticked, and when it
cannot it says why ("Ask again" tries once more). A server restart puts back a revision a dead run left half-done and starts it again.

* The revise brief tells the designer to make the smallest change, to edit the post's existing spec, to rebuild with the project's own helper (a
  `specs/_go*.mjs`, `make.mjs`...: never a plain `build`, which drops a house look) or with the reel command for a reel, and, when a request cannot be met
  truthfully (the photo asked for is not in the catalogs), to say what is missing on that comment and leave it open instead of faking it.
* **It needs Claude Code to be signed in on this computer** (once: Nordle shows a **Sign in to Claude** button, in the banner at the top and wherever Claude is needed, that opens the browser to approve; `claude auth login` in a terminal does the same). To use a different account, open **Claude account** in the left bar: it shows who Claude is signed in as (only you see this), and **Switch account** signs out and opens the browser for the other one; **Sign out** just signs out. Nothing is deleted at Anthropic. It is refused while Claude is working on a post): the headless `claude -p` has its own sign-in and does
  not use the desktop app's. When it is not, the post says exactly that and what to type, instead of a raw error, and nothing else is tried.
* `node nordle.mjs calendar watch [project]` prints one line the moment a post is sent back (`SENT-BACK <project> <item> doc=<doc> | <what was asked>`):
  an open Claude session (signed in through its app) can watch that and make the change itself while the CLI is not signed in. `node nordle.mjs feedback
  <project> <doc> [--reply <id> "text" --resolve]` reads, answers and ticks off comments from the command line.

## The runner (`calendar run`)

`runDue` builds what is due: approved ideas whose date is within `leadDays` (and posts the owner sent back with changes, which it revises
in place). It does nothing unless `settings.autoBuild` is on or `--yes` is given. For each item, one at a time:

1. takes the project's run lock (`.calendar-run.lock`; a lock whose process died, or that is far too old, is taken over; items a dead
   run left on `building` are put back to `approved`);
2. marks the item `building`, composes the BUILD prompt (`calendar prompt <project> <item>` prints it) and starts `claude -p` in the
   project folder with the prompt on stdin, a temporary MCP config for this install's `mcp.mjs`, `--strict-mcp-config`, `--max-turns`,
   `--allowedTools mcp__nordle Read Write Edit Glob Grep Agent Task Bash(node:*)`, `NORDLE_AGENT_RUN=1`, `windowsHide`, piped stdio;
3. waits (25 minute timeout; on Windows the whole process tree is stopped by PID with `taskkill /t /f`, never by name);
4. checks the outcome: the item must be `built` and point at a document (if Claude wrote `docs/<item id>.json` but forgot to link it, the runner
   links it), and `tools/validate.mjs <doc> --assets` must pass. Anything else puts the item back (`approved`, or `changes`), records the
   reason in `item.run.lastError`, and counts an attempt. After `maxBuildAttempts` (3) it stops trying and shows `gave-up`;
   `calendar retry` (or the owner editing the item) starts again.

`runPropose` (with `autoPropose` on, or `--propose --yes`) asks Claude for ideas for the months in the horizon that are short of their
quota, at most once every 20 hours, with only read tools and the Nordle tools. The ideas arrive as `idea` (or `approved` if delegated).

**What this does not guarantee.** The refusal of owner-only steps inside a headless run is an environment check in the command line plus
the token check on the server; a Claude run that is allowed `Bash(node:*)` could still edit `calendar.json` as a file. Treat the runner as
"Claude working under the owner's account", reviewed by sign-off, and keep `autoBuild` off for projects you do not want built unattended.
The `claude` flags used are listed by `calendar run --dry-run` (the exact command, nothing started); adjust with `NORDLE_CLAUDE_BIN`
(path to the binary), `NORDLE_CLAUDE_ARGS` (extra flags) and `NORDLE_CLAUDE_TOOLS` (comma list replacing the allowed tools).
They were written against Claude Code's documented headless options and have not yet been exercised against the real binary by the
test suite (it only ever runs a fake).

### Running it every day

`calendar schedule-install` **prints** the Task Scheduler (`schtasks`, with `conhost.exe --headless` so no console window appears) and cron
lines for `node nordle.mjs calendar run --all`. It registers nothing; paste the line yourself, remove it with `schtasks /Delete`.

## The prompts

`calendar prompt` (and `nordle_calendar_prompt`, and `GET .../calendar/prompt`) compose, from the project's own files each time:

* **propose**: the brand's audience and voice, facts, the quota and what is missing per month, pillars with target counts, open slots,
  the occasions in range (with confidence and VERIFY marks), everything posted or planned in the last 90 days, what a good idea is, the
  rules. Claude answers with `nordle_calendar_propose`.
* **build** (and revise): the brief, what to read, the exact toolchain for the format (`nordle build` with a spec for carousels and
  posts; the installed video tools for reels), the designer self-check against the checks this kind of post requires, the independent
  reviewer step (a fresh subagent that records its own checks), the content rules, and how to finish.

An in-editor "Design it" button and the scheduler use the same text.

## The API (for the Studio)

`GET /api/projects/<p>/calendar` returns the calendar, each month against its quota, the occasions in range, the lint per open item, what is due and
whether a run is going. The JSON shapes of every route are documented at the top of `src/server/routes/calendar.mjs`. Writes: `POST .../propose`,
`POST .../items`, `PATCH|POST .../items/<id>`, `POST .../items/<id>/approve|unapprove|reject|signoff|changes|posted|retry` (owner), `POST .../items/<id>/link`,
`POST .../approve-all` (owner), `POST .../settings` (owner). The server's method filter currently passes only GET, HEAD, POST and DELETE, so
use `POST .../items/<id>` for edits until PATCH is allowed through.

## Claude's tools

`nordle_calendar_get`, `nordle_calendar_propose`, `nordle_calendar_update`, `nordle_calendar_due`, `nordle_calendar_prompt`,
`nordle_calendar_link`, `nordle_calendar_slots`. There is deliberately no tool to approve, reject, sign off or change settings.

## Testing without Claude

`tests/calendar.test.mjs` and `tests/calendar-routes.test.mjs` cover the library, quotas, slots, lint, prompts, the service rules, the runner with a fake
`claude` (success, failure, timeout, lock, stale lock, crashed run, validation failure, revise, dry run, missing binary), the command line and the
HTTP and MCP surfaces including everything the agent token must not be able to do. The tests set `NORDLE_CLAUDE_BIN` to a path that does not exist, so a
bug cannot start the real Claude.

## Waiting in line while Claude is busy

Nothing is refused because Claude is already working. **Build it now** and **Ask Claude now** join a line for the brand (`src/calendar/jobs.mjs`: one at a time, up to 20, the same request is never queued twice) and start by themselves; if another run holds the brand (a revision, another process) they wait and try again (`retryWhileLocked`). **Request changes** on a post that is being built is kept as `pendingChanges` on the item; when the build is linked (`linkDoc`) the post goes straight to `changes` with those notes and the Studio starts the designer on it (`reviser.sweep`, run after every Studio-started build and every 20 seconds). The post says "In line" and "N changes are queued". There is no Undo for a queued change.

## How a reel is made (`reel`) and extra information (`guidance`)

Two optional fields on a calendar item, both checked by the calendar service and written into the build prompt:

- `reel` (reels only): `{ style, uses, seconds }`. `style` is `auto` (Claude chooses from what the project really has: footage that fits, motion graphics when there is none or animated type tells the idea better, a voice-over only when there is a recording with word timings), `footage`, `motion` (motion graphics only, no footage) or `voiceover` (motion graphics timed to the owner's recording). `uses` is any of footage, photos, stock, voiceover, music, sfx, captions, logo, endcard (a style drops what it cannot use, e.g. a motion-graphics reel has no footage). `seconds` is about how long (5 to 90).
- `guidance` (any format, up to 2000 characters): extra information from the owner to steer the post: who to feature, what to stress, what to avoid. The build prompt tells Claude to follow it.

Set them in the Create page (Reels row and the extra-info box; they go on every post added), in **Edit** on a post, through `nordle_calendar_propose` / `nordle_calendar_update`, or `--reel-style` / `--reel-seconds` on the command line. The words and checks are in `src/shared/reel-options.mjs`. Tests: `tests/reel-options.test.mjs`, `tests/reel-voiceover.test.mjs`.

## The Create page (Make posts)

**Simple and Advanced.** The page opens in **Simple** mode (`app/studio-create-simple.js`), three steps shown across the top:

1. **Say what you want**: one sentence, plus what kind (or let Nordle choose) and how many. The sentence is read the way a person means it ("three reels introducing the team" sets three, reels and the team style: `readAsk`).
2. **Pick from the board**: every idea is drawn as a strip of frames in the brand's colours (a reel's hook, shots with rough seconds and end card; a carousel's cover, slides and last slide: `framesFor`), so it can be judged before anything is built. **Keep** it, ask for **Another like this** (a different idea of the same kind, from spares fetched with the first ones), or pin a **Note for Claude** on it (it becomes that post's `guidance`). **Show me ideas** is free and instant (from the brand's facts, occasions and mix); **Let Claude write them** has Claude write them from the exact words (it uses the owner's Claude usage) and puts them on the same board.
3. **Claude makes them**: **Make them now** puts them on the calendar approved and in the build queue, one at a time, and the page follows their progress; **Save for later** keeps them as ideas in the Plan.

**Advanced** keeps every control described below (campaigns, months, styles, reel options, learning from results, your own videos). The choice is remembered in the browser, and an address can ask for one (`#/s/create?mode=advanced`). Tests: `tests/create-simple.test.mjs`.

The Studio's **Create** view (press `n`) is the quick way to fill the calendar. It has two ways in:

1. **Tell Claude what you want**: a box for a few words ("three reels about the team, one carousel on what to expect at a first visit"). *Copy this for Claude*
   copies a ready request (the same planning prompt Claude always gets, plus your words and the options below) to paste into Claude Code.
2. **Choose, and Nordle suggests**: the month, **how many** (or *Decide for me*, which fills what the month is still missing), the **kinds** (reels, carousels,
   posts, stories, or *a mix for me*), the **style** (meet the team, explain something, answer a question, behind the scenes, seasons and occasions, community,
   a gentle invitation), and **Learn from my results**.

*Show me options* returns cards, each with a date, a kind, a title, a one-line idea and why it was suggested. They are built from the brand's own
facts (its team and services become "Meet Ana" and "Sourdough classes: what to expect"; nothing is invented), the occasions worth a post in that month, and the
month's missing mix. Tick the ones you like, then **Add to the calendar** (approved: Claude builds each one as its date gets close) or **Add as ideas to look at**
(they wait in the Plan). If Nordle can only make some of the options you asked for it says so, and *Ask Claude to improve these* hands the rest to Claude.

**Learning from results.** Once results are connected (see PERFORMANCE.md) and at least 5 posts are measured, the options lean toward what did well on
*this account's own history*: the format that engaged the biggest share of the people it reached (about a fifth of the month moves to it), and the themes and openings that scored best
against posts of their own kind. It is a lean, never proof of cause, and a choice you make always wins. The route is `GET /calendar/suggest` and the engine is
`src/calendar/suggest.mjs`.

## Starting Claude from the Studio, and seeing it work

You do not have to paste a prompt into Claude. Nordle can start Claude itself, on this computer, under your sign-in (sign in once with the **Sign in to Claude** button; the Studio says so
if it is signed out):

- **Ask Claude now** (Create page): writes ideas for the month you chose, using what you asked for. They arrive in the Plan as ideas for you to approve.
- **Build it now** (an approved post's panel): builds that post straight away, even if its day has not come. Otherwise Claude builds each approved post when its date
  gets within the lead time (`autoBuild` on), or when you ask it to.
- **Request changes** already works this way.

While Claude works, the Studio says so: a line at the top ("Claude is building *Title* · 3 min"), a pulsing mark on the post, and in the post's panel what is happening
and since when ("Claude is building this post now · started 3 min ago · try 2 of 3"). A queued post says when it starts ("about 6 Dec, 14 days before it goes out") and, once its day
has come, whether it is waiting its turn. A post marked as being built with nothing running says so, and can be started again. One Claude job runs at a time in a brand.
The routes are `POST /calendar/run` (owner only) and `GET /calendar/run-status`; the work is `runPropose` and `runDue` in `src/calendar/run.mjs`.

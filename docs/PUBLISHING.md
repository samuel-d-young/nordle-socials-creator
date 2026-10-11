# Publishing: hand signed-off posts to an export folder or to Buffer

The owner picks posts (or a month), looks at a **plan** (what goes out, to which channels, when, and what blocks it), and runs it. Two
adapters ship: `bundle` (writes an export folder; nothing leaves the computer) and `buffer` (schedules in Buffer through its public
API). Claude can look at adapters and plans; **only the owner schedules**, in the Studio or on the command line.

```
signed-off ──owner makes a plan──> plan (15 minutes, bound to what it saw) ──owner runs it──> scheduled (calendar item.publish) ──> posted
                                     one line per post per channel                           only when EVERY channel has gone
```

**Words.** An **account** is a login: one Buffer API key. A **channel** is one place inside an account: an Instagram profile, a Facebook
page. A **brand** (a Nordle project) picks the account it publishes through and the channels it posts to, so one brand can post to an
Instagram profile and four Facebook pages, and a second brand can use a different Buffer account altogether.

## Safety rules (enforced in code, tested in `tests/publish.test.mjs`)

* **Only the owner runs, saves settings or tests a connection.** The agent token gets 403 on `run`, `settings` and `test`; the library
  refuses a non-owner role too; the command line refuses `run` and `settings` when `NORDLE_AGENT_RUN=1` (set inside Claude's headless
  runs), and `run` also needs `--yes`. Claude's tools are `nordle_publish_adapters` and `nordle_publish_plan` only. Claude's token never
  makes Nordle call Buffer: it sees the channel lists the owner's last look or test saved.
* **Only signed-off posts go.** A post that is merely `built`, or was edited after sign-off, goes only with the owner's per-post
  override (`override: {uid: true}`), and **never** when its checks are failing, it has no caption, a page or the video is not rendered,
  its time has passed, it is rejected, sent back for changes, already scheduled or already posted. Those come back as **blockers**.
* **A plan is bound to what it saw.** It lasts 15 minutes and records, per post and channel, the document version and file hash, the
  caption and alt text, the hash of every picture, the calendar slot, the channel's settings and the brand's account. The run re-reads all of
  it and refuses any item that has moved ("changed after the plan was made"), and re-checks every blocker. A plan made by Claude's token
  cannot be run by anyone.
* **No double sends.** One plan never hands a post to a channel twice. If Buffer's answer was unclear (no answer, a reply that is neither a
  post nor an error) that channel is marked *uncertain* and is not retried: look in Buffer, then plan again. A rate limit stops the whole
  run; the remaining items are reported "Not attempted".
* **Several channels, partial success.** A post becomes calendar status `scheduled` only when every channel chosen for it has gone. Until
  then it keeps its status and `item.publish.targets` lists each channel (`{channel, ok, scheduledAt, remoteId, message?}`), so the owner
  sees what went and what failed. A later plan shows the finished channels as "Already scheduled on ..." and sends only the failed ones; a
  success is never overwritten by a failure.
* **Every attempt is logged** to `<project>/publish/log.jsonl` (when, adapter, account id, channel, plan, post, ok, message, remote id,
  override). Tokens are never in a log line, a result, a plan or an API reply.
* **Keys** live in `<repo>/.nordle/publish.json` (gitignored; mode 0600 where the OS has modes), one per account. They are never returned:
  the API shows only `configured: true`, the account's label and when it was last tested. The Buffer API address is a code option, not a
  setting, so a saved key can only go to `https://api.buffer.com`; each brand's posts use only the key of the account that brand picked.
  *Honest limit:* the file is not encrypted, and on Windows `chmod` does nothing; any process (or Claude session) running as you with
  file access could read it, exactly like `.nordle/runtime.json`. Use Buffer keys you can revoke, and revoke one if in doubt.
* **Times** come from the calendar item's date and time in the project's timezone (`calendar.json` `timezone`, else `nordle.project.json`,
  else Australia/Melbourne), converted with daylight saving. No time on the item: the calendar's first `postTimes` entry (default 12:00).
  Each channel adds its own `offsetMinutes` (stagger the pages so they do not all post in the same minute). A per-run override:
  `times: {uid: "2026-11-12 18:30"}` (the brand's own clock, or a full ISO time with Z or an offset) replaces the base time; the offsets still
  apply. A time less than 10 minutes ahead is a blocker. `times: {uid: "now"}` means as soon as the service will take it: 11 minutes ahead on
  a whole minute, worked out again when the plan runs (Buffer is not asked for "share now", only for the earliest scheduled time). The Studio's
  Schedule dialog offers it per post ("As soon as possible", "At a different time…"); neither changes the calendar. The dialog also has
  "Re-run the checks", which runs the automatic checks again on every post in it (`POST /api/projects/<project>/checks/<doc>`) and makes the plan again.

## Setting up: accounts, brands, channels

`<repo>/.nordle/publish.json`:

```
accounts: { "<accountId>": { adapter: "buffer", label, token, organizationId?, lastTestedAt?, lastTestOk?, channelCache } }
brands:   { "<project>":    { account: "<accountId>"|null, channels: [ {id, name?, service?, formats?, enabled?, offsetMinutes?, hashtags?} ] } }
adapters: { "buffer":       { options: { mediaBaseUrl, schedulingType?, saveToDraft? } } }
```

* A channel entry: `formats` (default all four: `reel carousel post story`), `enabled` (default true; switch a page off without
  forgetting it), `offsetMinutes` (default 0, whole minutes, -1440..1440), `hashtags` (`keep`, the default, or `strip`: a Facebook page that
  wants none; the trailing block of hashtag lines is removed, hashtags inside a sentence stay). A bare id string still means one enabled
  channel. At most 12 channels per brand.
* **A channel belongs to one brand** (per account): saving the same channel under a second brand is refused with a plain message.
* The old single-key file (`adapters.buffer.token`, `adapters.buffer.channels`) is read as account `default` and rewritten in the new layout
  on the next save. With only one account, every brand uses it without picking. With several, a brand must pick (`useAccount`); until it does
  its plan says "Connect a Buffer account for <brand>" (a blocker, not an error).
* Changing the account a brand uses clears the brand's channels (they belonged to the other account) unless new ones are sent too.
  Removing an account is refused while a brand still uses it.
* **Channel lists** are loaded live for the owner's token (organisations, then their channels) and kept 10 minutes per account; if Buffer
  cannot be reached the last saved list is shown with an `error`. One API key lists every channel in its Buffer organisation(s), so one key
  is enough for a brand with one Instagram profile and four Facebook pages; use a separate account (key) when brands live in different
  Buffer logins. `organizationId` (per account) narrows a key that sees several organisations.

### Connecting Buffer (the owner's steps)

1. In Buffer open **Settings > API** (https://publish.buffer.com/settings/api) and create an API key. Copy it. (For a second Buffer login,
   repeat in that login.)
2. Decide where the pictures will be hosted (any static host or bucket that serves public HTTPS URLs) and the web address of its folder.
3. Save the account, the address and test, in the Studio's publishing settings, or:
   `echo YOUR_KEY | node nordle.mjs publish settings buffer --account gannet --label "Little Gannet Buffer" --token-stdin --media-base-url https://media.example.com/nordle --test`
   (`--account` is the short id, `--label` the name you will see; leave `--account` out for the single account `default`.)
4. Say which account a brand uses and which channels it posts to (the test lists the channel ids):
   `node nordle.mjs publish settings buffer --brand gannet --use-account gannet --channel gannet=<instagram id> --channel gannet=<page id>,hashtags=strip,offset=10`
   (per channel: `formats=reel+post`, `offset=15`, `hashtags=strip`, `enabled=off`, `name=..`; `--channel gannet=none` removes them all).
5. Pick posts: `node nordle.mjs publish plan buffer --project gannet --month 2026-11` (or select posts in the Studio), read the blockers,
   export and host the folder (`publish run bundle ...` writes it; the Buffer run also writes it), then `node nordle.mjs publish run <planId> --yes`.
   Plans last 15 minutes. `publish adapters` shows every account, brand and channel.

In the Studio, adding an account checks the key straight away, shows a green "connected" note at the top of the window (and a notice for
when the window is closed), highlights the new row, and loads its channels. When the account's name, or the name of one of its channels,
carries a brand's name (account "Little Gannet" and brand "Little Gannet Coffee"; channel "Little Gannet Socials" and brand "Little Gannet"),
the brand takes that account and ticks the channels that carry its name. Nothing is guessed when no name fits: the note says to choose a brand.
Only Nordle's own settings change; nothing is sent to Buffer. A brand with no account says "Choose an account", not "no account".

## Adapters

```
{ id, name, marksScheduled, needsAccount?, needsChannel?, accountName?,
  describe({accounts, brands, options}) -> { configured, needs:[text], channels:[{id,name,service}], note }   no network
  async listChannels(settings)  -> [{id,name,service,...}]                                                   network
  async plan?(post, {settings}) -> { blockers:[{code,message}], warnings:[text] }                            no network
  async schedule(post, {channel, when}, settings, {firstOfPost, probeCache}) -> { remoteId, scheduledAt, message? }   network; throws PublishError
  async check(settings)         -> { ok, message }                                                           network
  async finalize?(batch, {planId}) }                                                                         after the run
```

`settings` is what one brand needs: `{account:{id,label}|null, token, organizationId, options, channelCache (that account's), channels (the brand's)}`.
`post` is `{ uid, project, projectDir, docId, title, format, date, time, timezone, when (UTC ISO, this channel's), caption (this channel's),
captionFull, media:[{kind:'image'|'video'|'cover', rel, abs, file, page, alt}], channel:{id,name,service}|null }`. Register another adapter in
`src/publish/index.mjs` (`adapters()`); tests inject a fake with `configure({buffer:{fetch, apiUrl, allowHttpMedia}})`.

### `bundle` (always works)

Writes `<project>/out/publish/<date>-<doc id>/`: the pictures in posting order (`01-cover.png`, `02-...`) or the video and its cover
(`<doc>.mp4`, `<doc>-cover.jpg`), `caption.txt` (caption + hashtags), `alt.txt`. When the brand has channels set up it also writes a
sub-folder per channel (`<channel id>/caption.txt` with that channel's own caption, `channel.txt` with its name and time), without copying
the pictures again, and one `schedule-<plan>.csv` per project with a row per post and channel (date, time, timezone, UTC time, format,
title, files, caption start, channel, channel name, service). Files are copied (not linked), so an export uses disk: delete `out/publish`
when done. Exporting again replaces the folder. It does **not** mark calendar items `scheduled`: nothing was handed to a service, so the
owner marks them `posted` themselves.

### `buffer`

Schedules each post, once per channel, with `createPost` (`mode: customScheduled`, `dueAt` in UTC, `schedulingType: automatic`), text =
that channel's caption, `assets` = the pictures in order (carousel) or the video (reel), and for an Instagram channel
`metadata.instagram {type: post|reel, shouldShareToFeed: true}`. A Facebook channel gets `metadata.facebook {type: post|reel}` (Buffer refused a
Facebook post without a type: "Facebook posts require a type (post, story, or reel)"; a reel is sent as `reel`, everything else as `post`). Each file's address is checked
once per run, however many channels use it.

**Media hosting (the easy way).** In the Studio, Publishing > "Where your pictures and video go", give Nordle an S3-compatible bucket of yours
(Cloudflare R2, Amazon S3, Backblaze B2, Wasabi) and its public address. When you press Schedule, Nordle writes the post's export folder, then
puts its pictures or video in the bucket at `<project>/<date>-<doc>/<file>` (a file already there with the same size is kept) and hands Buffer
`<public address>/<project>/<date>-<doc>/<file>`. Nothing is uploaded until you schedule, only for the posts in that run, and only to your
bucket. The keys are saved in the private settings file and never shown again; "Test it" puts a small file in and reads it back from the
public address, the way Buffer will. The bucket must allow public reads (R2: turn on the "Public Development URL"). Requests are signed with
AWS Signature V4 (checked against Amazon's published example in `tests/hosting.test.mjs`); the code is `src/publish/hosting.mjs`.

**Without hosting: Buffer takes media only as public HTTPS addresses (no upload endpoint).** So the adapter points Buffer at the export folder: set the
**media web address** (`options.mediaBaseUrl`) and host the contents of each project's `out/publish/` at `<mediaBaseUrl>/<project id>/`. A
picture's address is `<mediaBaseUrl>/<project>/<date>-<doc>/<file>`. Before it asks Buffer, Nordle exports the folder, then checks every
address (HEAD, no redirects, an image or video content type); a file that does not answer stops that post with the address and what to do.
Buffer fetches the file at publishing time, maybe days later, so it must stay up until the post is out. Nordle does not upload for you, and a
tunnel option does not exist yet. Pictures are public (unlisted) from the moment you host them: host only what you are happy to have reachable.

Options (`options`, or `mediaBaseUrl` at the top level of a settings call): `mediaBaseUrl` (https), `schedulingType` (`automatic` or
`notification`), `saveToDraft` (send posts to Buffer as drafts instead, a gentler first try; *combination with `customScheduled` is
unverified*). Limits in Nordle: only Instagram and Facebook channels are sent (any other service is blocked, not guessed); **stories** are
blocked for Buffer (use the export folder); a reel's cover image is not sent (Buffer only takes a frame time, so choose the cover in Buffer);
Instagram captions over 2196 characters (a line break counts as 2) and carousels over 20 pictures are blockers.

### Buffer's hosted MCP server (not used by Nordle)

The owner may also have added Buffer's hosted MCP server (https://mcp.buffer.com/mcp, signed in with OAuth from a terminal Claude Code through `/mcp`)
to Claude Code. **Nothing here uses it, and nothing in this page has been checked against it.** What it might do for Nordle later (all
unverified): let a Claude session read the owner's Buffer queue and channels, or create posts, without an API key on disk, so a key file
(`publish.json`) might become unnecessary for the owner's own Claude sessions. It could also make an agent able to schedule posts around
Nordle's rules: if it is ever connected, the "only the owner schedules" guarantee needs a second look, because Nordle cannot police what
another MCP server lets Claude do. The API-key route above is the tested one and stays the supported route.

## Choices in the Schedule window (all owner-only, none change the calendar)

* **When.** Per post: its planned time, "As soon as possible" (`times: {uid: "now"}`: 11 minutes ahead, because Buffer is asked for the
  earliest scheduled time, not "share now"), the brand's **Best** times (from the history below), ready-made evening and morning times, or any
  day and time. "Same for all posts" copies the choice.
* **Also add to Stories** (`stories: [uid]` on the plan). For each Instagram and Facebook channel a second item (`<uid>#<channel>#story`,
  `variant: "story"`) goes at the same moment: a reel's video, else the first picture, no words, `metadata.instagram {type: story,
  shouldShareToFeed: false}` / `metadata.facebook {type: story}`. Its calendar target is `<channel>#story`, and a post counts as scheduled
  only when the Stories went too. First live Story send is unverified: read its result line.
* **Cover of a reel.** Buffer takes `video.metadata.thumbnailOffset` (milliseconds into the video; read from Buffer's own schema, also
  `video.thumbnailUrl`, unused). The owner chooses a frame (the player's "Use this frame as the cover", "Suggest covers…", or "Choose…" in
  this window: `src/video/cover-pick.mjs` ranks sampled frames by sharpness, detail near the middle, contrast, exposure and steadiness, and
  keeps clear of the opening instant and the closing card). Kept in `<project>/publish/covers.json` (`auto: true` when Nordle picked it), not
  in the post's document, so a sign-off stays good. Order of precedence: the owner's choice, the designer's `timeline.cover`, else the best
  frame is picked automatically when the plan runs. `POST /api/studio/cover {uid, time | auto:true}`, `GET /api/studio/cover-candidates`.
* **Re-run the checks** runs the automatic checks again on every post in the window (`POST /api/projects/<project>/checks/<doc>`).
* **Reschedule what was deleted in Buffer.** `POST /api/publish/check-scheduled {uids}` lists Buffer's posts for the channels (one listing per
  organisation, from a day before the earliest scheduled time) and reports each target as Buffer's own status or `missing`. A target is
  `missing` only when the listing was read to the end. `POST /api/publish/unschedule {uid, channels?}` forgets those targets and puts the post
  back to `signed-off` (the others stay remembered as done), and the audit log says so. The post's sheet has "Check in Buffer" and
  "Reschedule…"; the window has "Check what is still in Buffer" and "Reschedule all".

## When to post, and Buffer's request allowance

* Buffer's request allowance (per key): 100 per 15 minutes, 250 per day, 7,500 per 30 days on the owner's plan; every request costs one.
  Every answer carries it in the `RateLimit` header, which Nordle remembers per account (`<runtime>/allowance.json`) and shows. **Optional
  reading keeps a reserve**: history and "is it still there?" refuse when fewer than 40 requests are left for the day or 8 for the next 15
  minutes. Scheduling is never blocked by the reserve. The Schedule window says how many requests a run will use.
* **History** (`POST /api/publish/sync-posts {project}`, CLI `publish sync-posts <project>`): `posts(status: sent)` with results
  (`metrics { type value unit }`), 100 per request, first 180 days then only from three days before the newest post we hold. A pull is not
  repeated within 6 hours unless forced. Kept in `<project>/performance/buffer-posts.json`.
* **Analysis** (`src/performance/best-time.mjs`, `GET /api/publish/best-times?project=`, CLI `publish best-times <project>`, Studio Insights >
  "When to post"; reads local files only, costs Buffer nothing): each post is scored against its own channel's usual result (reach or
  impressions or views, and engagement rate), grouped by weekday, hour and both, with a bootstrap range and the number of posts, and labelled
  clearly better / about usual / clearly worse / too few. It only knows the times that have been used. Slots before 6 am are suggested only on clear
  evidence, and a guess (best day and best hour put together) is labelled as one.

## Automatic scheduling (the owner's standing instruction)

"If a post has been approved and its date is a week away, put it in Buffer." `src/publish/auto.mjs`, switch in the Publishing window (Connect
Buffer) or `POST /api/publish/auto-schedule`. **Off until the owner turns it on, and only the owner's token can** (Claude's cannot, and cannot call
`now` either). Settings: `enabled`, `daysAhead` (1 to 30, default 7), `stories` (also make a Story of each, default on).

* It does what the Schedule button does, with the same plan, checks and audit log (lines carry `via: "auto"`), as the owner. A pass looks at every
  calendar item that is **signed off**, has nothing handed over yet, and whose own planned slot is more than 20 minutes away and no further than
  `daysAhead`. Posts whose slot has passed or is too close are left for the owner (no "as soon as possible" is ever guessed); posts that are not
  ready (a failing check, missing pictures, no account) are left alone with the reason, which the Studio shows under the post.
* It looks every 15 minutes, and straight after the owner approves something or switches it on ("Look now" in the window does it on demand). At most 8
  posts a pass. A blocked post is not looked at again for 3 hours; a failed one waits 6 hours times its tries and stops after three failures until the
  owner looks. A rate-limit answer pauses it for an hour, and it does not start when the day's allowance is known to be nearly used.
* Under an approved post the sheet says when it will go ("Goes to Buffer by itself on Thu 5 Nov, 7 days before"), or why it could not, or offers to
  turn the switch on. Nothing goes live from here: Buffer posts it at its time, and "Check in Buffer" / unschedule work as before.

## API (what the Studio codes against)

All under `/api/publish`. Errors are `{ok:false, errors:[{path,message}]}`.

| call | who | reply |
|---|---|---|
| `GET /adapters` | anyone (the owner's token also asks the adapter for fresh channel lists, cached 10 minutes) | `{adapters:[{id,name,configured,needs,note,channels:[{id,name,service}],accounts:[{id,label,configured,lastTestedAt,lastTestOk?,channels:[{id,name,service}],error?}],brands:{<project>:{account,channels:[{id,name,service,formats,enabled,offsetMinutes,hashtags}]}},selected,options}]}` |
| `GET /describe?adapter=` | anyone | one of those |
| `POST /plan {adapter, uids:[...]}` or `{adapter, project?, month:'2026-11'}` (+ `times?`, `channels?:{<uid>:[channelId]}`) | anyone (a plan made by the agent cannot be run) | `{planId, adapter, expires, items:[{uid,key,project,docId,title,when,whenLocal,channel:{id,name,service}\|null,channelName,account,accountLabel,caption,media,blockers,blockerCodes,warnings,ready,overridable,format,status,adapter}], summary:{ready,blocked}}` |
| `POST /run {planId, only?, override?, times?}` | **owner** | `{results:[{uid,key,channel,ok,message,scheduledAt,remoteId}], posts:[{uid,status,done,total}], stopped?, warnings?}` |
| `POST /settings {adapter, account?, label?, token?, organizationId?, remove?, brand?, useAccount?, channels?, mediaBaseUrl?, options?}` | **owner** | `{ok, configured, accounts:[{id,label,configured,lastTestedAt}], brands, cleared?}` (`token: null` clears a key) |
| `POST /test {adapter, account?}` | **owner** | `{ok, message, account?, channels?}`; remembers the channels it sees and when it asked |

`uid` is `<project>:<calendar item id>` as in `/api/studio`. A plan has **one item per post per channel**; `key` is `<uid>#<channelId>` (just the
uid when there is no channel) and `only`/`override` accept either a uid (all its channels) or a key. `when` is UTC ISO (the calendar time plus
the channel's offset); `whenLocal` is the brand's clock. A brand with no account or no channel gets **one blocked item** with `channel: null`
whose blocker says what to connect (`blockerCodes`: `no-account`, `no-key`, `no-channel`, `no-target`, `past`, `not-signed-off`, ...). `posts[].status`
is `scheduled`, `exported` (bundle), `partial` or `failed`. Month plans include everything on the calendar that month except ideas and rejected
items, so blockers explain what is missing. At most 100 posts and 400 items per plan.

## What is verified, and what is not

Verified by tests (`tests/publish.test.mjs`, 33 tests): planning and every blocker, several channels per brand (formats, offsets, hashtag
stripping, switched-off channels, per-run channel selection), two Buffer accounts with separate keys (each brand's posts go out under its own key;
a channel of the other account is not accepted), partial success and a retry that sends only the failed channel, the export folder's content,
the exact request the Buffer adapter sends, per-post failures, the rate limit (HTTP 429 with Retry-After, and `RATE_LIMIT_EXCEEDED` in `errors`),
an unreachable file, a refused key, an unreachable service, plan expiry, staleness, who may do what (HTTP, library, command line), keys never
appearing anywhere, the old one-key settings file, and the calendar transitions. The Buffer tests talk to a **fake Buffer** (an in-process fake
`fetch` that knows two logins, plus one smoke test over a real loopback socket). **Nothing has ever been sent to the real Buffer** and no real
key has been used.

Taken from Buffer's documentation (read-only research, October 2026), not exercised against the live service:

* Endpoint `https://api.buffer.com` (GraphQL), `Authorization: Bearer <API key>`; key from Settings > API; OAuth 2.0 also exists (scopes
  `posts:write`, `account:read`, ...; access tokens last an hour): Nordle uses the API key only. (getting-started.md, authentication.md)
* Organisations: `account { organizations { id name } }`; channels: `channels(input:{organizationId}) { id name service ... }`; the Channel type has
  `isDisconnected` and `isLocked`. (examples/get-organizations.md, get-channels.md, reference.md)
* `createPost(input)` with `text`, `channelId`, `schedulingType` (`automatic`|`notification`), `mode` (`addToQueue`|`shareNext`|`shareNow`|
  `customScheduled`), `dueAt` (ISO 8601 UTC), `assets`, `metadata`, `saveToDraft`; the result is `PostActionSuccess {post}` or `MutationError {message}`.
  (guides/posts-and-scheduling.md, your-first-post.md, reference.md)
* **No upload endpoint**: assets are `{image:{url}}` / `{video:{url}}` with public, direct, HTTPS, stable URLs that Buffer fetches when the post goes
  out; several images in the array make a multi-image post; `image.metadata.altText`; Instagram `metadata:{instagram:{type: post, shouldShareToFeed}}`;
  video thumbnail by `metadata.thumbnailOffset` (milliseconds). (guides/hosting-media.md, examples/create-image-post.md, create-video-post.md,
  create-instagram-post-with-user-tags.md)
* GraphQL answers HTTP 200 for most errors (`errors[].extensions.code`: UNAUTHORIZED, FORBIDDEN, NOT_FOUND, UNEXPECTED, RATE_LIMIT_EXCEEDED);
  the rate limit is a real 429 with `Retry-After`. Limits per API key: 100 requests / 15 minutes on every plan, 250 / 24 hours (Free and Essentials)
  or 500 (Team), 3,000 / 30 days (Free), 7,500 (Essentials), 15,000 (Team). A month for a brand with five channels is about 65 `createPost` calls,
  so plan a month at a time and expect the 15-minute window to matter on a Free key. (guides/error-handling.md, api-limits.md)
* Instagram text limit 2,196 characters with a line break counting as 2. (guides/character-limits.md)

**NOT verified** (the adapter is written to fail with a clear message if any of these is wrong):

1. That the live API accepts our exact documents. The mutation uses variables (`$input: CreatePostInput!`); the type name comes from the reference
   page, the docs' examples inline their values.
2. `type: reel` for Reels (only `post` appears in the examples I could read), and what `shouldShareToFeed` does for reels and carousels.
   `type: story` is unverified, so stories are blocked rather than guessed.
3. That a carousel is accepted as several `image` assets in one call for Instagram, and Buffer's maximum number of pictures or file sizes (not stated;
   Nordle caps at 20).
4. `image.metadata.altText` on its own (the example also has `userTags`).
5. Whether Buffer can set a reel cover from an image (only a frame time is documented), so the cover file is not sent.
6. `saveToDraft: true` together with `mode: customScheduled`, and `schedulingType: automatic` for personal (non-business) Instagram accounts.
7. Which hosts Buffer can fetch from (some file-sharing links are previews, not files; Nordle rejects redirects and non-image/video types, which
   Buffer may or may not need), and any minimum lead time for `dueAt` (Nordle requires 10 minutes).
8. The `RateLimit` / `RateLimit-Policy` response headers are not parsed (only 429, Retry-After and RATE_LIMIT_EXCEEDED are used).
9. Pagination of channels (a very large account may need more than one page; only the first page is read).
10. **Facebook pages**: `metadata.facebook.type` (`post` or `reel`) is required by Buffer (found when the first live post was refused). Whether
    Facebook then publishes a vertical video as a Reel is checked by Buffer at publishing time (the plan says so). Facebook's own caption limit
    is not enforced.
11. **That one key lists every channel in its organisation** (taken from the docs' `channels(input:{organizationId})`), and that `organizationId` is
    needed only when a key sees several organisations. Two separate Buffer logins are modelled as two accounts with two keys; this has only been
    exercised against the fake, which gives each key its own organisation.
12. Whether Buffer rejects a channel that belongs to a different account's organisation with a clean `MutationError` (the fake does).

Also not done: other services' adapters, a channel on more than one brand, a tunnel for media, uploading media for you, and editing or deleting a
scheduled Buffer post from Nordle (do that in Buffer, then mark the item `posted` or reject it).

## Keeping Buffer in step with Nordle (`publish sync`, automatic)

Nordle is the truth. `node nordle.mjs publish sync <project> [--yes] [--include-unknown] [--include-stale]` (owner only; without `--yes` it only shows the plan)
reads what Buffer still holds to post (scheduled, sending, draft, needs approval, error: one request per 100 posts) and compares it with the calendar:

| In Buffer | What Nordle does |
|---|---|
| a post whose id is recorded on a calendar item, at another time than Nordle's | **MOVE** it (the owner dragged the post to another day: same time of day on the new day) |
| a scheduled post with no record whose first 60 letters are a calendar item's caption, and the item is signed off or scheduled | **ADOPT** it: move it to the item's slot and record it on the item |
| the same, but the item is not signed off (built, changes, rejected, idea) | **DELETE** it |
| a scheduled post that matches nothing (made by hand in Buffer, a Story with no words) | left alone, listed (`--include-unknown` deletes them) |
| drafts, needs-approval and error posts | left alone, listed (`--include-stale` deletes them) |
| Nordle says scheduled for later, Buffer does not hold it | listed as MISSING (the Studio's "is it still there?" takes it back so it can be scheduled again) |

Buffer checks a whole post when it is edited, so a move reads the post first and sends it back as it is (words, pictures, type, a video's cover frame) with only the time
changed: two requests. A video's `thumbnailUrl` must NOT be sent (Buffer refuses it); the cover is `video.metadata.thumbnailOffset`. Deleting is `deletePost`, one request.
Every change is written to `publish/log.jsonl` (events `sync-move`, `sync-adopt`, `sync-delete`). A plan is good for 15 minutes; at most 60 changes per run.

**Automatic** (`src/publish/auto-sync.mjs`, started by `server.mjs`, on unless `settings.autoSync.enabled === false`): it watches the calendar files (free), and when a calendar has changed and
been quiet for a minute (and ten minutes have passed since its last run) it runs the same plan and applies it; otherwise it looks every six hours and once when the server starts.
It never touches the "left alone" rows. Tests: `tests/publish-sync.test.mjs` (a fake adapter; nothing real is contacted). Read-only audit script: `private/buffer-sync-audit.mjs`.

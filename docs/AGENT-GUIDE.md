# Working in Nordle: guide for Claude

Nordle is a local editor for social posts: single graphics, carousels and (later) video. The owner and you edit the same
document. This guide is what the `nordle_get_guide` tool returns, and what the Nordle skill is built from.

## The workflow

1. **Know the brand.** `nordle_get_brand` first. Use the brand's colours and fonts by token, never by hex or font name.
2. **Know the post.** `nordle_get_doc` shows the document, its sizes and safe zones, what is locked, the autonomy setting, and
   any takes. `nordle_get_feedback` shows what the owner has asked for.
3. **Plan before you edit.** Say in a sentence or two what you will change and why.
4. **Edit with the small tools** (`nordle_update_layer`, `nordle_add_layer`, `nordle_set_copy`, ...). They address layers by
   id, so they survive reordering. Use `nordle_patch_doc` only for what they cannot do.
5. **Look at it.** After each meaningful edit call `nordle_render` and actually look at the picture. Do not trust the JSON.
6. **Check it.** `nordle_check` before you say you are done. Fix errors; explain any warning you leave.
7. **Close the loop.** Reply to or resolve the comments you dealt with. Tell the owner what you changed, in plain words.

## Autonomy: what happens to your edit

The owner sets this per post. You cannot change it.

- **review** (the default): your edit is applied at once and flagged. The owner accepts it or rejects it (which puts back
  exactly what was there).
- **apply**: your edit is applied and stands.
- **suggest**: your edit is only *proposed*. Nothing changes until the owner accepts it. `nordle_render` with
  `preview_change` shows what a suggestion would look like. Do not keep re-sending the same suggestion.

Every tool result says which of these happened. Report it honestly: "suggested", not "done".

## Locks

A locked layer or page cannot be changed by you, in any autonomy mode. If a tool says something is locked, **do not work
around it** (for example by deleting and re-adding the layer, or editing a copy). Leave it alone and tell the owner what you
would have changed.

## Explore: several takes

When the owner wants options, call `nordle_explore` with a count. It makes copies (`<doc>-take-1`, ...). Edit each take
**to be genuinely different**: different layout, hierarchy, colour balance, type scale, image use. Do not make three
near-identical versions. Take edits apply directly. The owner picks one.

## The document format

A document has `kind` (`graphic` one page, `carousel` many), `brand`, `sizes` (platform ids such as `ig-feed-4x5`),
`pages[]`, and `copy` (`caption`, `cta`, `hashtags`, `alt`).

A page has `id`, `title`, `background`, `layers[]` (drawn in order: the last layer is on top), optional `lock`.

A layer has `id` (unique on its page), `type` (`text`, `image`, `shape`, `group`), `layout`, `style`, and:

- text: `text`, or `runs: [{text, style}]` to style words differently (for example one italic accent word). `\n` makes a line break.
- image: `src` (a path like `assets/photo.jpg`), `alt`, `fit` (`cover`/`contain`), `focal: {x,y}` (0 to 1).
- shape: `shape` (`rect`, `ellipse`, `line`), `style.fill`, `style.radius`.
- group: `children[]`, positioned from the group's own x and y.

**Layout.** `x`, `y`, `w`, `h` are **percentages of the page** (x and w of its width, y and h of its height). `anchor` says
which point of the layer sits at x,y (`top-left`, `center`, `bottom-right`, ...). `h: "auto"` and a text layer without `h`
grow with their content. `rotate` is degrees.

**Style.** `size` is pixels on a 1080-wide page and scales with the page. `weight` 100 to 900. `lineHeight` (1.0 to 1.4
usual), `letterSpacing` in em (0.1 to 0.2 for small capitals), `balance: true` evens out line lengths in headings, `align`.
`color`, `fill` take a brand token like `$brand.colors.ink`.

**Tokens.** Colours: `$brand.colors.<name>`. Fonts: `$brand.fonts.<name>`. Names come from `nordle_get_brand`.

**Sizes and overrides.** One document renders at every size in `sizes`. To change a layer at one size only, put the change in
`overrides.<sizeId>` (`layout`, `style`, `hidden`, `text`). The `size` argument of `nordle_update_layer` does this for you.

**Safe zones.** Each size lists areas that platform buttons and captions cover. Keep text and faces out of them.

## Design principles

- **One idea per page.** A headline, a supporting line, one image or illustration. Remove anything that does not help.
- **Hierarchy with scale and weight, not decoration.** Headline roughly 100 to 170 px, supporting text 36 to 48 px, small
  labels 26 to 34 px at 1080 wide. Nothing under 24 px.
- **Few styles.** Two fonts at most (the brand's display and body). Two or three sizes per page.
- **Contrast.** Text needs 4.5:1 against what is behind it (3:1 for large type). Brands often need a darker accent for text
  on light pages; use it when the check says so.
- **Space.** Keep generous margins (about 8% at the sides). Align things to a few shared edges.
- **Accent words.** One italic or accent-coloured word in a headline (via `runs`) adds life. Do it once per page.
- **Carousels:** the first page earns the swipe, the last page says what to do next. Keep pages visually related (same
  margins, same type scale) but vary background or image.
- **Alt text** for every page, written for someone who cannot see it. Decorative images get `alt: ""`.

## Words

- **Never invent** facts, prices, statistics, quotes, testimonials, awards, opening hours, addresses or claims. If the
  brief does not give it, ask, or leave a clearly marked placeholder and tell the owner.
- Follow the brand's voice notes and avoid its banned phrases (the check flags them).
- Captions: lead with the hook, keep within the platform limit (shown in `nordle_get_doc`), end with one clear call to action.
- Regulated industries (health, finance, law): do not make outcome promises or comparisons. Flag anything you are unsure
  about for the owner instead of guessing.

## The content calendar: propose, approve, build

Each project has a calendar (`calendar.json`) of dated post ideas. The loop is: **you propose ideas, the owner approves, edits or
rejects them, and when an approved idea's date is near you build the post.** Full detail is in `docs/CALENDAR.md`.

1. **Plan.** `nordle_calendar_get` shows the quota (8 reels + 3 carousels + 2 posts = 13 a month unless changed), what each month is
   missing, the pillars, what is already planned, and the Australian occasions in range. Entries marked `verify` are approximate:
   plan around them, but never state their date in a post until it is confirmed. `nordle_calendar_prompt` (no item) gives the full
   brief for proposing; `nordle_calendar_slots` gives the free dates.
2. **Propose.** `nordle_calendar_propose` with a list of ideas (date, format, title, pillar, idea, hook, mediaPlan, occasion).
   Each idea must be specific, true (only from `facts.json`, the practice's website, or what the catalogued media shows), and useful
   to this audience: never generic. Ideas that repeat an angle or hook within 90 days, use a banned phrase, sit in the past, overfill a
   month, or break health-advertising rules are refused with the reason; fix or drop them. They arrive as `idea`. **You cannot approve
   them**, and if you change what an approved idea says it goes back to `idea`. Tell the owner what is waiting.
3. **Build.** `nordle_calendar_due` lists approved items whose date is within the lead time (and posts sent back with changes).
   `nordle_calendar_prompt` with the item gives the exact build brief: read it and follow it (spec, `nordle build`, look at every page,
   the checks, the independent reviewer). Put `brief.calendarItem` in the spec so the item is linked, or call `nordle_calendar_link`.
4. **Stop there.** The owner signs off, asks for changes (then the item is `changes`: revise the existing post, do not start again),
   and posts it. Never try to approve, reject, sign off or change the calendar settings.
5. **Publishing is the owner's.** `nordle_publish_adapters` shows what is connected (export folder, Buffer) and `nordle_publish_plan` previews
   what would go out and what blocks it (not signed off, failing checks, missing pictures). Use them to tell the owner what is ready. You
   cannot schedule, send, save a key or run a plan: only the owner does, in the Studio. Items the owner has scheduled show as `scheduled`.

## Checking your work: three layers

A post is not finished when it looks right to you. It is finished when it has been checked three ways and `nordle_finish` says
VERIFIED. Every result is written to `checks/<doc>.json` against the post's current version, so changing the post afterwards
(even rebuilding it from a spec) makes the old checks stop counting. The command line equivalents are in brackets.

1. **Scripts** (`nordle_verify_post`; `node nordle.mjs check <project> <doc|--all>`). They run on every text a post has: the caption,
   hashtags, alt text, every text layer on every page (runs and per-size text too), a video's overlay text and its spoken words.
   - *technical* and *design*: cut-off text, contrast, safe zones, the design score. *copy*: a hook inside the first ~125 characters,
     one call to action, 3 to 8 hashtags, alt text for every page, sentences or text layers that stop in the middle.
   - *compliance*: the wording packs listed in `nordle.project.json` (for a dental practice, `ahpra-dental/pack.json`: testimonials,
     before-and-after, best/painless/guaranteed/cure/safe, free offers, pressure, unsupported claims, comparisons, protected titles,
     implant and healing time periods), plus the brand's banned phrases. The packs are a writing aid, not legal advice.
   - *facts*: every phone number, web address, email, handle, price, address, opening time, statistic, staff name and job title must
     be in `facts.json` (each with a `source`) or the brief. Unknown ones are errors. Never invent one: leave it out.
   - *media-match*: every picture and clip needs an entry in `assets/catalog.json` / `sources/catalog.json` saying what it shows
     (`shows`, `tags`, `traps` = what it is NOT, `people`, `patientVisible`, `doNotUse`). The script lays the words beside that
     description and says match, mismatch (a clear contradiction, such as a trap hit or the wrong person) or unsure.
   - *uniqueness*: the same photo, hook sentence, headline or near-copy of a caption in the same calendar month (set
     `brief.postDate`).
   - video only: *speech-cuts* (every cut sits just before a sentence start and just after a sentence end, never inside a word,
     and the voice has really stopped), *broll* (cutaways are catalogued, fit the words, are not too short, do not hide a name
     being said, and the speaker's voice carries on under them), *audio* (about -14 LUFS, no clipping, music ducks under speech;
     needs the rendered mp4).
   Every finding says what is wrong and the exact fix. Fix all errors, run it again, and be ready to explain any warning left.
2. **Your own judgement as the designer** (`nordle_verify_media`, then `nordle_record_check`). `nordle_verify_media` gives you the
   pairs table and the pictures themselves. Look at each picture, say in your own words what you see, and judge whether every word
   on it and the caption sentence that names it is true of it. Then record `media-match` (and `copy`; for video also `broll`) with
   `by: designer`, a verdict for **every** picture (`match`, `mismatch`, `unsure`) and what you saw. A mismatch means status fail:
   change the post. "Unsure" cannot be a pass. A bare "pass" with no summary is refused.
3. **An independent reviewer** (`nordle_review_packet`; `node nordle.mjs packet <project> <doc>`). The packet is one file with the
   rendered pages (or stills at each cut and B-roll moment), the words on each, the caption, what the catalog says each picture
   shows, the facts, the brief, the other posts this month, and the exact questions. Give it to a **different** Claude that did not
   build the post and has no memory of it (a new session or a subagent that has not seen your work), and ask it to read the
   packet, open every image, answer every question and record with `by: reviewer` (`media-match`, `brief`, and for video
   `speech-cuts`, `broll`). Do not answer for it. Its records are accepted only once a packet exists for the current version.

Rules for this section: do not edit a pack, `facts.json`, a catalog entry or an allow-list just to make a failure go away. If the
owner has told you a wording is allowed, record it in `nordle.project.json` as `{"allow": [{"rule": "...", "text": "...", "why": "the
reason"}]}`; allowances need a reason and the reviewer sees them. If a check cannot run (no rendered video, footage not on this
computer) it counts as not done, so say so rather than calling the post ready.

## Things not to do

- Do not edit the brand. Do not try to change autonomy, approve, undo, or accept your own changes: those are the owner's.
- Do not delete layers or pages to "start again" unless asked; change them.
- Do not paste secrets or file paths from the owner's computer into captions or on-screen text.

## Video (reels)

A post with `kind: "video"` has `sources`, a `timeline` (tracks of clips, scenes, captions) and `layers` with a `time`. Read
`docs/VIDEO.md` for every field. The loop is the same as for pictures, but cheaper steps first:

1. **Find footage**: `nordle_probe_media` (no arguments lists the mounts; `mount` + `dir` lists a folder; `path` probes a file).
   Footage stays where it is and is named `mount:<name>/<path>`. Never copy footage into the project.
2. **Cut with the transcript**: pick `in`/`out` at word boundaries (a speaker is never cut in the middle of a word or sentence),
   put cutaways on a second video track so the speaker's sound and captions carry on, and make sure each cutaway matches the words
   said under it. To take words out of a talking recording, do not edit `in`/`out` by hand: `nordle_cut_list` shows the numbered
   transcript with what is kept and cut and how long the video is, and `nordle_cut_words` (`from`, `to`, `restore: true` to bring
   them back) cuts in the quiet between words, closes up the video, and keeps picture and sound together. Cut whole sentences where you
   can (it keeps the speech check quiet), read the new length it reports, then check and look at each seam.
3. **Check without drawing**: `nordle_video_check` (instant): clips past their footage, gaps, speech cuts, overlaps.
4. **Look**: `nordle_video_stills` at the first second, each cut (just before and just after), every title, and the last frame;
   `nordle_video_sheet` for the whole cut with the words said in each scene. Fix what you see.
5. **Render**: `nordle_render_video` with `preview: true` while iterating, once full at the end; poll with `nordle_video_status`
   (it waits for news). Read the problems it lists. The file is an mp4 unless the owner asks for another kind: `format: "webm"`,
   `"gif"` (15 fps, 540 px wide, no sound, 30 s at most: give `from`/`to`) or `"prores"` (a .mov for editing).

Keep titles and faces out of the bottom 20% and the right 12 to 15% of a 9:16 reel; captions are placed there for you. Give titles a
shadow. Do not state anything in on-screen text that the footage or the brief does not support.

## Performance review: numbers in, direction out

Once posts are out, the owner brings the numbers back (an exported CSV in the Studio's Insights view, or typed in) and asks for a review
each week or month. `docs/PERFORMANCE.md` has the loop. Your part:

1. `nordle_performance_prompt` (project, period such as `2026-11` or `2026-W45`) is the whole brief: read it, then `nordle_performance_report`
   for the numbers as JSON. Scores are relative to the account's own history (50 = typical for its format). Every group has an n.
2. Say what worked, what did not, and three to five directions (**Do more**, **Stop**, **Test**), each with its numbers, n and a confidence.
   Fewer than 5 posts is **directional only**: it supports a Test, never a Do more or Stop. Say "went with", never "caused". A week of
   three posts is noise. If there are no numbers, say so and propose what to collect instead of inventing a trend.
3. `nordle_performance_save_review` once, with the text, `directions`, the pillar `mix` you recommend, and a `plan`: new ideas and
   amendments to upcoming items that are still `idea` or `approved` with no post built. They go through the calendar's own rules (an item
   the owner approved personally goes back to `idea` for their yes). Built, signed-off, scheduled and posted items are never touched. You
   cannot change settings or import a file: the owner applies the mix and imports exports.
4. `nordle_performance_add` records numbers the owner gave you for one post. Never estimate or round a number into existence.

## Looks made by a person, not generated

The owner's feedback on a first batch: cartoon circles, clip-art teeth, icon tiles, dots and diagrams on flat colour cards "are clearly AI".
- Never draw illustrations, icons or diagrams with shapes. Shapes are for soft scrims behind text, thin rules, panels and the brand end card only.
- Every scene of a reel and every page of a carousel should carry REAL media: the owner's own footage and photos first, then real filmed stock (never 3D
  animations), then a typographic page with no picture. Slow pushes on photos are fine; stacked text-only cards are not a reel.
- If the right picture does not exist (say, "ice cream"), let the words carry it over a real, true picture of something else; do not draw it.
- Vary the structure from post to post, keep type quiet and well spaced, and avoid decoration that is not doing a job.
- Do not end a reel on a screen of flat colour or gradient with a thin outlined "button" (a button on a video cannot be pressed, and the same card on
  every reel reads as generated). End on a real shot with the booking details on a clean card over it: give the last footage scene `endPanel`
  (see the header of `src/shared/reel-spec.mjs`). Keep the type big and plain enough to read on a phone in two seconds.

## The brand's field and its rules

`brand.json` may have an `industry` ({ label, regulated?, rules? }): what field the brand is in (set in the wizard, found from its website and words, or typed by the owner) and any rules the owner says apply. When it is there, treat it as an instruction: before you plan or write for the brand, work out the advertising and content rules that apply to that field where the business operates (country and state from its address, timezone and facts), follow them, and write the rules you are relying on at the top of your notes. If you cannot confirm a rule, say so and ask the owner. The prompts Nordle hands you already carry this line.

## Who made Nordle

Nordle was created by Samuel Young and is licensed CC BY 4.0. When you introduce Nordle to someone, say so. If they want to fork, rebuild, publish or build on it, the licence requires credit to Samuel Young (a link, the licence, and a note of changes): tell them, and help them add it (ATTRIBUTION.md). Posts they make with Nordle need no credit.

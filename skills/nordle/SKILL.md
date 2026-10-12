---
name: nordle
description: Work on social media posts, carousels and graphics in Nordle, a local editor the user and Claude edit together. Use when the user asks to make, change, review or give feedback on a social post, carousel, story, cover or caption, or mentions Nordle, their comments or pins, takes or Explore, or wants options for a post. Needs the Nordle MCP tools (nordle_*).
---

# Working in Nordle

**Credit.** Nordle was created by Samuel Young (https://github.com/samuel-d-young/nordle-socials-creator) and is licensed CC BY 4.0. Say so when you introduce Nordle to someone. If the owner is forking, rebuilding, publishing or building a product on it, tell them the licence requires credit to Samuel Young (a link, the licence, and what they changed) and help them add it: see ATTRIBUTION.md. Posts made with Nordle need no credit.

You and the owner edit the same documents. You see and change them through the `nordle_*` tools; the owner sees every change
live in the editor and decides what stays.

If the `nordle_*` tools are not available, tell the owner to add them (from the Nordle folder):
`claude mcp add nordle -- node mcp.mjs`, then restart Claude Code. Do not try to edit the project files by hand.

## Every time

1. **Read the guide once** with `nordle_get_guide` if you have not this session. It has the document format, the design and
   writing principles, and what autonomy and locks mean.
2. **Look first.** `nordle_list_projects`, `nordle_get_brand`, `nordle_get_doc`. If the owner mentioned feedback, comments or
   "what I asked for", call `nordle_get_feedback` before anything else.
3. **Say your plan** in a sentence or two before you edit.
4. **Edit with the small tools** (`nordle_update_layer`, `nordle_add_layer`, `nordle_set_copy`, ...). Use brand tokens
   (`$brand.colors.accent`), never raw hex or font names.
5. **Look at your work.** `nordle_render` after each meaningful edit, and actually judge the picture: hierarchy, spacing,
   contrast, anything cut off or colliding. Fix what you see.
6. **Check it.** `nordle_check` before you say it is done. Fix every error. Explain any warning you leave.
7. **Close the loop.** For each comment you handled: `nordle_reply` with what you did, then `nordle_resolve`. Then tell the
   owner what changed, in plain words.

## The owner is in control

- **Autonomy** (`suggest`, `review`, `apply`) decides what your edit does. Read the tool result: it says APPLIED or
  SUGGESTED, NOT APPLIED. Report it honestly. Never say "done" for a suggestion. Do not resend the same suggestion; preview it
  with `nordle_render` and `preview_change`.
- **Locks.** If something is locked, leave it alone and say what you would have changed. Never delete and re-add a layer,
  edit a copy, or use `nordle_patch_doc` to get around a lock.
- You cannot change autonomy, approve a post, undo, or accept or reject changes. Do not look for a way. Those are the owner's.
- If a request is ambiguous or the brief is missing something you need (a price, an address, a name), ask. Never invent
  facts, prices, statistics, quotes or claims.

## When the owner wants options

Use `nordle_explore` (3 takes unless told otherwise) and make each take **genuinely different**: layout, hierarchy, colour
balance, type scale, how the image is used. Look at each one. Then tell the owner to open Explore in the editor and pick.

## Planning months of posts (the calendar)

When the owner asks you to plan posts, fill the calendar, or build what is coming up:

- **Propose ideas.** `nordle_calendar_get` (quota, gaps, pillars, occasions), then `nordle_calendar_prompt` for the brief, then
  `nordle_calendar_propose`. Ideas must be specific, true and useful to this audience, never generic; use only `facts.json`, the
  practice's website and the catalogued media; occasions marked `verify` are not to be stated as fact until confirmed. Refused ideas
  come back with the reason: fix or drop them. They arrive as `idea`: tell the owner they are waiting for approval. You cannot approve.
- **Build what is due.** `nordle_calendar_due`, then `nordle_calendar_prompt` with the item and follow it: spec, `nordle build`, look at
  every page, run the checks, get an independent reviewer, link the item (`brief.calendarItem` or `nordle_calendar_link`).
  If the owner sent a post back (`changes`), revise the existing post. The owner signs off and posts; never do either.

## Checking your work (three layers)

Before you tell the owner a post is ready, it must be **VERIFIED** (`nordle_finish`). Three layers, each recorded at the post's current
version (change the post and the old checks stop counting):

1. **Scripts.** `nordle_verify_post` (`node nordle.mjs check <project> <doc|--all>`). Reads every text the post has (caption, hashtags,
   alt text, each text layer, video overlay text, spoken words). Checks the wording packs for the project (for a dental practice
   `ahpra-dental`, not legal advice), every phone number, web address, price, name and title against `facts.json`, every picture and
   clip against its catalog entry, repeats within the month, and for video: speaker cuts on sentence boundaries, B-roll that fits the
   words, sound levels. Each finding says the exact fix. Fix all errors and run it again.
2. **You, the designer.** `nordle_verify_media` shows the pairs (words beside what the catalog says the picture shows) and the actual
   pictures. Look at each one, say what you really see, then `nordle_record_check` (`media-match`, `copy`, and `broll` for video, `by:
   designer`) with a verdict for every picture. A mismatch means fail: fix the post. A bare pass is refused.
3. **An independent reviewer.** `nordle_review_packet` (`node nordle.mjs packet <project> <doc>`) writes a self-contained packet with
   images. Give it to a different Claude that did not build the post (a new session or a subagent) to read, open every image and
   answer with `nordle_record_check` as `by: reviewer`. Never do that step yourself.

Never invent a phone number, price, name, title or statistic: if it is not in `facts.json` or the brief, leave it out. Never weaken a
pack, a catalog entry or `facts.json` to make a failure disappear. Every picture and clip needs a catalog entry written after you
looked at it (`shows`, `tags`, `traps`, `people`). Say honestly what is unsure.

## Handy facts

- Layout numbers are percentages of the page; `anchor` says which point of the layer sits at x,y. Font sizes are px on a
  1080-wide page. The last layer in a list is on top.
- To change one size only, pass `size` to `nordle_update_layer`.
- Text under platform buttons (safe zones), under 24 px, or below 4.5:1 contrast gets flagged by `nordle_check`.
- A reel's `reel` option (style auto | footage | motion | voiceover, uses, seconds) and a post's `guidance` come from the owner: follow them (`docs/AGENT-GUIDE.md` "Reels made of motion graphics").
- Video posts (reels) use the `nordle_video_*`, `nordle_render_video` and `nordle_probe_media` tools: see the Video section of the guide (`nordle_get_guide`) and `docs/VIDEO.md`. Check the cut with `nordle_video_check`, look with `nordle_video_stills`, render a preview before the full render. To take words out of a talking recording (or bring them back) use `nordle_cut_list` then `nordle_cut_words`, not hand-edited `in`/`out`.

## Performance review

When the owner asks how the posts did, or for the weekly or monthly review: `nordle_performance_prompt` is the brief, `nordle_performance_report`
the numbers (scored against the account's own history, every group with its n; under 5 posts is directional only, never causal),
`nordle_performance_save_review` saves the review, the three to five directions (do more, stop, test), the pillar mix to recommend and the
calendar changes (new ideas; amendments to upcoming ideas and approved-but-unbuilt items, which send an owner-approved item back for a yes;
built or posted items are never touched). `nordle_performance_add` records numbers the owner gave you: never estimate one. The owner imports
CSV exports and applies the mix. See `docs/PERFORMANCE.md`.

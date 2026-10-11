# Nordle Studio: design brief

The Studio is the front door of Nordle: one place to see every post for every brand, decide on them fast, and get out.
The job it is built around is a morning one: about a hundred posts are waiting, the owner has coffee and a phone or a big
screen, and each post needs a yes, a "change this" or a no in seconds, with enough evidence on screen to trust the yes.

## Point of view: a proof desk

Print people judged work on a light table: contact sheets, red pencil, a stamp when a proof was passed. The Studio borrows
that, and nothing else. The pictures are the interface; the chrome is paper and ink; colour is rationed to three jobs:
the brand a post belongs to (a thin lane colour), progress (stamp green for signed off, pencil ochre for sent back) and
what is wrong (one proof red: a failed check, an edit since sign-off, a rejection, today's marker). "Needs your review" is
the default state of most posts on the morning, so it is plain ink, not an alarm. If everything is coloured, nothing is urgent.

## Principles

1. **One loop, made fast.** Look, decide, next. The review queue is the hero; every other view exists to find what needs it.
2. **Unequal weight.** Not every element is equal. One primary action per surface, quiet secondary ones, hairlines instead of boxes.
3. **Quiet when fine, loud when not.** Passing checks collapse to a count. Failing and missing checks are on top, in words, and a
   missing check looks different from a passed one (dashed outline, not a green tick).
4. **Evidence beside the decision.** The caption claim sits next to what the photo shows. The score, the checker and the date are
   one glance away, never a second screen.
5. **Rhythm in spacing.** Tight inside a group (4 to 8 px), generous between groups (24 to 48 px). Uniform padding everywhere is the tell.
6. **Keyboard first, thumb friendly.** Every action has a key and a visible hint; touch targets are 44 px; the phone layout is an
   agenda, not a squashed desktop.
7. **Honest states.** Empty, loading, error and offline are designed screens that say what happened and what to do next.
8. **State lives in the URL.** View, brand, month, filters and the open post are in the hash, so back, reload and "send me that one" work.

## Type

Two bundled families (both OFL, in `fonts/`), used with a clear division of labour:

- **Fraunces** (variable, weight 500 to 650): the voice. Month names, post titles, big numerals (counts, scores, day numbers),
  the wordmark. Never body copy, never buttons.
- **Inter** (variable): the machinery. Controls, captions, tables, labels. Tabular figures for every date and count.
  Section labels are 11 px, 0.06 em tracked, upper case; nothing else is upper case, except the stamp.
- `ui-monospace` only inside key caps.

Scale (px / line): 11/14 label, 12/16 meta, 13/20 body, 15/22 lead, 18/24 h3, 24/28 h2, 36/38 h1, 56/56 masthead.
Two weights per family in use (Inter 400 and 560; Fraunces 560 and 650). No light weights, no gradient text.

## Colour tokens

Defined once on `:root` in `app/styles.css` and shared by the Studio and the editor. Light is "Paper", dark is "Darkroom";
both follow the system and can be forced with the toggle. Measured contrast (WCAG) is for text on the page background.

| token | light | dark | role |
|---|---|---|---|
| `--paper` | `#F2F0EA` | `#131517` | page |
| `--rail` | `#E9E6DE` | `#0E1012` | side rail, recessed areas |
| `--surface` | `#FBFAF7` | `#1B1E21` | panels, inputs, raised |
| `--ink` | `#17191B` (15.5) | `#ECE9E0` (15.1) | text, primary button |
| `--ink-2` | `#44484C` (8.1) | `#B7B4AA` (8.8) | secondary text |
| `--ink-3` | `#5C6065` (5.6) | `#97948C` (6.0) | meta text (still above 4.5) |
| `--rule` / `--rule-strong` | `#D8D4C9` / `#B9B4A6` | `#2B2F33` / `#43484D` | hairlines |
| `--proof` | `#B52A17` (5.6) | `#FF7A63` (7.2) | something is wrong; today |
| `--stamp` | `#17674A` (6.0) | `#62C79B` (8.9) | signed off, passed |
| `--pencil` | `#865000` (5.8) | `#E8AA48` (9.0) | changes requested, warnings |
| `--mark` | `#F4E7A8` | `#5A4B14` | the caption hook highlight |

Each brand brings its own lane colour from its `brand.json` (accent). It is used only as a 3 px tick, a lane tint at 7 percent
and a dot, never as a text colour. Status is never colour alone: each state also has its own shape and a word.

## Space, shape, elevation

- 4 px base: 2, 4, 8, 12, 16, 24, 32, 48, 72. Page gutter 24 (16 on phones). Rail 232.
- Radius: 0 on pictures and frames (they are prints), 3 px on controls, 999 only on status dots. No uniform rounded card.
- No shadows on surfaces. One overlay elevation (menus, dialogs, the detail sheet on small screens). Separation is hairlines and tone.

## Motion

120 ms for hover and press, 180 ms for state changes, 240 ms for the detail panel and for the queue moving to the next post.
`cubic-bezier(.2,.7,.2,1)` (ease-out) always; nothing eases in. Only `transform` and `opacity` animate. The one expressive
moment is the **stamp**: when a post is signed off a "Signed off" stamp lands on the picture (about 400 ms, slight rotation)
and the queue moves on. `prefers-reduced-motion` turns every transition to a plain cross-fade or none, and the stamp to a fade.

## Anti-patterns (do not ship)

- Purple, indigo or blue-to-pink gradients; glass blur; glow; gradient text.
- A centred hero with three feature cards; a grid of identical rounded cards with soft shadows.
- Emoji or stock icon sets as decoration. Icons are a small custom line set, plus the format glyphs (reel, carousel, post, story).
- Inter at one weight and one size for everything; light grey text under 4.5:1.
- "Welcome back!", "Something went wrong", a bare spinner, a blank empty state.
- Three buttons of equal weight; colour as the only carrier of status; hover-only controls with no touch or keyboard route.
- Hiding what is missing. A check that has not run is shown as not run.

## What is borrowed, and from where

| From | Borrowed |
|---|---|
| Unpromptable, five tips for AI website design <https://unpromptable.substack.com/p/5-ai-website-design-tips-for-websites> | Collect references and decide the look before building; sketch layouts first; do not accept the statistically average first output. This brief and the stamp motif are that step. |
| SaaS UI, seven tells of AI-generated UI <https://www.saasui.design/blog/saas-ui-looks-ai-generated> | Equal-weight card grids, uniform spacing, undifferentiated buttons, blank edge states and generic copy are the tells. We use rhythm, one primary action, designed empty and error states, and plain specific wording. |
| Superdesign, making AI UI less generic <https://www.superdesign.dev/blog/how-to-make-ai-ui-look-less-generic> | Avoid default Inter-only type, purple gradients, centred hero, rounded everything, faint shadows; write colour and spacing down as tokens. |
| Linear, how the UI was redesigned <https://linear.app/now/how-we-redesigned-the-linear-ui> | "Not every element carries equal weight"; dense but aligned; neutral chrome; a theme made from a few variables so light and dark stay consistent. |
| Are.na style summary <https://www.webdesignhot.com/design.md/are-na/> | Hairline borders and tone shifts instead of shadows, square corners, one accent colour, tight 8 to 12 px gaps, only two type weights, plain dry copy. |
| Things 3 review <https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/> | Colour only where it means something; completion is acknowledged (our stamp); structure the day (our week bands) instead of one long wall. |
| Cron shortcuts <https://www.cron.com/changelog/2021-03-29-shortcuts-help-and-feedback-button> | `?` opens a searchable cheat sheet, `/` searches, two-key sequences (`g` then a letter) for navigation. |
| Frame.io review and approval <https://frame.io/features/review-and-approval> | Scrub the video by hovering or keys, comments anchored to the work, versions comparable, status on the asset itself. |
| Buffer calendar <https://support.buffer.com/hc/en-us/articles/4406255350931> | Week and month views with thumbnails, several channels in one calendar, gaps in the plan visible at a glance. |
| Editorial design pattern <https://trends.daisyui.com/trend/editorial-design/> | Display serif over a disciplined sans, hairline rules, zero radius on image frames, paper and ink neutrals with one accent, captions under pictures. |
| Vercel Web Interface Guidelines <https://vercel.com/design/guidelines> | Visible `:focus-visible` rings, URL as state, optimistic updates with undo, skeletons that match the content, reduced-motion variants, never `transition: all`. |
| Animation rules from Emil Kowalski's course (summary) <https://skills.sh/mrmps/smry/emilkowal-animations> | Ease-out only, under 300 ms, button feedback 100 to 160 ms, panels 200 to 500 ms, animate transform and opacity. |

## The surfaces

Rail (views, brands, theme) and a masthead (date, big month title, four figures: needs review, built today, checks failing,
next seven days; the first is also the door into the review queue and is the only filled block on the page). Month: weekday header, then one band per week; with "All brands" each week has a lane per brand. Wall: a contact
sheet grouped by week with a filter bar. List: a dense sortable table, virtualised. Queue: a light table with the post large and the
decision beside it. Plan: quotas as meters, pillar mix, idea backlog, next month's gaps. Detail: a sheet with the picture first,
then caption, why, checks, words versus picture, comments and history.

The **video editor** (`app/video-*.js`, `video.css`) uses the same tokens: the monitor on the table colour, the timeline on paper, clips as flat
blocks with a hairline edge (picture cool grey-blue, sound warm, photos mauve, titles ochre; each redefined for Darkroom), the proof-red playhead,
the stamp green only for "someone is speaking" in a waveform. Status is never colour alone: problems are diamonds (warning) or triangles (error) with words in the Check tab,
a muted or locked clip says so in words and a hatch. Everything on the timeline is reachable by keyboard (Tab to a clip, Enter selects, Alt+arrows walk the track);
the only motion is the spinner, which stops under reduced motion.

## The skin (`app/studio-skin.css`)

Loaded last, so it can be removed alone. Dot-grid paper, 2 px ink outlines, hard offset shadows that press in on click, one orange (`--hot`) for
accents, Outfit for words and Doto for numbers. It never changes what a colour means (green approved, red needs you) and never uses orange for small
text on paper (too pale). In the dark theme the outlines and shadows turn orange. Style follows RoboNuggets' RENDER Studio (CC BY 4.0).

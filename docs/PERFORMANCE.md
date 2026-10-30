# Performance: learn from what was posted, then tune what comes next

Nordle plans and builds the posts. This closes the loop: the owner brings the **numbers** back each week or month, Nordle shows **what
worked and what did not** (honestly: small groups are labelled as small), Claude writes a **review** with three to five directions and
**tunes the upcoming plan**, the owner **approves** the changes, and the next posts are built from the tuned plan.

```
 post ──> collect the numbers ──> review ──> plan changes ──> owner approves ──> build ──> post ...
          (Insights: Import CSV     (scores,     (new ideas, amended hooks,        (the calendar's
           or Add results)           groups,      a recommended pillar mix)         normal route)
                                     Claude's text)
```

Nothing is posted or sent anywhere by this. The numbers come from the platform's own analytics: copied by the owner (CSV or typed), or, for a brand
with Buffer connected, **read from Buffer by Nordle itself about every six hours** (read only; see docs/PUBLISHING.md "Reading Buffer by itself").
Every number is stored exactly as the platform showed it. Nothing is estimated, by Nordle or by Claude.

## Each week or month: the steps

1. **Wait until the numbers have settled.** A review waits until every post in the period is **7 days old**, so the 7-day numbers are
   real. A monthly review falls due on the 7th of the next month; a weekly one on its chosen weekday (default Monday) once the week is
   a week old. Choose the rhythm once: `node nordle.mjs calendar settings <project> --review monthly` (or `weekly`, with
   `--review-weekday friday`). Without it no review is ever "due".
2. **Export the numbers** (below) and **import** them: Studio > **Insights** > **Import CSV** (pick the file, choose "7 days after
   posting" and the day you exported, **Check the file**, read what matched, **Import**), or
   `node nordle.mjs performance import <project> <file.csv> --window 7d` (a dry run: add `--yes` to write).
   A post the export missed, or an ambiguous row, is typed in: Insights > **Add results**, or
   `node nordle.mjs performance add <project> <post id> --reach 1200 --likes 80 ...`.
3. **Look.** Insights shows the headline numbers, the best and weakest posts with thumbnails and numbers, results by pillar, format,
   hook type, weekday and more, every group with its n. `node nordle.mjs performance report <project> --month` prints the same.
4. **Review.** Insights > **Run a review with Claude** copies a request; paste it to Claude (Claude Code with the Nordle tools connected,
   `claude mcp add nordle -- node <nordle folder>/mcp.mjs`). Claude reads the report, writes the review (what worked, what did not, three to five directions, the pillar mix),
   proposes new ideas and amends upcoming ones, and saves it all. `node nordle.mjs performance review-prompt <project>` prints the same
   request. The review appears under the numbers in Insights.
5. **Approve.** New ideas arrive as `idea` in the Plan view; an upcoming item you had already approved and Claude amended goes back to `idea`
   for your yes (unless approval is delegated for it). **Apply this mix to the plan** (Insights, under the review) re-weights the pillar
   shares in the settings: only you can do that, Claude cannot.
6. The calendar builds the approved items as their dates come near, as always (`docs/CALENDAR.md`).

`node nordle.mjs performance due [--all]` says whether a review is due; `node nordle.mjs calendar run` mentions it too and, only for a
project with `review.autoReview` switched on, asks Claude for the review itself (see "Running it unattended").

## Getting the numbers out of the platforms

Do this once the posts are at least 7 days old.

**Meta Business Suite (Instagram and Facebook)**: Insights > **Content** > **Export data** (top right) > the **Instagram** tab > choose the
account, the date range and **Posts** (or Stories) > **Generate** > when the report is ready, open **Export data** again and download it
as a CSV. (Steps as described by [Coupler.io's guide](https://blog.coupler.io/how-to-export-data-from-instagram-insights/) and Meta's
[Content Insights help page](https://www.facebook.com/business/help/917147395728365); Meta's own insights views cover the last 90 days, so export
within that.)

**Buffer**: Analyze > the channel on the left > the date range > **Export as...** > **Export as CSV**. Buffer downloads a **zip** of several
CSVs (average and overall performance statistics, demographics, metrics insights, **Posts**, posts hashtags, posts summary, stories
summary); **unzip it and import the Posts file**. CSV export is on Buffer's paid plans, for the channels Analyze supports (Facebook
Pages, Instagram business and creator accounts, LinkedIn Pages, X). ([Buffer: exporting posts](https://support.buffer.com/article/524-is-it-possible-to-export-sent-posts-in-buffer),
[Using Buffer Analyze](https://support.buffer.com/article/955-using-buffer-analyze).)

### What the importer accepts, and what is NOT verified

The exact column headings of these exports are not published column by column in anything we could read, and the platforms change them.
So the importer does not depend on one layout:

* headings are matched **case-insensitively** against a list of synonyms (`src/performance/import.mjs`, `HEADER_SYNONYMS`): `Description`,
  `Caption`, `Text`, `Message` for the words; `Publish time`, `Published`, `Post created`, `Date` for the day; `Permalink`, `Post link`, `URL`;
  `Post type`, `Media type`; `Reach`, `Impressions`, `Views`, `Plays` (`Reels plays`), `Likes` (`Reactions`), `Comments`, `Shares`
  (`Reposts`), `Saves`, `Follows`, `Profile visits`, `Link clicks` (`Clicks`), `Watch time`, `Average watch time`, `Completion rate`,
  `DM starts` (`Messages started`), `Swipes`;
* a unit in brackets is read (`(ms)`, `(min)`, `(hours)`; seconds are assumed), `1.2K` and `45%` and `1,234` are numbers, `-` and `N/A` are blank;
* title lines above the header, a `sep=,` first line, semicolon or tab separators, a byte-order mark and Excel's UTF-16 are all handled;
* columns it does not know are **listed and ignored**, never guessed; if a column has an odd name, say what it is:
  `--map "Header As Written=reach"` (command line) or the same in the import dialog's API call;
* slash dates are ambiguous (`03/09/2026`): the importer decides day-first or month-first from the whole file when it can (any value
  with a part above 12), uses `--date-order dmy|mdy` when you say, and otherwise matches both readings against the calendar and reports a
  tie instead of choosing.

**Not verified:** that these synonyms cover the headings in a current real Meta Business Suite or Buffer export, what unit the watch-time
columns use, which date format Meta uses for the export of an Australian account, and whether Meta's "Views" now replaces "Plays" for
reels in the CSV. The first real import is therefore a dry run: read "columns understood" and "columns ignored", fix anything with
`--map`, and tell us what the headings actually were so the list can be extended. `examples/metrics.example.csv` is a **fictional** file in
the layout we expect, used by the tests' shape.

### How rows are matched to posts

Each row is matched to a calendar item by, in order of certainty:

1. **an item id** found anywhere in the row (a UTM tag in the link, a note, a hidden column): certain;
2. **the first 60 characters of the caption** equal the post's caption (the built post's caption, or an outside post's): `caption`, and
   `caption+date` when the day also agrees within a day;
3. **publish date within a day and the opening of the caption alike** (letter-pair similarity at least 0.6): `date+caption`.

Anything else is reported, **never guessed**: a row that matches no post ("it may have been posted outside Nordle"), a row that fits two
posts equally (identical captions the same day), two rows for one post, a row without numbers. A matched row also carries a warning when
the file's type disagrees with the calendar's format, when the date is not the calendar's, or when the item is not marked `posted`.
Importing again replaces the same post, platform and window; another window is kept beside it.

## How a post is scored

A score from 0 to 100 means **how this post did compared with this account's own other posts of the same format**: each number is turned
into a percentile among the account's own history (ties count half), and the percentiles are averaged with weights for the format.
50 is a typical post. A small account and a big one compare fairly because nobody is compared with anybody else. Rates are per 1,000
of reach (or views, plays, impressions: whichever the export has, and only like with like is compared).

| format | judged on (weight) |
|---|---|
| reel | plays or views or reach (30), watching: completion rate or average watch (25), shares (25), saves (20) |
| carousel | saves (35), shares (25), reach (25), swipes (15) |
| single post | reach (35), likes (35), comments (30) |
| story | reach (50), replies (25), shares (25) |

Missing numbers drop out and the rest is re-weighted; a post is scored only when at least half of the weight is present. The report lists
the parts of every score. Rules that keep it honest:

* **Windows.** Numbers are `7d`, `28d` or `lifetime` (how long after posting they were read). A post is judged by the window you ask for
  (default 7d) if it has settled; numbers captured **before** their window has passed are left out of scores and listed ("measured too
  early"); a post with only another window is scored against posts with the same window only.
* **Groups.** Posts are grouped by pillar, format, hook type, weekday, time of day, a face on the cover, reel length, caption length, music,
  series ("Meet the team") and occasion or evergreen. The grouping rules are plain code in `src/performance/features.mjs`, and the hook
  type shows which rule matched (question, myth, number, how-to, behind-the-scenes, announcement, statement). A face on the cover comes
  from the media catalog (`people`, tags, the description of the cover photo or the first clip); with no catalog entry it is "unknown",
  not guessed.
* **Evidence.** Every group shows its **n**. Under 5 posts, or under 5 to compare with, it is **directional only**. A gap of 8 points or more
  on at least 5 either side is **suggestive**; 10 points on at least 10 either side with a rank test under 0.05 is a **clearer gap**.
  None of this is cause: the report and Claude say "went with", never "caused", and the report ends with why a dozen comparisons at once
  will throw up patterns by chance. Treat a pattern as something to **test on purpose** next month.
* **Gaps.** Published posts without numbers, numbers taken too early, a small history for a format, missing parts, and posts that could not
  be classified are listed at the end of the report.

## The review

A review is `reviews/<period>.md` (the text) plus `reviews/<period>.json` (directions, the recommended mix, what changed), for a week
(`2026-W45`, Monday to Sunday) or a month (`2026-11`). It has: what worked, what did not, three to five **Do more / Stop / Test** directions
each with evidence (numbers and n) and a confidence, a recommended pillar and format mix for next month, how the last review's advice went
(followed? did the score move?), and the data gaps. Saving it also appends **what actually happened to the calendar**, written by the code,
not by Claude.

What a review may change (always through `src/calendar/service.mjs`, so every calendar rule still applies):

| change | how it arrives |
|---|---|
| new ideas | `idea`, for the owner to approve (`approved` only when the owner delegated approval) |
| amend an **upcoming** item that is `idea` or `approved` with no post built: hook, idea, title, media plan, audience, occasion, pillar, notes | an item the owner approved personally goes back to `idea` for their yes; an item that arrived under delegated approval stays approved |
| built, signed-off, scheduled, posted, rejected or past items | **never touched**; the tool refuses and the review says so |
| the pillar mix | saved with the review; **only the owner applies it** (Insights, or `performance apply-mix`); the monthly quota (8 reels + 5 others) is never changed by a review |
| settings, approvals, sign-offs | not available to a review |

### Running it unattended (off by default)

`calendar settings <project> --review monthly --auto-review on` lets `node nordle.mjs calendar run` write a due review headlessly, with the
same safety rules as the build runner: one run per project at a time (the shared run lock), a timeout, the whole process tree stopped by PID,
**read tools and the Nordle tools only** (no shell, no file writes by Claude), the environment marked as one of Claude's runs so owner-only
command-line steps refuse, a log under `history/calendar-runs/`, and **it never starts without numbers for the period**. Without
`autoReview`, `calendar run` only mentions that a review is due. The tests only ever use a fake `claude`.

## Where things are

* `<project>/metrics.json` (`schemas/metrics.schema.json`): one entry per post, platform and window, with `source` (`csv`, `manual`, `buffer`,
  `meta`) and `by` (`owner` or `claude`). Written under a short lock, atomically.
* `<project>/reviews/<period>.md` and `.json`.
* Calendar settings: `review: { cadence: weekly|monthly, weekday?, autoReview? }`.
* Command line: `node nordle.mjs performance import | add | report | review-prompt | save-review | due | history | apply-mix`.
* Studio: **Insights** in the rail (`g i`); the period is in the address bar (`?ip=2026-10`).
* Claude's tools: `nordle_performance_report`, `nordle_performance_prompt`, `nordle_performance_save_review`, `nordle_performance_add`. There is
  no tool to import a file or apply a mix.
* HTTP: `/api/projects/<p>/performance/...`; every shape is documented at the top of `src/server/routes/performance.mjs`.

## Tests

`tests/performance.test.mjs`: the importer (headers, delimiters, dates, matching, ambiguity, duplicates, dry run), the maths (percentiles,
the rank test, evidence labels), scoring relative to the account, small-n flags, segments, due logic, the plan rules (including built and
past items), the prompt, the headless review with a fake Claude, the command line, and who may do what over HTTP and MCP.

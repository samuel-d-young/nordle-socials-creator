# Self-test: let Claude try the whole app for you

`npm test` proves the code. This proves the **workflow**: a person (here, Claude) opening the Studio, making a brand, getting a post
built, checking it, and handing it over, the way you would. It takes Claude about 20 to 40 minutes and costs nothing beyond your normal
Claude usage: it uses no paid service and posts nothing anywhere.

Paste the prompt into Claude Code in the Nordle folder (Nordle must be installed and the MCP tools connected: see the README).

The shape of the prompt (Ask, Goal, Examples, Negations, Tools) is taken from the CRAFT build guide by RoboNuggets (CC BY 4.0,
https://robonuggets.com), which uses it to make an agent test an app end to end. The wording below is our own.

## The prompt

````text
/goal

Ask:
Test the whole of Nordle for me, for real, on 3 different brands, and tell me the truth about what works.

Goal:
Do not stop until all 3 brands have gone through the entire workflow on their own, by using the Studio the way a person would:
open the Studio, add the brand, set up its facts and photos, plan a month, approve an idea, have the post built, run the checks,
look at the result, ask for one change, and export it. The three brands:
  1. the sample brand that ships with Nordle (little-gannet),
  2. a made-up brand you invent with a very different look (say a yoga studio with soft colours and a serif font),
  3. a made-up brand in a different field and a different country, with a different timezone (say a hardware store in Toronto).
For brands 2 and 3 use the Studio's "Add a brand" wizard, and make a few simple pictures to use as their photos (plain coloured
shapes are fine; say they are placeholders).
- Click through the Studio in a real browser, with screenshots, rather than only calling the tools or the command line. If a
  button, a message or a step is confusing or broken, write down exactly what you did, what you saw and what you expected. Never
  pretend a step worked.
- Each brand's post must look like its own brand, not the same template three times. Judge the pictures yourself, page by page.
- Include one carousel, one single graphic, and (only if ffmpeg is installed) one short reel from a few seconds of generated video.
- Use "Request changes" once on one post. If it says Claude Code is not signed in, report that instead of trying to work around it.
- At the end, check that the exported post (the export folder, not a real account) opens and that its pictures match what the
  Studio showed.

Examples:
The bar for each brand is a post you would be happy to publish: readable, on brand, nothing cut off, the right language and
wording for its country, and a caption that matches the pictures.

Negations:
Do not connect Buffer or any other account. Do not publish, schedule or send anything outside this computer. Do not enter any
real key, password or personal detail. Do not edit Nordle's own source files to make a step pass. Do not touch anything outside
the Nordle folder, apart from the placeholder pictures you make in a temporary folder. Do not skip a step because it looks hard.
Do not invent facts (phone numbers, opening hours, prices) as if they were real: label made-up ones as made up.

Tools:
The Nordle tools (nordle_*), the Studio in a real browser with screenshots (a browser tool you have, or the Chromium Nordle
installs), and the command line for `node nordle.mjs doctor` and `node nordle.mjs check`. When you are done, write ONE report:
a table with a row per brand and step (worked / worked with a problem / broke), the screenshot or file that proves each, how long
it took, every problem found in order of how much it would hurt a new user, and anything you were unsure about. Put the report in a
file called `self-test-report.md` in a new folder outside the Nordle folder, and tell me where it is.
````

## What you get back

A report you can read in five minutes. Treat anything marked "worked with a problem" or "broke" as a bug report: open an issue with
the report's steps, or paste the step into Claude Code and ask it to fix it.

Run it again after you change your computer, update Node or ffmpeg, or pull a new version. It is the closest thing to a new user
trying Nordle for the first time.

# Share prompt

Two prompts to paste into Claude Code (the terminal, or the Code tab in the Claude desktop app). Claude Code is needed because
Nordle installs a local tool and connects to it. Nordle runs only on your own computer, on Windows, macOS or Linux, for any
business, in any country or language you can write in.

- **Prompt 1** installs Nordle and proves it works. Restart Claude Code when it asks.
- **Prompt 2** is the first session: your brand kit (logos, colours, fonts, voice), your first plan, your first post.
- **The tester prompt** installs it, tries every main part, and writes a report to send back.

Nordle was created by Samuel Young (https://github.com/samuel-d-young/nordle-socials-creator) and is free to use under CC BY 4.0: credit him if you share it or build on it.
Some steps start Claude by itself ("Ask Claude now", "Build it now", reading a screenshot). They use your own Claude usage: about 20 to 30 cents to read a
screenshot or write ideas, and about 1 to 2 dollars to build one post. Nordle caps each run, and says what it cost.

## Prompt 1: install

````text
Install Nordle for me, then show me it works.

Nordle is a local social-media studio that you (Claude) and I use together: you plan the month, design carousels, graphics and
reels (cut from my own footage, or made only of motion graphics, or motion graphics timed to a voice-over I record), write the captions, and check your own work; I look at the results in a browser page and approve,
ask for changes or reject. It runs only on my computer. It was created by Samuel Young and is free to use under CC BY 4.0 (it asks for credit to him):
https://github.com/samuel-d-young/nordle-socials-creator

Do these steps in order. Stop and tell me if one fails; do not improvise around it.

1. Check I can reach the repo: run `git ls-remote https://github.com/samuel-d-young/nordle-socials-creator`. If it fails, tell me what the error says
   and stop.
2. Check I have Node.js 20 or newer and git (`node -v`, `git --version`), and ffmpeg for video (`ffmpeg -version`; posts made of
   pictures work without it). If something is missing, tell me what and how to install it on my system (Windows:
   `winget install OpenJS.NodeJS.LTS Gyan.FFmpeg Git.Git`; macOS: `brew install node ffmpeg git`; Linux: my package manager) and
   ask before you install anything outside the project folder.
3. Ask me where to put it (suggest a folder called `nordle` in my home or projects folder). Then clone it:
   `git clone https://github.com/samuel-d-young/nordle-socials-creator <folder>`.
4. Read `<folder>/setup.mjs` and `<folder>/README.md` first and tell me in two lines what setup will do (it runs `npm install`,
   downloads a Chromium browser of about 170 MB that Nordle draws pages with, and with `--register` adds the Nordle MCP server
   to Claude Code and copies one skill into my skills folder). Then run `node setup.mjs --register` in that folder.
5. Run `node nordle.mjs doctor` and show me the result. Everything it marks as needed must be green; ffmpeg may be amber if I have
   not installed it yet.
6. Start the Studio with `node server.mjs --open` in the folder and tell me the address (http://127.0.0.1:5400 unless that port
   is busy). It opens a fictional sample project (a coffee shop) so there is something to look at.
7. Prove it works without the MCP tools yet (they need a restart): run `node nordle.mjs render samples/little-gannet --sheet`
   and show me the contact sheet picture, then run `npm test` and tell me how many tests passed (it takes a few minutes).
8. Tell me to RESTART Claude Code now so the `nordle_*` tools appear, then check with `claude mcp get nordle`, and then to paste
   "Prompt 2" from `<folder>/SHARE-PROMPT.md` into the new session.
9. Finish with five lines or fewer: where it is installed, the Studio address, how to start it next time
   (`node server.mjs --open` in that folder), and anything that did not work.

Rules: do not edit anything outside the Nordle folder and my Claude settings for the MCP server and skill. Do not run `sudo` or
anything as administrator without asking. Do not send data anywhere; Nordle runs only on 127.0.0.1. Never post anything for me.
Whenever you introduce Nordle or tell me where it came from, say it was created by Samuel Young. If I ever want to fork, rebuild, publish
or build a product on it, tell me its licence (CC BY 4.0) requires credit to Samuel Young with a link and a note of what I changed, and
help me add it (see ATTRIBUTION.md).
````

## Prompt 2: first session (after the restart)

````text
Set Nordle up for my business and make my first post. Use the nordle_* tools; start by reading the guide (nordle_get_guide) and
the Nordle skill, and tell me in three lines how we will work.

1. Ask me four things, one message: what my business is and who it is for, my website address, my Instagram handle (if any), and
   the folder with my photos, logo and any footage. Do not guess any of them.
2. Set up my brand like a brand kit, with the Studio's "Add a brand" wizard (the + Add button in the Studio's left bar): my logos (full colour, and
   black, white, icon or wordmark if I have them; "Make black" and "Make white" can build those from the colour one), a screenshot of
   my Canva Brand Kit or any style page if I have one (Nordle reads its colours and fonts), my website, folders or files (a style guide
   is read), and what field the business is in. Show me what it found and change it until I say it is right. Then write `facts.json` with
   ONLY facts I confirm: phone, address, opening hours, names and titles. Never invent a fact, a price, a name or a result.
3. Look at my photos before you use them. Catalogue what each one shows in plain words, and mark which show people (so you only
   use a face where I have said that person agreed).
4. Ask what I must never say (rules for my industry and country, things I do not want promised) and put them in the brand's banned
   phrases. If I am in a regulated field such as health, law, finance or property, say so and look in `examples/packs/` for the
   closest wording pack (`plain-claims` suits any business); offer to write me a pack for my own rules. A pack is a writing aid, not
   legal advice, so tell me to check my own rules.
5. Show me the Studio's Create page (key `n`): I can type what I want, or choose how many posts (or "decide for me"), which kinds and which style, see
   options built from my own facts and tick the ones I like, or make a campaign (a goal, dates, one message) and make its posts now to schedule
   later. "Ask Claude now" there starts you from the Studio, so I do not have to paste anything. Propose next month's posts as ideas, wait while I
   approve, edit or reject them (Plan view), and do not build anything I have not approved. If I already have videos, show me how Create brings them in to edit.
6. Build the first approved post. Look at your own result as a picture, run the critique and the checks, fix what they find, and
   tell me what you were unsure about. Then tell me where to find it in the Studio.
7. Explain, in under ten lines, how I approve a post, how I ask for changes (the "Request changes" button and what it needs:
   Claude Code signed in on this computer: Nordle shows a Sign in to Claude button, one click and approve in the browser, nobody types a command), and what Nordle will NOT do on its own (it never posts without me).
8. Ask whether I want to connect a publishing service (Buffer) and a stock-photo library now or later. If now, point me to the
   Studio's Publishing and Stock windows and to `docs/PUBLISHING.md` and `docs/STOCK.md`; I type any keys myself, you never see or
   store them.

8b. Tell me that Nordle shows a notice in the Studio when it has been updated on GitHub (and how to update: `git pull && node setup.mjs`), and how to turn that off.

Rules: nothing is posted, scheduled or sent anywhere unless I press the button myself. Keep my files in the project folder
Nordle shows me. Tell me when you are guessing. Say that Nordle was created by Samuel Young whenever you describe it, and if I plan to share,
fork or build on it, remind me the licence (CC BY 4.0) requires crediting him (ATTRIBUTION.md).
````

## Prompt for a tester (one paste: install, try it, report back)

````text
I am testing Nordle for its author, Samuel Young, so please be a careful, honest tester. Nordle is a local social-media studio that you (Claude) and I use
together: you plan, design and check posts, I approve them in a browser page. It is open source: https://github.com/samuel-d-young/nordle-socials-creator

Part 1, install (stop and tell me if a step fails; do not improvise around it):
1. `git ls-remote https://github.com/samuel-d-young/nordle-socials-creator` must work.
2. Check Node.js 20 or newer, git, and ffmpeg (`node -v`, `git --version`, `ffmpeg -version`). If something is missing tell me how to install it for my
   system and ask before installing anything outside the project folder. Note my operating system and these versions for the report.
3. Ask me where to put it, then `git clone https://github.com/samuel-d-young/nordle-socials-creator <folder>`.
4. Read `<folder>/setup.mjs` and `<folder>/README.md`, tell me in two lines what setup does, then run `node setup.mjs --register` in the folder.
5. Run `node nordle.mjs doctor`, then `node server.mjs --open`, and tell me the address. Time each step (a rough number is fine).
6. Tell me to restart Claude Code, then to paste "Part 2" below into the new session. (If this session already shows nordle_* tools, carry on.)

Part 2, try it (use the nordle_* tools and the Studio in the browser; read the guide with nordle_get_guide first):
1. Open the sample project (Little Gannet Coffee) in the Studio and look around: Create, Month, Wall, Review, Plan.
2. Ask me for my business and my website, then make my brand with the Studio's "Add a brand" wizard (the + Add button in the left bar). Try the brand kit
   parts: add a logo in two kinds (use "Make black" or "Make white" if it can), choose a folder with the folder window (not by typing), add a file such
   as a style guide, say what field the business is in, and (if I have them) add a screenshot of a Canva Brand Kit and press "Read my screenshot", and two or three of my own finished posts under "Train it on your own posts" (press "Read my posts"). Tell me whether every colour and font in the screenshot came through, and whether the colours in the posts are the ones the brand kit reads as background, headline and accent.
   Use made-up details if I do not want to share real ones.
3. On the Create page (key `n`): make a campaign, show me its options, tick some and "Add as ideas, schedule later"; then pick "Decide for me" and a
   style for a normal month and add a few. In the Reels row try each "Made from" choice (Auto, Cut from footage, Motion graphics only, Motion graphics with a
   voice-over), what a reel uses and its length, and write something in the extra-info box; check it shows on the post (Edit, and the post's details). Say what was confusing.
4. Plan three post ideas for next month, wait for me to approve them in the Studio, then build one carousel and look at every page as a picture.
   Run the checks and critique, fix what they find, and tell me what you were unsure about. Before any step that starts Claude on its own
   ("Ask Claude now", "Build it now"), tell me it uses my Claude usage, and only do it if I say yes; if it does run, note the time, the turns and the cost it shows.
5. Use "Request changes" once with a comment. If Nordle says Claude is not signed in, press its "Sign in to Claude" button (nobody should have to type a command), approve in the browser, and tell me whether it carried on by itself; note anything confusing for the report.
6. If ffmpeg is installed and I have no footage handy: make one "Motion graphics only" reel from the Create page (Ask Claude now, after telling me it uses my usage), look at
   its sheet, and tell me if it reads as designed or generated. Do NOT make up a voice-over: a voice-over reel needs my own recording with word timings, so just say
   whether Nordle asks me for one clearly. Then, if ffmpeg is installed: use "Edit videos you already have" on the Create page with one short video of mine (or one you make with ffmpeg), open it in
   the video editor, click a title on the picture, double-click it and change its words, play it, split a clip (S), delete one, undo (Command+Z on a Mac,
   Ctrl+Z elsewhere), and say whether the picture and sound stay in step.
7. Check the small things: the "Claude account" window in the left bar (it shows who Claude is signed in as, with Switch account and Sign out; do NOT actually sign out unless I say so), the "Nordle by Samuel Young" credit in the left bar, and whether the Studio shows a notice about an update.
8. Export or schedule nothing outside this computer. Do not enter any real key or password.

Part 3, report. Write `nordle-test-report.md` in a folder outside the Nordle folder, with:
- my operating system, Node, git and ffmpeg versions, and how long install took;
- for every step above: worked / worked with a problem / broke, with what I did, what I saw and what I expected, in plain words;
- anything confusing in the words on screen, anything slow, anything that looked wrong (screenshots of the Studio help);
- what I liked, and the one thing I would change first.
Remove anything private first (real names, keys, local folder names). Then tell me where the file is and how to send it:
open an issue at https://github.com/samuel-d-young/nordle-socials-creator/issues with the report pasted in, or send it to whoever gave me this prompt.

Rules: never post, schedule or send anything for me, keep everything inside the Nordle folder and my Claude settings for the MCP server and skill, and never
claim a step worked when it did not. Say that Nordle was created by Samuel Young when you describe it, and put "Nordle, created by Samuel Young" at the top of the report.
````

## Other first messages to try

````text
Run the self-test in docs/SELF-TEST.md: use the Studio on three brands, in a real browser, and write me the report.
````

````text
Make a campaign called [name] from [date] to [date] about [message], with a call to action of [what people should do]. Show me the options on the Create
page, add the ones I tick as ideas, and leave the scheduling for later.
````

````text
I have videos in [folder]. Bring them into Nordle with Create > Edit videos you already have, and tell me how to change the text on them.
````

````text
Make a 6-slide carousel about [topic] in my brand. Look at every page yourself, run the critique and the checks, and tell me
what you were unsure about.
````

````text
Cut the footage in [folder] into a 25-second reel with captions and music. Show me the plan first, then the cut, and check that
nobody is cut off mid-sentence and the B-roll fits what is being said.
````

````text
Make a 20-second reel of only motion graphics (no footage) about [topic] in my brand: big type, one idea per scene, a closing card. Show me the sheet.
````

````text
I have a voice-over recording: [file]. Make a reel of motion graphics timed to it, so each scene changes on the words it shows. Use my recording and its
word timings only; if there are no word timings, tell me what you need.
````

````text
Decide for me: [topic] as a reel. Choose whether it is cut from footage or made of motion graphics from what I really have, and tell me why.
````

````text
Check my comments in the Studio and fix them, then tick them off and say what you changed.
````

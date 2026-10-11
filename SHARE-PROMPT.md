# Share prompt

Two prompts to paste into Claude Code (the terminal, or the Code tab in the Claude desktop app). Claude Code is needed because
Nordle installs a local tool and connects to it. Nordle runs only on your own computer, on Windows, macOS or Linux, for any
business, in any country or language you can write in.

- **Prompt 1** installs Nordle and proves it works. Restart Claude Code when it asks.
- **Prompt 2** is the first session: your brand, your first plan, your first post.

## Prompt 1: install

````text
Install Nordle for me, then show me it works.

Nordle is a local social-media studio that you (Claude) and I use together: you plan the month, design carousels, graphics and
reels (cut from my own footage), write the captions, and check your own work; I look at the results in a browser page and approve,
ask for changes or reject. It runs only on my computer. It is open source (MIT):
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
````

## Prompt 2: first session (after the restart)

````text
Set Nordle up for my business and make my first post. Use the nordle_* tools; start by reading the guide (nordle_get_guide) and
the Nordle skill, and tell me in three lines how we will work.

1. Ask me four things, one message: what my business is and who it is for, my website address, my Instagram handle (if any), and
   the folder with my photos, logo and any footage. Do not guess any of them.
2. Set up my brand: either use the Studio's "Add a brand" wizard (the + Add button in the Studio's left bar) or do it with the tools.
   Draft a short style guide (name, colours, two fonts, voice, handle and website) from what I gave you, show it to me, and change
   it until I say it is right. Then write `facts.json` with ONLY facts I confirm: phone, address, opening hours, names and titles.
   Never invent a fact, a price, a name or a result.
3. Look at my photos before you use them. Catalogue what each one shows in plain words, and mark which show people (so you only
   use a face where I have said that person agreed).
4. Ask what I must never say (rules for my industry and country, things I do not want promised) and put them in the brand's banned
   phrases. If I am in a regulated field such as health, law, finance or property, say so and look in `examples/packs/` for the
   closest wording pack (`plain-claims` suits any business); offer to write me a pack for my own rules. A pack is a writing aid, not
   legal advice, so tell me to check my own rules.
5. Propose next month's posts: ideas first, with a mix of formats, in the calendar. Wait while I approve, edit or reject them in
   the Studio (Plan view). Do not build anything I have not approved.
6. Build the first approved post. Look at your own result as a picture, run the critique and the checks, fix what they find, and
   tell me what you were unsure about. Then tell me where to find it in the Studio.
7. Explain, in under ten lines, how I approve a post, how I ask for changes (the "Request changes" button and what it needs:
   Claude Code signed in on this computer, `claude auth login`), and what Nordle will NOT do on its own (it never posts without me).
8. Ask whether I want to connect a publishing service (Buffer) and a stock-photo library now or later. If now, point me to the
   Studio's Publishing and Stock windows and to `docs/PUBLISHING.md` and `docs/STOCK.md`; I type any keys myself, you never see or
   store them.

Rules: nothing is posted, scheduled or sent anywhere unless I press the button myself. Keep my files in the project folder
Nordle shows me. Tell me when you are guessing.
````

## Prompt for a tester (one paste: install, try it, report back)

````text
I am testing Nordle for its author, so please be a careful, honest tester. Nordle is a local social-media studio that you (Claude) and I use
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
1. Open the sample project (Little Gannet Coffee) in the Studio and look around: Month, Wall, Review, Plan.
2. Ask me for my business and my website, then make my brand with the Studio's "Add a brand" wizard (the + Add button in the left bar).
   Use made-up details if I do not want to share real ones.
3. Plan three post ideas for next month, wait for me to approve them in the Studio, then build one carousel and look at every page as a picture.
   Run the checks and critique, fix what they find, and tell me what you were unsure about.
4. Use "Request changes" once with a comment. If it says Claude Code is not signed in, tell me and note it for the report.
5. Export or schedule nothing outside this computer. Do not enter any real key or password.

Part 3, report. Write `nordle-test-report.md` in a folder outside the Nordle folder, with:
- my operating system, Node, git and ffmpeg versions, and how long install took;
- for every step above: worked / worked with a problem / broke, with what I did, what I saw and what I expected, in plain words;
- anything confusing in the words on screen, anything slow, anything that looked wrong (screenshots of the Studio help);
- what I liked, and the one thing I would change first.
Remove anything private first (real names, keys, local folder names). Then tell me where the file is and how to send it:
open an issue at https://github.com/samuel-d-young/nordle-socials-creator/issues with the report pasted in, or send it to whoever gave me this prompt.

Rules: never post, schedule or send anything for me, keep everything inside the Nordle folder and my Claude settings for the MCP server and skill, and never
claim a step worked when it did not.
````

## Other first messages to try

````text
Run the self-test in docs/SELF-TEST.md: use the Studio on three brands, in a real browser, and write me the report.
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
Check my comments in the Studio and fix them, then tick them off and say what you changed.
````

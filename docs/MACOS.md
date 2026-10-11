# Nordle on a Mac

Works on macOS 12 or newer, Apple Silicon or Intel. Nordle runs only on your computer.

## Install (about five minutes, most of it the browser download)

```bash
# once: Homebrew (https://brew.sh), then the three tools Nordle needs
brew install node ffmpeg git

git clone https://github.com/samuel-d-young/nordle-socials-creator nordle && cd nordle
node setup.mjs --register     # dependencies, the drawing browser (~170 MB), connects Claude Code, copies the skill
node nordle.mjs doctor        # every line should say OK ("Ready.")
node server.mjs --open        # the Studio, at http://127.0.0.1:5400
```

Restart Claude Code after `--register` so the `nordle_*` tools appear (check with `claude mcp get nordle`).

## Mac notes

- The shortcuts that use Ctrl on Windows use **Command** on a Mac (undo, redo, add to a selection, send a comment).
- ffmpeg comes from Homebrew and is never bundled. If `doctor` cannot find it, run `brew install ffmpeg` or set `NORDLE_FFMPEG` to its full path.
- If macOS asks whether Terminal may access a folder (Documents, Desktop, an external drive) when you point Nordle at your photos or footage, say yes.
- If the rendering browser fails to download behind a proxy or VPN, run `npx playwright-core install chromium` yourself and try again.
- The daily calendar runner uses `cron` on a Mac (`node nordle.mjs calendar schedule-install` prints the line to add with `crontab -e`).

## What is tested

Every push runs the whole test suite on Windows, Linux and macOS (GitHub Actions). Linux and Windows pass in full. On the macOS runner the
non-browser tests pass; a few browser-driven tests of the Studio are timing-sensitive on that slow, GPU-less runner and can fail there while the
same steps work by hand. If something behaves oddly on your Mac, run the tester prompt in `SHARE-PROMPT.md` and send the report.

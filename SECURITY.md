# Security

Nordle runs on your own computer and is designed so that web pages and other computers cannot reach your work. It is **not** designed
to keep your work from other programs running as you on the same computer: see "What is not guaranteed" below. This is what is
enforced, and what is not.

## What is enforced

- **Local only.** The server listens on 127.0.0.1. It answers only to the host names `127.0.0.1`, `localhost` and `[::1]` on its
  own port, which stops a web page from pointing its own name at your computer (DNS rebinding).
- **Tokens.** Every `/api` call needs a token. The owner's token is put in the page the server serves at `/`, and Nordle never
  writes it to a file or hands it to Claude's MCP tools. Claude's tools use a different token, written to `.nordle/runtime.json`
  for the MCP server. (A program that can open the page can read the owner's token: see below.)
- **What Claude's token cannot do.** Undo, redo, approve, accept or reject changes, restore a version, change the autonomy setting,
  adopt or discard Explore takes, create projects, or edit the review file directly. Its edits are checked against locks.
- **No cross-site requests.** No CORS headers are sent. Writes must be JSON (uploads: a named binary upload), so another site cannot
  post to the server.
- **Files.** Documents can only refer to files inside their project (no `..`, no drive letters). The server serves project files
  with a locked-down content policy and never serves the `history/`, `review/` or `checks/` folders, in any letter case (file names
  are case-insensitive on Windows and macOS, so `Review/` is `review/`), and it refuses a name that carries a `:` (a drive letter or
  an NTFS stream such as `review::$INDEX_ALLOCATION`) or ends in a dot or a space. The Studio's picture thumbnails follow the same
  rule. The render browser can only read the project folder and the bundled fonts, and cannot reach the network. The one dot-folder
  that is served is `.proxies/`, and only files named `<40 hex digits>.mp4` straight inside it (small copies of footage for the
  timeline player); the notes, waveforms and half-made files beside them are never served. Making a proxy or a waveform of a file
  follows the same path rules as a render: nothing outside the project or its mount.
- **The render browser keeps Chromium's own sandbox.** It decodes pictures, SVGs and fonts that came from elsewhere (a stock
  library, a scanned website, a project you cloned). On Windows and macOS the sandbox is on by default; on Linux it is off unless
  you set `NORDLE_CHROMIUM_SANDBOX=1`, because containers and CI runners usually cannot create the namespaces it needs.
  `NORDLE_NO_CHROMIUM_SANDBOX=1` turns it off everywhere if it stops a browser from starting. (Tested on Windows.)
- **Limits.** Request bodies are capped (1 MB for JSON, 20 MB for an image) and uploads must really be the image type they claim.
- **Stock libraries.** Addresses a library's answer points at must be public https addresses (never this computer or a private
  network); redirects are followed by hand and checked at every hop, and a library's key and other private headers are not sent on
  to a different site by a redirect.
- **Starting Claude Code.** The model name from a project's settings must be a plain name (`sonnet`, `claude-sonnet-4-5`; letters,
  digits and `. _ : [ ] -`) or the run is refused, and a Windows `.cmd` launcher is started without letting `cmd.exe` read the
  arguments as commands.
- **Sign in with Buffer.** OAuth with PKCE as a public client (no secret exists to leak). The code verifier and the `state` stay in this computer's
  memory, a `state` works once, for ten minutes, and only the owner's page can finish a sign-in (`/api/publish/oauth/...` needs the owner's
  token; Claude's token gets 403). Refresh tokens are single use and are renewed in one place under a lock, then saved before use. Tokens live
  only in the publishing settings file (`.nordle/publish.json`), are sent only to Buffer, and never reach a web page. The hosted return page
  (`site/connect/buffer.html`, on GitHub Pages) keeps nothing and forwards only to `127.0.0.1`; `app/oauth-callback.html` is unauthenticated
  static content that holds no token and cannot call the API.

## What is not guaranteed

Locks and the autonomy dial are guard rails for the way Claude normally works with Nordle, through the MCP tools. They are **not a
sandbox** against a program that is already running as you on this computer. In particular:

1. **The owner's token is not secret from this computer.** It is embedded in the page served at `/`, so any process that can open
   `http://127.0.0.1:<port>/` can read it, and so can anything that can read `.nordle/runtime.json` (Claude's own token) or start its
   own server. That means anything that can run a shell as you, **including an AI agent with shell access**, can read the owner's
   token and then has the owner's powers: approving, signing off, publishing, changing settings and keys. The limits on Claude's
   token apply to callers that use the MCP tools or the agent token, not to a shell. If you give an agent a shell on this computer,
   assume it can do what you can do.
2. **The headless build run is a convenience guard, not a sandbox.** "Build it now", automatic builds and Request changes start
   `claude -p` in the project folder with permission to edit files there. It is given only the tools it needs: Nordle's MCP tools,
   file tools, and a shell limited to this install's build commands (`build`, `reel`, `render`, `verify`, `critique`, `check`,
   `packet`, `video`, `cut`, `validate`), the validator and the project's own `specs/` helper scripts, each by full path, and never
   the owner's commands (calendar approval and sign-off, publishing, stock keys, performance import). It is told not to read or
   change `.nordle/`, `calendar.json`, `review/`, `publish/` or `checks/`, and a project's own `.claude` settings are not loaded.
   These are Claude Code permission rules, and they have gaps: a helper script the run is allowed to start is a file the run can
   also rewrite, the build commands run Nordle code on the files they are given, and the owner-only command-line steps are refused
   by an environment variable (`NORDLE_AGENT_RUN=1`) that the run itself controls. Settings in your own Claude Code user settings
   still apply. Text from stock libraries (titles, tags), catalogs, comments, captions and scanned websites can reach the run, in
   the files it reads and in what it is shown; the prompts tell it to treat that text as data and never as instructions, which is a
   request to the model and not a guarantee. Keep `autoBuild` off for projects you do not want built unattended, and review
   everything before you sign it off.
3. **Project files are served without a token.** Everything under `/p/<project>/` that is a project JSON file or a picture, font,
   video or sound (briefs, brand and facts files, the calendar, documents) can be fetched by any process on this computer without
   a token. `history/`, `review/` and `checks/` are not served; the dot-folders (such as `.nordle/`) are not served either.
4. **File names are case-insensitive on Windows and macOS.** The rule that keeps `history/`, `review/` and `checks/` private now
   ignores letter case, but any other check that compares a name as plain text can be fooled the same way on those systems: report
   it if you find one.

## Protecting the repository itself

The `main` branch cannot be deleted or force-pushed, release tags (`v*`) cannot be moved, and a change from anyone but the owner needs a pull request
whose tests pass on Linux and Windows. Secret scanning, Dependabot security updates and private vulnerability reporting are on, and Actions run with
read-only tokens. The rulesets are recorded in [`.github/rulesets/`](.github/rulesets/README.md).

## Reporting a problem

Please report a security problem through GitHub's private vulnerability reporting: on the repository's **Security** tab, choose
**Report a vulnerability**. If that is not available, open an issue that says only that you have a security report, without any
details, and the maintainer will arrange a private way to receive it. Never post exploit details in a public issue.

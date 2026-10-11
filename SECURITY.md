# Security

Nordle runs on your own computer and is designed so that nothing outside it can reach your work. This is what is enforced,
and what is not.

## What is enforced

- **Local only.** The server listens on 127.0.0.1. It answers only to the host names `127.0.0.1`, `localhost` and `[::1]` on its
  own port, which stops a web page from pointing its own name at your computer (DNS rebinding).
- **Tokens.** Every API call needs a token. The owner's token exists only in the page the server serves to your browser. Claude
  gets a different token, written to `.nordle/runtime.json` for the MCP server; it is never given the owner's token.
- **What Claude's token cannot do.** Undo, redo, approve, accept or reject changes, restore a version, change the autonomy setting,
  adopt or discard Explore takes, create projects, or edit the review file directly. Its edits are checked against locks.
- **No cross-site requests.** No CORS headers are sent. Writes must be JSON (uploads: a named binary upload), so another site cannot
  post to the server.
- **Files.** Documents can only refer to files inside their project (no `..`, no drive letters). The server serves project files
  with a locked-down content policy and never serves the `history/` or `review/` folders. The render browser can only read the
  project folder and the bundled fonts, and cannot reach the network. The one dot-folder that is served is `.proxies/`, and only
  files named `<40 hex digits>.mp4` straight inside it (small copies of footage for the timeline player); the notes, waveforms and
  half-made files beside them are never served. Making a proxy or a waveform of a file follows the same path rules as a render:
  nothing outside the project or its mount.
- **Limits.** Request bodies are capped (1 MB for JSON, 20 MB for an image) and uploads must really be the image type they claim.

## What is not

Locks and the autonomy dial are guard rails for the way Claude normally works with Nordle (through the MCP tools). They are
**not a sandbox** against a process that can read your files: anything running as you can read `.nordle/runtime.json` or start
its own server. If you give an agent a shell on this computer, assume it can do what you can do.

## Reporting a problem

This is a private project shared by invitation. Tell the person who invited you.

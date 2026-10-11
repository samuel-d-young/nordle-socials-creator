# Licences of everything Nordle ships or depends on

Rule: MIT / Apache-2.0 / BSD / OFL only in the core. Every asset in the repo gets a line here.
Last audited: 2026-10-05 (Phase 1). Re-audit at Phase 6 before sharing.

## Dependencies

| Package | Licence | Used for | Notes |
|---|---|---|---|
| ajv | MIT | JSON Schema validation | runtime dependency |
| ajv-formats | MIT | `uri` and similar formats | runtime dependency |
| playwright-core | Apache-2.0 | drives the rendering browser | runtime dependency; downloads Chromium on `npx playwright-core install chromium` |
| pngjs | MIT | reads screenshots for the contrast check | runtime dependency |

Planned, not yet added (check the licence of the exact version when adding):

| Package / tool | Expected licence | Notes |
|---|---|---|
| ffmpeg | LGPL / GPL | **never bundled**; the user installs it. Used from the PATH (or NORDLE_FFMPEG) by `src/video/` for the video renderer, run as a separate program with no linking |
| Whisper (any build) | varies | optional, user-installed; Nordle also accepts word-timing JSON from any tool |

Avoided on purpose:

| Package | Why |
|---|---|
| Remotion | free only for individuals and teams of up to 3; paid beyond that |
| @imgly/background-removal | AGPL |
| RMBG background-removal models | non-commercial licences; check any model before use |
| GSAP | its licence has restrictions for tools that compete with visual animation builders (verify before any use) |

## Assets

| Asset | Licence / origin |
|---|---|
| `samples/little-gannet/assets/*.svg` | Original artwork made for this project, MIT |
| `samples/little-gannet/brand.json` and `docs/*.json` | Original, MIT. The brand is fictional |
| `data/platforms.json` | Original data, MIT. Values are approximate and unverified |
| `data/occasions-au.json`, `examples/calendar.example.json` | Original data, MIT. Dates of public holidays and observances are facts, written as rules; each entry names where to confirm it and unsure ones are marked verify |
| Test media (`sources/`) | Generated on demand by `tools/make-sample-media.mjs` from ffmpeg test patterns and sine tones; not stored in git |

Fonts bundled in `fonts/` (variable fonts, latin, latin-ext and vietnamese subsets), copied unmodified from the
`@fontsource-variable/fraunces` and `@fontsource-variable/inter` packages, version 5.3.0, both SIL Open Font License 1.1.
The licence text for each is beside the font (`fonts/fraunces/OFL.txt`, `fonts/inter/OFL.txt`).

## Not allowed in the repo

Music from Epidemic Sound or any licensed library, client photos or logos, anything under `packs/`, and any code
copied from tools whose licence does not allow it (for example members-only or non-commercial tools).

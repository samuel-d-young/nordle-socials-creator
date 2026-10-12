# Licences of everything Nordle ships or depends on

Nordle itself (its code, docs and original sample material) is CC BY 4.0, created by Samuel Young: see LICENSE and ATTRIBUTION.md.
Rule: MIT / Apache-2.0 / BSD / OFL / CC BY only in the core, for what it depends on and ships. Every asset in the repo gets a line here.
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
| `samples/little-gannet/assets/*.svg` | Original artwork made for this project, CC BY 4.0 |
| `samples/little-gannet/brand.json` and `docs/*.json` | Original, CC BY 4.0. The brand is fictional |
| `data/platforms.json` | Original data, CC BY 4.0. Values are approximate and unverified |
| `data/occasions-au.json`, `examples/calendar.example.json` | Original data, CC BY 4.0. Dates of public holidays and observances are facts, written as rules; each entry names where to confirm it and unsure ones are marked verify |
| Test media (`sources/`) | Generated on demand by `tools/make-sample-media.mjs` from ffmpeg test patterns and sine tones; not stored in git |

Fonts bundled in `fonts/` (variable fonts, latin, latin-ext and vietnamese subsets), copied unmodified from the
`@fontsource-variable/fraunces` and `@fontsource-variable/inter` packages, version 5.3.0, both SIL Open Font License 1.1.
The licence text for each is beside the font (`fonts/fraunces/OFL.txt`, `fonts/inter/OFL.txt`).
The Studio's own look also uses `fonts/outfit` (Outfit) and `fonts/doto` (Doto, a dot-matrix face), from the `@fontsource-variable/outfit` and
`@fontsource-variable/doto` packages, version 5.3.0, SIL Open Font License 1.1 (`fonts/outfit/OFL.txt`, `fonts/doto/OFL.txt`). They are not in `fonts/manifest.json`,
so they are only the Studio's, never a brand's. The paper, ink and orange style follows RoboNuggets' RENDER Studio (CC BY 4.0); no code was copied.

## Not allowed in the repo

Music from Epidemic Sound or any licensed library, client photos or logos, anything under `packs/`, and any code
copied from tools whose licence does not allow it (for example members-only or non-commercial tools).

## Credits

The shape of the self-test prompt in `docs/SELF-TEST.md` (Ask, Goal, Examples, Negations, Tools) follows the CRAFT build guide by
RoboNuggets (https://robonuggets.com, CC BY 4.0). No code or text was copied; the wording is our own.

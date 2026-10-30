# Nordle brand kit

Start with **[brand-guide.html](brand-guide.html)** (open it in a browser) or [BRAND-GUIDE.md](BRAND-GUIDE.md).

| Folder | What |
|---|---|
| `logo/svg`, `logo/png` | the mark, the wordmark, the horizontal and stacked lockups: colour, on dark, black, white |
| `favicon` | `favicon.ico`, `favicon.svg`, apple-touch icon, 192 and 512 icons |
| `social` | OG image (light, dark), GitHub social preview, 1500x500 banner, README header, 800 px avatar |
| `tokens` | `nordle-tokens.css` and `nordle-tokens.json`: colour (light and dark), type, space, shadow, motion |

Rebuild everything: `node tools/make-brand-kit.mjs` (needs `npx playwright-core install chromium` once).
Nordle was created by Samuel Young, CC BY 4.0: forks must credit him and use their own name and mark (see `../ATTRIBUTION.md`).

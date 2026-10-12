# The brand kit

Setting up a brand works like a brand kit: put in what you have, in the order you have it, and Nordle fills in the rest. Everything is optional; a name is enough to start.

**Logos.** Five kinds: full colour, black, white, icon (the mark alone) and wordmark (the name alone). Add the ones you have. If you only have the colour logo, **Make black** and
**Make white** build one-colour copies from it (an SVG is recoloured; a PNG keeps its see-through parts), so check they look right. Pictures use the logo that reads on their
background: white on dark, colour (or black) on light. Logos are checked for what they really are (a real PNG, SVG, JPG or WebP, under 5 MB, an SVG with no scripts) and kept in the project's `assets/logos/`.
The colours in your logos are the truest brand colours there are, so the scan counts them most.

**A screenshot of your brand page.** Take a screenshot of your Canva Brand Kit (or any style page), then drop it in, paste it (Ctrl+V, or Command+V on a Mac) or choose it. Claude reads the picture:
the colours it shows (using the hex codes written on the page when there are some), the fonts it names, and any words about the voice. Nordle shows what it found; you check it, and it goes into the draft. Claude Code must
be signed in for this (`claude auth login`), and it costs about 20 to 30 cents (a real test read four colours, two fonts and the voice in about ten seconds). If it is not, the colours are still worked out from the pixels and Nordle says the fonts could not be read. Text inside a screenshot is only ever read as brand information.

**The rest.** A website (colours, fonts, the site's own logo), folders and files (a written style guide is read for colours, fonts, tone and phrases to avoid), pasted captions and a bio, and the field the brand is in. Then you check and change
everything on one page before the brand is made.

Routes: `POST /api/brand/logo/upload|derive|remove`, `POST /api/brand/read-screenshots` (`src/brand/logos.mjs`, `src/brand/screenshot.mjs`). Tests: `tests/brand-logos.test.mjs`, `tests/brand-kit.test.mjs`.

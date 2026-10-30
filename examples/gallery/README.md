# Gallery: what Nordle makes

Everything here was made by Nordle from the **made-up Little Gannet Coffee** sample brand (`samples/little-gannet`): the brand, the
shop, the drinks and the numbers are invented. Each post is one small JSON document; the same document comes out in every size.

| File | What it is |
|---|---|
| `carousel-1-cover.png` ... `carousel-5-visit.png` | A five-page Instagram carousel (4:5), from `samples/little-gannet/docs/spring-menu-carousel.json` |
| `graphic-open-late-4x5.png`, `story-open-late-9x16.png` | One graphic, drawn in two sizes from one document (`open-late-story.json`) |
| `reel-harbour-morning.gif` | A 13-second motion-graphics reel with no footage: kinetic type, a counting number with a drawn ring, a list, bars and a logo sting. The GIF is a small preview; the real file is a 1080 x 1920 mp4 |
| `reel-harbour-morning.json` | The reel spec the reel was made from |

## Make them yourself

```bash
node nordle.mjs render samples/little-gannet --sheet       # the carousel and the graphic, every size, plus a contact sheet each
node server.mjs                                            # first run copies the sample to projects/little-gannet (then stop it)
node nordle.mjs reel projects/little-gannet examples/gallery/reel-harbour-morning.json --sheet     # the cut and a contact sheet, nothing drawn yet
node nordle.mjs reel projects/little-gannet examples/gallery/reel-harbour-morning.json --render    # the mp4 (needs ffmpeg)
node nordle.mjs video render projects/little-gannet/docs/harbour-morning-reel.json --format gif    # a small GIF preview
```

The pictures are drawn by Nordle's own renderer (a browser drawing HTML) with the bundled open fonts, so the same document gives the same pixels
on any computer. See `docs/VIDEO.md` for the video side and the motion kit (`kinetic`, `number`, `list`, `quote`, `bars`, `ticker`, `reveal`, `logo`).

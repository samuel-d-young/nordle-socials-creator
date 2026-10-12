# Stock libraries

Search outside libraries (photos, video, music, sound effects) from Nordle and bring the files you choose into a project, with their licence
written down. Code: `src/stock/*`, command `node nordle.mjs stock`, API `/api/stock/*`, Claude's tools `nordle_stock_*`.

## Three ways a library plugs in

1. **As data (no code).** Any library with a JSON web API is described in a small JSON file: where to search, how the key is sent, and which
   fields of the answer are the id, title, picture and so on (`src/stock/rest.mjs` has the full shape and an example). Ready-made definitions
   for Pexels, Pixabay and Freesound are in `src/stock/presets.mjs`. **They were written from each library's public documentation and have not
   been run against the live services** (no key was available), so they say `verified: false`; the first search with a real key shows whether a
   field has moved, and a definition can be corrected in `.nordle/stock.json` without touching code.
2. **A folder of your own stock.** For sites with no download API (Envato Elements and similar): download in your browser into a folder, then
   `node nordle.mjs stock add my-stock --folder "D:/Stock/Videos" --kinds video`. Files are searched by file and folder name and
   copied (never moved) into the project.
3. **As code.** A file in `src/stock/libraries/` that default-exports `{ id, name, kinds, search(), lookup(), download() }`, for an API that needs
   more than data can say (a login flow, signed requests). `src/stock/libraries/_example.mjs` is the template and documents the contract.

## Claude uses them automatically

A library that is added and ready (a folder that is set, or a key that is saved) and allowed for the brand is listed in the build prompt (`stockBrief` in `src/stock/index.mjs`, `stockLines` in `src/calendar/prompts.mjs`). Claude searches the owner's own folders first, then online libraries only for a shot their own material cannot cover, brings files in with `nordle_stock_get`, and must look at each one (it arrives catalogued "not looked at yet") before using it. Nothing is added for a motion-graphics reel. The owner never picks files. Test: `tests/stock-auto.test.mjs`.

**In setup.** The "Brand added" page at the end of Add a brand has a short form (`app/studio-stock-setup.js`) that adds a folder of the owner's footage or stock through the system folder window: it saves the same folder library the Stock window makes, for that brand (or all brands if ticked), and tests it. Online libraries (a key typed in once) are added in the Stock window, which the page links to. Test: `tests/brand-tutorial.test.mjs` (it uses a temporary `NORDLE_PUBLISH_DIR`, never the real stock settings).

## Use

```
node nordle.mjs stock libraries
echo YOUR_KEY | node nordle.mjs stock key pexels          # after:  node nordle.mjs stock add pexels --preset pexels
node nordle.mjs stock test pexels                         # one small search: does the key work?
node nordle.mjs stock search pexels "dentist waiting room" --kind photo
node nordle.mjs stock get pexels 123456 --project my-brand --kind photo
node nordle.mjs stock add tiny --definition tiny.json     # your own definition (JSON file); then `stock key tiny`
```

Claude has `nordle_stock_libraries`, `nordle_stock_search` and `nordle_stock_get`. It cannot add a library, save a key or test a connection.

## The Studio window ("Stock" in the left rail, beside Publishing)

The owner's way in, so a key never has to go through a chat or a command line (`app/studio-stock.js`, styles in `app/studio.css`, tests in
`tests/studio-stock.test.mjs`). Two tabs. It opens on **Search** when a library is ready, else on **Libraries**.

- **Libraries.** One card per library: its kinds, `Ready` / `Needs an API key` / `Not added`, the library's own note (a sign-up address is plain
  text, never a link), its licence, and a "definition not yet tried with a live key" caution while a definition says `verified: false`. A library not added
  yet has **Add** (a preset). An added one that wants a key has a password box and **Save key**: the key is sent once to `POST /api/stock/settings`, the box
  is emptied and removed, and the card then says only "A key is saved" with **Replace** and **Forget key**. Saving also runs **Test** (one small search) so
  the answer in the card is the library's own plain message, whether it worked or not. **Remove** asks first. Nothing in the page ever holds a saved key:
  `GET /api/stock/libraries` says `takesKey` and `hasKey`, never the key.
- **A folder of your own stock** (the Envato Elements route): the full path of the folder (the placeholder shows an example), a name, what is in it (photos,
  video, music, sound effects) and a licence sentence. It is tested at once (a drive that is not connected says so). A folder cannot take the name of an
  existing library. Two plain sentences on the page explain why Elements needs this and why Envato Market is search only.
- **Search.** Library (only ready ones), kind (only that library's), words. Results are cards: picture, title, author, size, licence, **View on <library>**
  (https page links only, new tab, `rel="noopener noreferrer"`) and **Use in…**, which brings the file into the project chosen in "Use in" (the brand the
  Studio is filtered to, by default) through `POST /api/stock/get` and says, in a note beside Close, where it was saved, under what licence, and that it is
  catalogued as "not looked at yet". A library that cannot download (`canDownload: false`, such as Envato Market) has no **Use in…**, only the link and a line
  saying to buy it there and add the file through a folder library. Paging, an empty state, a spinner (which stops under reduced motion), results read out to
  screen readers, and errors in plain words (a refused key offers the Libraries tab; a limit offers Try again).
- On a phone-width screen the rail is hidden, so (as for Publishing) there is no button to open the window there.

### Thumbnails come through Nordle

The page's content-security policy keeps pictures same-origin, and loading a library's picture directly would tell its server (and CDN) who is looking.
So the cards use `GET /api/stock/thumb?url=` (`src/stock/pictures.mjs`), which fetches the picture through `safeFetch` (https, public hosts, redirects checked),
**only** for an address that was a `thumb` or `preview` in a search result this process returned in the last 30 minutes (anything else is 403: it is not an open
proxy). The answer must be `image/*` (not SVG) and at most 3 MB (counted as it arrives), is kept in memory for 10 minutes (bounded in count and bytes), and is sent
with `cache-control: private, max-age=600` and `nosniff`. Either token may read it; no library key is ever sent to a picture server.

## What a download does

`stock get` saves the file as `<project>/assets/stock/<library>-<id>.<ext>` and:

- writes a line in `assets/stock/licences.json`: library, id, title, author, the item's page, licence text and address, when, and by whom (owner or Claude);
- adds a **catalog entry that says the file has not been looked at yet** (`assets/catalog.json` for photos, `sources/catalog.json` for the rest). The
  picture-matches-the-words checks depend on the catalog, so look at the file and rewrite `shows` (who, what, any signs, logos, other brands, patients)
  before using it. An existing catalog entry is never overwritten;
- does not fetch an item that is already in the project (that would spend the library's allowance).

Photos and clips are ordinary project paths (`assets/stock/...`), so they work anywhere a post names a picture or clip.

## Safety

- The owner adds, changes and removes libraries and keys (owner token, which only the Studio page holds, or the command line on their own machine: refused when `NORDLE_AGENT_RUN=1`).
  Claude can search and bring a file in, which is a designer's job; the owner's key does the searching and allowances are the owner's, so search with
  specific words.
- A key is kept in `.nordle/stock.json` (mode 0600, gitignored), read from standard input, and is never in a result, an error or a log. A key that a
  library wants in the web address is scrubbed from any error.
- Every address a library's answer points at is checked before it is fetched (`src/stock/net.mjs`): https only, no user:password, no localhost or
  private, link-local or loopback addresses, redirects followed by hand a few hops and checked again. The file must be the right kind (a web page saved as
  `photo.jpg` is refused) and under a size cap (photo 60 MB, video 800 MB, music 100 MB, sound 50 MB). DNS is not re-resolved, so this guards against a
  careless or hostile address in an API answer; it is not a firewall.
- **Nordle never buys anything and never signs in to a site for you.** A file that needs a purchase or a login cannot be downloaded; for those, download
  it yourself into a folder library.
- Licences stay the owner's responsibility. Nordle records what the library said; it does not decide what is allowed. Examples: Pexels and Pixabay are
  free for commercial use without credit; Freesound sounds are under a Creative Commons licence that differs per sound (CC BY needs a credit); an
  Envato Elements download must be registered to a project in Envato's own tool. Keep the ledger with the project.
- Nothing from a stock library enters this repository: files live under `projects/` (gitignored). Do not add a library whose terms forbid the use (no
  Epidemic Sound audio in Nordle's own samples; see `LICENSES.md`).

## Envato

Envato's own API (build.envato.com) covers Envato Market (VideoHive, AudioJungle, PhotoDune and so on: items bought one at a time) and its documentation
does not mention Envato Elements (the subscription), which has no public download API that Nordle knows of. So: for **Elements**, download in the browser
into a folder library. For **Market** items, a definition could search with a personal token, but a download is a purchase, which Nordle never does: buy
in the browser, put the file in a folder library. There is no Envato connector in Claude's directory (searched October 2026).

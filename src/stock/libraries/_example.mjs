// A template for a stock library that needs more than a data definition can say (a login flow, a signed request, an odd answer shape).
// Copy it to src/stock/libraries/<your-id>.mjs (a file whose name starts with "_" is never loaded) and fill it in. It is loaded when Nordle
// starts and appears in `node nordle.mjs stock libraries`. Most libraries do not need this: a JSON definition (docs/STOCK.md) is enough.
//
// The contract:
//   id, name, kinds                    which kinds it offers: 'photo' | 'video' | 'music' | 'sfx'
//   configured?(entry)                 true when it can be used (default true); `entry` is what the owner saved for it (key, ...)
//   search({ query, kind, page, perPage }, ctx) -> { items: [ { id, kind, library, title, author, page, thumb, preview, width, height, duration, tags, license, licenseUrl } ], total }
//   lookup?(kind, id, ctx)             -> { raw, item }     one item by id (what download() needs)
//   download(kind, raw, id, ctx)       -> { url, headers? } or { file }       an https address (checked and size-capped by Nordle) or a file to copy
// ctx = { key, entry, fetchImpl }: the owner's saved key and entry, and the fetch to use (tests replace it). Never put a key in a result or an
// error message. Use ctx.fetchImpl for every request. Never buy anything: if a file needs a purchase, throw a plain-language error instead.

import { StockError } from '../net.mjs';

export default {
  id: 'example',
  name: 'Example library',
  kinds: ['photo'],
  note: 'A template: not a real library.',
  configured: () => false,
  async search() { throw new StockError(400, 'This is only a template.'); },
};

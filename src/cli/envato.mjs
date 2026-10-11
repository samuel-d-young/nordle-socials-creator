// node nordle.mjs envato <command> ...   Envato in short: search Envato Market (VideoHive, PhotoDune, AudioJungle) and use the folder where your Envato Elements
// downloads live. It is a shortcut over `nordle stock` (src/stock/*, docs/STOCK.md): the same safety rules apply (the owner saves the key on their own machine,
// from standard input; Nordle never buys and never signs in to Envato). Envato Elements has no API or official command line, so Elements files reach Nordle
// by downloading them in the browser into a folder and adding that folder here.

import stock from './stock.mjs';

const USAGE = `envato <command> ...

  key [--clear]                    save your Envato personal token (from build.envato.com/create-token), read from standard input
  test                             one small search to see whether the token works
  search "words" [--kind video|photo|music|sfx] [--page N]    search Envato Market (default: video = VideoHive); results link to the item to buy
  folder "<full path>" [--kinds video,photo,music,sfx]        add the folder where your Envato Elements (or bought) downloads are, as a library
                                    named envato-elements; then:  node nordle.mjs stock search envato-elements "sunrise beach" --kind video
                                    and  node nordle.mjs stock get envato-elements "<id from the search>" --project <project> --kind video

Nordle never buys: buy or download in your browser, then the file is picked up from the folder. An Elements download must be registered to a project in
Envato's own tool before you publish with it; the licence line Nordle writes says so.`;

export default {
  name: 'envato',
  usage: 'envato <key|test|search|folder> ...',
  summary: 'Envato Market search and your Envato downloads folder (shortcut over `stock`)',
  async run(args) {
    const [cmd, ...rest] = args;
    switch (cmd) {
      case 'key': return stock.run(['key', 'envato-market', ...rest]);
      case 'test': return stock.run(['test', 'envato-market']);
      case 'search': {
        if (!rest.length) { console.error('Usage: envato search "words" [--kind video|photo|music|sfx]'); return 2; }
        const withKind = rest.includes('--kind') ? rest : [...rest, '--kind', 'video'];
        return stock.run(['search', 'envato-market', ...withKind]);
      }
      case 'folder': {
        const [path, ...more] = rest;
        if (!path || path.startsWith('--')) { console.error('Usage: envato folder "<full path of the folder>" [--kinds video,photo,music,sfx]'); return 2; }
        return stock.run(['add', 'envato-elements', '--folder', path, '--name', 'Envato Elements (my downloads)',
          '--license', 'Envato Elements licence: register each download to a project in Envato’s own tool before publishing', ...more]);
      }
      default: console.log(USAGE); return cmd ? 2 : 0;
    }
  },
};

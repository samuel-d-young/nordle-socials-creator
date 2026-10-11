// Ready-made definitions for stock libraries that have a free API key. They are DATA (see rest.mjs): the owner picks one and pastes a key.
// Written from each library's public API documentation and NOT yet run against the live services (no key was available when they were
// written), so each says `verified: false`; the first search with a real key shows whether a field has moved, and the definition can be
// corrected in .nordle/stock.json without touching code. Nothing here is a paid library: Nordle never buys anything.

export const PRESETS = {
  pexels: {
    id: 'pexels', name: 'Pexels', kinds: ['photo', 'video'], verified: false,
    note: 'Free photos and videos. Get a key at pexels.com/api.',
    auth: { in: 'header', name: 'Authorization' },
    license: 'Pexels licence: free to use, no attribution needed; do not resell the files as they are.', licenseUrl: 'https://www.pexels.com/license/',
    search: {
      photo: { url: 'https://api.pexels.com/v1/search?query={query}&per_page={perPage}&page={page}', itemsPath: 'photos', totalPath: 'total_results',
        map: { id: 'id', title: 'alt', author: 'photographer', page: 'url', thumb: 'src.medium', preview: 'src.large', width: 'width', height: 'height' } },
      video: { url: 'https://api.pexels.com/videos/search?query={query}&per_page={perPage}&page={page}', itemsPath: 'videos', totalPath: 'total_results',
        map: { id: 'id', title: 'url', author: 'user.name', page: 'url', thumb: 'image', width: 'width', height: 'height', duration: 'duration' } },
    },
    item: { photo: { url: 'https://api.pexels.com/v1/photos/{id}' }, video: { url: 'https://api.pexels.com/videos/videos/{id}' } },
    download: {
      photo: { urlPath: 'src.original' },
      video: { listPath: 'video_files', urlKey: 'link', where: { file_type: 'video/mp4' }, sortKey: 'width', max: 2160 },
    },
  },
  pixabay: {
    id: 'pixabay', name: 'Pixabay', kinds: ['photo', 'video'], verified: false,
    note: 'Free photos and videos. Get a key at pixabay.com/api/docs. (Its music is not offered through the API.)',
    auth: { in: 'query', name: 'key' },
    license: 'Pixabay Content Licence: free for commercial use, no attribution needed.', licenseUrl: 'https://pixabay.com/service/license-summary/',
    search: {
      photo: { url: 'https://pixabay.com/api/?q={query}&per_page={perPage}&page={page}&image_type=photo', itemsPath: 'hits', totalPath: 'totalHits',
        map: { id: 'id', title: 'tags', author: 'user', page: 'pageURL', thumb: 'webformatURL', preview: 'largeImageURL', width: 'imageWidth', height: 'imageHeight', tags: 'tags' } },
      video: { url: 'https://pixabay.com/api/videos/?q={query}&per_page={perPage}&page={page}', itemsPath: 'hits', totalPath: 'totalHits',
        map: { id: 'id', title: 'tags', author: 'user', page: 'pageURL', duration: 'duration', width: 'videos.large.width', height: 'videos.large.height', tags: 'tags' } },
    },
    item: { photo: { url: 'https://pixabay.com/api/?id={id}', itemPath: 'hits.0' }, video: { url: 'https://pixabay.com/api/videos/?id={id}', itemPath: 'hits.0' } },
    download: { photo: { urlPath: 'largeImageURL' }, video: { urlPath: 'videos.large.url' } },
  },
  unsplash: {
    id: 'unsplash', name: 'Unsplash', kinds: ['photo'], verified: false,
    note: 'Free photos. Get an Access Key at unsplash.com/developers (a new app is limited to a small number of searches an hour until Unsplash approves it).',
    auth: { in: 'header', name: 'Authorization', prefix: 'Client-ID ' },
    license: 'Unsplash licence: free to use, no permission or credit needed (a credit is appreciated); do not sell the photos as they are.', licenseUrl: 'https://unsplash.com/license',
    search: {
      photo: { url: 'https://api.unsplash.com/search/photos?query={query}&per_page={perPage}&page={page}', itemsPath: 'results', totalPath: 'total',
        map: { id: 'id', title: 'alt_description', author: 'user.name', page: 'links.html', thumb: 'urls.small', preview: 'urls.regular', width: 'width', height: 'height' } },
    },
    item: { photo: { url: 'https://api.unsplash.com/photos/{id}' } },
    download: { photo: { urlPath: 'urls.full' } },
  },
  // Envato Market sells each item (VideoHive, PhotoDune, AudioJungle). Nordle only SEARCHES it (no `item`/`download`: it never buys). The owner buys in the
  // browser and puts the file in a folder library. Envato Elements (the subscription) has no API at all. Field names are from memory of the public
  // discovery endpoint and unverified: the first test with a personal token (build.envato.com/create-token) shows what has moved.
  'envato-market': {
    id: 'envato-market', name: 'Envato Market', kinds: ['photo', 'video', 'music', 'sfx'], verified: false,
    note: 'Search only: results link to the item on Envato, where you buy it; then put the file in a folder library. Nordle never buys. Elements (the subscription) has no API. Personal token from build.envato.com/create-token.',
    auth: { in: 'header', name: 'Authorization', prefix: 'Bearer ' },
    license: 'Envato Market licence: bought per item and registered to one project (see the item page).', licenseUrl: 'https://themeforest.net/licenses/standard',
    search: Object.fromEntries([['photo', 'photodune.net'], ['video', 'videohive.net'], ['music', 'audiojungle.net'], ['sfx', 'audiojungle.net']].map(([kind, site]) => [kind, {
      url: `https://api.envato.com/v1/discovery/search/search/item?site=${site}&term={query}&page_size={perPage}&page={page}`, itemsPath: 'matches', totalPath: 'total_hits',
      map: { id: 'id', title: 'name', author: 'author_username', page: 'url', thumb: 'previews.thumbnail_preview.small_url', preview: 'previews.landscape_preview.landscape_url', tags: 'tags' },
    }])),
  },
  freesound: {
    id: 'freesound', name: 'Freesound', kinds: ['sfx', 'music'], verified: false,
    note: 'Sound effects and sounds, each with its own Creative Commons licence (some need a credit: the ledger keeps it). Get a key at freesound.org/apiv2/apply. Downloads are the high-quality preview (the original needs a login Nordle does not do).',
    auth: { in: 'query', name: 'token' },
    license: 'Creative Commons: the licence differs per sound (see its page); CC BY needs a credit.', licenseUrl: 'https://freesound.org/help/faq/#licenses',
    search: Object.fromEntries(['sfx', 'music'].map((kind) => [kind, {
      url: 'https://freesound.org/apiv2/search/text/?query={query}&page_size={perPage}&page={page}&fields=id,name,username,url,duration,license,tags,previews', itemsPath: 'results', totalPath: 'count',
      map: { id: 'id', title: 'name', author: 'username', page: 'url', preview: 'previews.preview-hq-mp3', duration: 'duration', license: 'license', tags: 'tags' },
    }])),
    item: Object.fromEntries(['sfx', 'music'].map((kind) => [kind, { url: 'https://freesound.org/apiv2/sounds/{id}/?fields=id,name,username,url,duration,license,tags,previews' }])),
    download: Object.fromEntries(['sfx', 'music'].map((kind) => [kind, { urlPath: 'previews.preview-hq-mp3' }])),
  },
};

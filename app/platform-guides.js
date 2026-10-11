// How to get an API key (or why there is none) for each stock and publishing platform the Studio can set up. Plain steps, written from what each
// service publishes about its own API. Menus move: every guide says so, and says plainly when a service has NO key for ordinary customers
// (then the way in is a folder of downloads for stock, or Buffer / the export folder for posting).

import { h } from './dom.js';

/** Stock libraries. `key: true` = a key goes in the box. `key: false` = there is no personal key: the guide says what to do instead. */
export const STOCK_GUIDES = {
  pexels: { name: 'Pexels', key: true, url: 'pexels.com/api', cost: 'Free', offers: 'photos and video',
    steps: ['Make a free account at pexels.com (or sign in).', 'Open pexels.com/api and fill in the short form about what you will use it for.', 'The key is shown straight away. Copy it and paste it into the box below.'] },
  pixabay: { name: 'Pixabay', key: true, url: 'pixabay.com/api/docs', cost: 'Free', offers: 'photos and video',
    steps: ['Make a free account at pixabay.com (or sign in).', 'Open pixabay.com/api/docs while signed in: your key is shown on that page.', 'Copy it and paste it into the box below.'] },
  freesound: { name: 'Freesound', key: true, url: 'freesound.org/apiv2/apply', cost: 'Free', offers: 'sound effects and sounds',
    steps: ['Sign in at freesound.org (make a free account if you have none).', 'Open freesound.org/apiv2/apply and create an API credential: a name and one line about how you will use it.', 'Copy the secret / API key it gives you and paste it into the box below.'],
    note: 'Each sound has its own Creative Commons licence; some need a credit, and Nordle writes it down.' },
  'envato-market': { name: 'Envato Market', key: true, url: 'build.envato.com/create-token', cost: 'Free to search',
    offers: 'photos, video, music and sound effects (search only: you buy on Envato)',
    steps: ['Sign in at envato.com.', 'Open build.envato.com/create-token and give the token a name.', 'Tick only the permission that lets it view and search Envato sites, then create it.', 'Copy the token and paste it into the box below.'],
    note: 'Nordle only searches. Buy the item on Envato yourself, then put the file in a folder library.' },
  unsplash: { name: 'Unsplash', key: true, url: 'unsplash.com/developers', cost: 'Free', offers: 'photos',
    steps: ['Make a free account at unsplash.com (or sign in).', 'Open unsplash.com/developers and choose New Application. Accept the guidelines and name it.', 'Copy the Access Key (not the Secret key) and paste it into the box below.'],
    note: 'A new app is limited to a small number of searches an hour until Unsplash approves it.' },
};

/** Sites with no personal key. Epidemic Sound is the one most people ask about. */
export const STOCK_NO_KEY = {
  epidemic: { name: 'Epidemic Sound', key: false, url: 'epidemicsound.com', offers: 'music and sound effects',
    why: 'Epidemic Sound does not give subscribers an API key. Its API is for partner companies, so Nordle cannot search it or download from it.',
    steps: ['In your Epidemic Sound account, download the tracks you want into one folder (for example the music folder you already use).', 'Add that folder below under “A folder of your own stock” and tick Music.', 'Nordle then searches it by file name and copies the track you pick into a post’s project. It never downloads from Epidemic for you.'] },
  'envato-elements': { name: 'Envato Elements', key: false, url: 'elements.envato.com', offers: 'photos, video, music, sound effects',
    why: 'Envato Elements (the subscription) has no API for customers, so it cannot be searched from another app.',
    steps: ['Download what you want from Envato Elements in your browser into a folder.', 'Add that folder below under “A folder of your own stock”.', 'Register each download to a project in Envato’s own tool: Nordle records the licence line you write.'] },
  artlist: { name: 'Artlist', key: false, url: 'artlist.io', offers: 'music, sound effects, footage',
    why: 'Artlist does not offer a key to customers, as far as its site says.',
    steps: ['Download what you want into a folder.', 'Add the folder below under “A folder of your own stock”.'] },
  storyblocks: { name: 'Storyblocks', key: false, url: 'storyblocks.com', offers: 'video, music, photos',
    why: 'Storyblocks gives API access to business partners (you apply to them), not to ordinary subscribers.',
    steps: ['Download what you want into a folder.', 'Add the folder below under “A folder of your own stock”. If you do get partner API access later, ask for it to be added as a library.'] },
  'adobe-stock': { name: 'Adobe Stock', key: false, url: 'developer.adobe.com', offers: 'photos, video, music',
    why: 'Adobe issues Adobe Stock API keys through its developer console and licensing through the API needs an agreement with Adobe. Nordle does not have it built in.',
    steps: ['License the files in Adobe Stock as usual and download them into a folder.', 'Add the folder below under “A folder of your own stock”.'] },
  shutterstock: { name: 'Shutterstock', key: false, url: 'shutterstock.com/developers', offers: 'photos, video, music',
    why: 'Shutterstock’s API is for registered developers on a paid plan; it is not set up here.',
    steps: ['License and download the files into a folder.', 'Add the folder below under “A folder of your own stock”.'] },
};

const NOT_POSTING = 'Nordle cannot post through this one yet. Save the key here so it is ready; until then Buffer or the export folder does the posting.';
const LOOK = 'Menus change, so if you cannot find it: sign in, open the account or developer settings and look for “API”, “Integrations” or “Developers”. If there is nothing, the plan may not include API access: ask the service’s support.';

/** Publishing platforms. key:true takes a key now; key:false is a guide only. */
export const PUBLISH_GUIDES = {
  sprout: { name: 'Sprout Social', key: true, url: 'sproutsocial.com', offers: 'scheduling', note: NOT_POSTING,
    steps: ['Sign in to Sprout Social as an admin.', 'Look in Settings for the API or Integrations area and create an API token.', 'Copy the token and paste it into the box below.', LOOK] },
  hootsuite: { name: 'Hootsuite', key: true, url: 'developer.hootsuite.com', offers: 'scheduling', note: NOT_POSTING,
    steps: ['Sign in at developer.hootsuite.com with your Hootsuite login.', 'Create an app. Hootsuite gives it a client ID and client secret (it signs in with OAuth rather than one simple key).', 'Paste the client secret into the box below if you only need it saved; the full sign-in is not built into Nordle yet.', LOOK] },
  later: { name: 'Later', key: true, url: 'later.com', offers: 'scheduling', note: NOT_POSTING,
    steps: ['Sign in to Later.', 'Look for API access in your account settings. Later gives it to some plans only, or on request.', 'Copy the key or token and paste it into the box below.', LOOK] },
  metricool: { name: 'Metricool', key: true, url: 'metricool.com', offers: 'scheduling and analytics', note: NOT_POSTING,
    steps: ['Sign in to Metricool.', 'Open your account settings and look for the API or integrations section: it gives you a token.', 'Copy the token and paste it into the box below.', LOOK] },
  publer: { name: 'Publer', key: true, url: 'publer.io', offers: 'scheduling', note: NOT_POSTING,
    steps: ['Sign in to Publer.', 'Open Settings and look for API keys (some plans only).', 'Create a key, copy it and paste it into the box below.', LOOK] },
  planable: { name: 'Planable', key: true, url: 'planable.io', offers: 'planning and approvals', note: NOT_POSTING,
    steps: ['Sign in to Planable as an admin.', 'Look in your workspace or account settings for API access.', 'Copy the key or token and paste it into the box below.', LOOK] },
  googlebusiness: { name: 'Google Business Profile', key: false, url: 'business.google.com', offers: 'posts on your Google listing',
    why: 'Google does not give out a simple key for posting to a Business Profile. Its API needs approved access and a Google sign-in (OAuth), which Nordle does not do.',
    steps: ['The practical way in is Buffer: if your Buffer plan lets you connect a Google Business Profile channel, connect it there.', 'Nordle posts to Instagram and Facebook channels through Buffer today. A Google channel needs Google-specific post fields that have not been built or tried yet, so for now use the export folder and paste the post into Google.'] },
};

/** The guide as a block: what it is, numbered steps, where to go, and a note. `keyArea` (the box and button) goes under the steps. */
export function guideBlock(g, keyArea) {
  return h('div', { class: 'pg' },
    h('p', { class: 'pg-top' }, h('b', {}, g.name), g.cost ? h('span', { class: 'pg-chip' }, g.cost) : null, g.offers ? h('span', { class: 'muted' }, ` · ${g.offers}`) : null),
    g.why ? h('p', { class: 'pg-why' }, g.why) : null,
    h('ol', { class: 'pg-steps' }, g.steps.map((s) => h('li', {}, s))),
    // plain text on purpose: nothing in the Studio links out (copy the address into your browser)
    g.url ? h('p', { class: 'pg-url muted' }, 'Go to: ', h('b', { class: 'pg-addr' }, g.url)) : null,
    g.note ? h('p', { class: 'pg-note muted' }, g.note) : null,
    keyArea ?? null);
}

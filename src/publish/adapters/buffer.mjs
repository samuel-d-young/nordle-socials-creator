// The Buffer adapter. Buffer's public API is GraphQL at https://api.buffer.com, authenticated with an API key made in Buffer
// (Settings > API) and sent as `Authorization: Bearer <key>`. What the docs say, and what we have NOT been able to check against
// the live service, is in docs/PUBLISHING.md. The two facts that shape this file:
//   * Buffer has no upload endpoint. A picture or video must be a public, direct, HTTPS address that stays up until the post
//     goes out (Buffer fetches it at publishing time, maybe days later). So the adapter points Buffer at the export folder
//     (adapters/bundle.mjs) hosted at `options.mediaBaseUrl`, and checks that every address answers before it asks Buffer.
//   * GraphQL answers HTTP 200 even for most failures: success is `data.createPost.post`, failure is `data.createPost.message`
//     (MutationError) or an `errors` array with extensions.code (UNAUTHORIZED, RATE_LIMIT_EXCEEDED, ...). Only the rate limit
//     is a real 429, with Retry-After.
// `fetch` is injectable (tests use a fake server on 127.0.0.1); the API address is a constructor option, never a setting, so a
// saved token can only ever go where the code says.

import { PublishError, recordAllowance, redact, waitWords } from '../store.mjs';
import { bundleFileName, bundleFolderName, exportBundle } from './bundle.mjs';
import { keyFor, uploadAll } from '../hosting.mjs';
import { join } from 'node:path';

export const BUFFER_API = 'https://api.buffer.com';
const INSTAGRAM_CAPTION_LIMIT = 2196;     // Buffer's character-limits guide: Instagram post text; a line break counts as 2
const MAX_CAROUSEL = 20;
const SERVICES = ['instagram', 'facebook'];   // the channel types Nordle has been written for (the rest are blocked, not guessed)
const STORIES = false;                    // the Instagram `story` type is not verified: stories use the export folder for now

const Q_ORGS = 'query GetOrganizations { account { organizations { id name } } }';
const q_channels = (orgId) => `query GetChannels { channels(input: { organizationId: ${JSON.stringify(String(orgId))} }) { id name service isDisconnected isLocked } }`;
const M_CREATE = 'mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }';

const M_DELETE = 'mutation DeletePost($input: DeletePostInput!) { deletePost(input: $input) { __typename ... on DeletePostSuccess { id } ... on MutationError { message } } }';
const Q_ONE = 'query One($id: PostId!) { post(input: { id: $id }) { id text status dueAt channelService schedulingType assets { __typename type source thumbnail mimeType ... on VideoAsset { video { thumbnailOffset title } } } metadata { __typename ... on InstagramPostMetadata { type shouldShareToFeed firstComment } ... on FacebookPostMetadata { type firstComment } } } }';
const M_EDIT_DUE = 'mutation EditPost($input: EditPostInput!) { editPost(input: $input) { __typename ... on PostActionSuccess { post { id dueAt status } } ... on MutationError { message } } }';

const Q_POSTS = (metrics, text) => `query ListPosts($org: OrganizationId!, $after: String, $filter: PostsFiltersInput) { posts(first: 100, after: $after, input: { organizationId: $org, filter: $filter, sort: [{ field: dueAt, direction: desc }] }) { edges { node { id channelId channelService status dueAt sentAt${text ? ' createdAt text' : ''}${metrics ? ' metricsUpdatedAt metrics { type value unit }' : ''} } } pageInfo { hasNextPage endCursor } } }`;

/** Buffer's RateLimit header: `"100-in-15min"; r=83; t=73, "250-in-1day"; r=128; t=66998, ...` -> { '15min': {left, resetsIn}, '1day': ..., '30days': ... } */
export function parseRateLimit(header) {
  const out = {};
  for (const m of String(header ?? '').matchAll(/"(\d+)-in-([a-z0-9]+)";\s*r=(\d+);\s*t=(\d+)/gi)) out[m[2]] = { limit: Number(m[1]), left: Number(m[3]), resetsIn: Number(m[4]) };
  return out;
}

const instagramLength = (text) => String(text).length + (String(text).match(/\n/g)?.length ?? 0);

/**
 * @param {{fetch?: typeof fetch, apiUrl?: string, timeoutMs?: number, allowHttpMedia?: boolean}} opts
 */
export function createBufferAdapter({ fetch: fetchImpl, apiUrl = BUFFER_API, timeoutMs = 30000, allowHttpMedia = false } = {}) {
  const doFetch = (...a) => (fetchImpl ?? globalThis.fetch)(...a);

  /** One GraphQL request. Returns `data`, or throws a PublishError that says what to do. */
  async function gql(settings, query, variables, { mutation = false, onHeaders } = {}) {
    if (!settings.token) throw new PublishError(400, 'Buffer is not connected yet: add your Buffer API key in the publishing settings.', { code: 'not-configured' });
    let res;
    try {
      res = await doFetch(apiUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new PublishError(502, `Could not reach Buffer (${redact(e.message, settings.token)}).${mutation ? ' The post may or may not have been created: look in Buffer before trying again.' : ''}`, { code: 'network', uncertain: mutation });
    }
    onHeaders?.(res.headers);
    if (settings.account?.id) recordAllowance(settings.account.id, parseRateLimit(res.headers.get('ratelimit')));   // remember what Buffer says is left
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    if (res.status === 429) throw new PublishError(429, `Buffer's rate limit is used up. Try again in ${Number.isFinite(retryAfter) ? waitWords(retryAfter) : 'a while'}; nothing further was sent.`, { code: 'rate-limit', retryAfter: Number.isFinite(retryAfter) ? retryAfter : null });
    if (res.status === 401 || res.status === 403) throw new PublishError(401, 'Buffer did not accept the API key. Make a new one in Buffer (Settings > API) and save it in the publishing settings.', { code: 'auth' });
    let json = null;
    const text = await res.text().catch(() => '');
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || !json) throw new PublishError(502, `Buffer answered ${res.status} with something unexpected: ${redact(text, settings.token).slice(0, 200)}`, { code: 'bad-response', uncertain: mutation });
    if (Array.isArray(json.errors) && json.errors.length && !json.data?.createPost) {
      const e = json.errors[0], code = e.extensions?.code;
      if (code === 'RATE_LIMIT_EXCEEDED') throw new PublishError(429, `Buffer's rate limit is used up (${e.extensions?.window ?? 'window unknown'}). Try again later; nothing further was sent.`, { code: 'rate-limit', retryAfter: Number.isFinite(retryAfter) ? retryAfter : null });
      if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') throw new PublishError(401, `Buffer refused: ${redact(e.message, settings.token)}. Check the API key.`, { code: 'auth' });
      throw new PublishError(502, `Buffer said: ${redact(e.message ?? code ?? 'an error', settings.token)}`, { code: code ?? 'graphql', uncertain: mutation && code === 'UNEXPECTED' });
    }
    return json.data;
  }

  /** A public address for one exported file, under the media web address the owner set. */
  const mediaUrl = (post, media, settings) => {
    const base = String(settings.options?.mediaBaseUrl ?? '').replace(/\/+$/, '');
    return `${base}/${encodeURIComponent(post.project)}/${encodeURIComponent(bundleFolderName(post))}/${encodeURIComponent(media.file)}`;
  };

  /** Does Buffer's future fetch have a chance? HEAD (or a one-byte GET if HEAD is refused), no redirects, an image or video type. */
  async function probe(url) {
    const tryOnce = async (method) => doFetch(url, { method, redirect: 'manual', headers: method === 'GET' ? { range: 'bytes=0-0' } : {}, signal: AbortSignal.timeout(15000) });
    let res;
    try {
      res = await tryOnce('HEAD');
      if ([403, 405, 501].includes(res.status)) res = await tryOnce('GET');
    } catch (e) { return `${url} could not be reached (${e.message})`; }
    if (res.status >= 300 && res.status < 400) return `${url} redirects: Buffer needs the address of the file itself`;
    if (res.status >= 400) return `${url} answered ${res.status}`;
    const type = String(res.headers.get('content-type') ?? '');
    if (!/^(image|video)\//i.test(type)) return `${url} is not a picture or video (it says ${type || 'nothing'})`;
    return null;
  }

  const instagramType = (post) => (post.format === 'reel' ? 'reel' : 'post');
  const facebookType = (post) => (post.format === 'reel' ? 'reel' : 'post');   // Buffer refuses a Facebook post with no type (post, story or reel)

  return {
    id: 'buffer',
    name: 'Buffer',
    marksScheduled: true,
    stories: true,             // can also post a Story of a post (Instagram and Facebook channels)
    coverFrame: true,          // is told which frame of a video is its cover (a time in the video)
    needsAccount: true,        // a brand must publish through a saved Buffer login (API key)
    needsChannel: true,        // and say which of that login's channels it posts to
    accountName: 'Buffer',

    /** state = { accounts:[{id,label,configured,channelCache}], brands:{<project>:{account,channels}}, options } */
    describe(state = {}) {
      const accounts = state.accounts ?? [];
      const needs = [];
      if (!accounts.some((a) => a.configured)) needs.push('A Buffer account: an API key from Buffer (Settings > API), saved in the publishing settings');
      if (!Object.values(state.brands ?? {}).some((b) => b.channels?.length)) needs.push('The Buffer channels each brand posts to');
      if (!state.options?.mediaBaseUrl) needs.push('Somewhere public for the pictures and video: set up media hosting (a bucket Nordle uploads to) or the web address where the export folders are hosted. Buffer reads pictures from web addresses; it has no upload');
      const seen = new Map();
      for (const a of accounts) for (const c of a.channelCache ?? []) if (!seen.has(c.id)) seen.set(c.id, { id: c.id, name: c.name, service: c.service });
      return {
        configured: accounts.some((a) => a.configured),
        needs,
        channels: [...seen.values()],
        note: 'Schedules each post in Buffer for its calendar date and time, to every channel its brand has switched on (one Buffer login per brand if you like). Buffer takes pictures and videos only as public HTTPS addresses, so use the export folder: host it at the media web address and Nordle checks every address before it asks Buffer. Only signed-off posts are sent, only by the owner.',
      };
    },

    /** Option values the owner may set (checked before they are saved). */
    validateOptions(options = {}) {
      const out = {};
      if (options.mediaBaseUrl !== undefined && options.mediaBaseUrl !== null && options.mediaBaseUrl !== '') {
        let u;
        try { u = new URL(String(options.mediaBaseUrl)); } catch { throw new PublishError(400, 'The media web address must be a full address, like https://media.example.com/nordle'); }
        if (u.protocol !== 'https:' && !(allowHttpMedia && u.protocol === 'http:')) throw new PublishError(400, 'The media web address must start with https:// (Buffer only fetches HTTPS).');
        if (u.username || u.password || u.search || u.hash) throw new PublishError(400, 'The media web address must be a plain address (no password, query or #).');
        out.mediaBaseUrl = u.toString().replace(/\/+$/, '');
      } else if (options.mediaBaseUrl !== undefined) out.mediaBaseUrl = null;
      if (options.schedulingType !== undefined) {
        if (!['automatic', 'notification'].includes(options.schedulingType)) throw new PublishError(400, 'schedulingType is "automatic" (Buffer publishes it) or "notification" (Buffer reminds you to).');
        out.schedulingType = options.schedulingType;
      }
      if (options.saveToDraft !== undefined) out.saveToDraft = options.saveToDraft === null ? null : !!options.saveToDraft;
      if (options.organizationId !== undefined) out.organizationId = options.organizationId === null || options.organizationId === '' ? null : String(options.organizationId).slice(0, 80);
      for (const k of Object.keys(options)) if (!['mediaBaseUrl', 'schedulingType', 'saveToDraft', 'organizationId'].includes(k)) throw new PublishError(400, `Unknown Buffer option "${k}". Options: mediaBaseUrl, schedulingType, saveToDraft, organizationId.`);
      return out;
    },

    /** Organisations, then the channels of each (or only the chosen organisation's). Network. */
    async listChannels(settings) {
      let orgs;
      const orgId = settings.organizationId ?? settings.options?.organizationId;
      if (orgId) orgs = [{ id: orgId }];
      else orgs = (await gql(settings, Q_ORGS))?.account?.organizations ?? [];
      const out = [];
      for (const org of orgs) {
        for (const c of (await gql(settings, q_channels(org.id)))?.channels ?? []) out.push({ id: c.id, name: c.name, service: c.service, disconnected: !!c.isDisconnected, locked: !!c.isLocked, organizationId: org.id });
      }
      return out;
    },

    /**
     * Posts Buffer holds for some channels of one organisation (one request per 100 posts, newest due first), read only. `filter` is Buffer's PostsFiltersInput
     * (status, dueAt {start,end}, ...). Stops early, saying so, when the 15-minute or daily request allowance runs low. Returns { posts, pages, complete, rate }.
     */
    async listPosts(settings, { organizationId, channelIds, filter = {}, metrics = false, text = false, maxPages = 8 } = {}) {
      if (!organizationId || !channelIds?.length) return { posts: [], pages: 0, complete: true, rate: {} };
      const posts = [];
      let after = null, pages = 0, rate = {}, complete = true, stopped = null;
      for (;;) {
        const data = await gql(settings, Q_POSTS(metrics, text), { org: organizationId, after, filter: { channelIds, ...filter } }, { onHeaders: (h) => { rate = parseRateLimit(h.get('ratelimit')); } });
        const conn = data?.posts;
        for (const e of conn?.edges ?? []) {
          const n = e.node;
          posts.push({ id: String(n.id), channelId: String(n.channelId), service: n.channelService ?? null, status: n.status, dueAt: n.dueAt ?? null, sentAt: n.sentAt ?? null, ...(text ? { text: n.text ?? '', createdAt: n.createdAt ?? null } : {}),
            ...(metrics ? { metricsUpdatedAt: n.metricsUpdatedAt ?? null, m: Object.fromEntries((n.metrics ?? []).map((x) => [x.type, x.value])) } : {}) });
        }
        pages++;
        if (!conn?.pageInfo?.hasNextPage) break;
        if (pages >= maxPages) { complete = false; stopped = `stopped after ${pages} pages`; break; }
        if ((rate['15min']?.left ?? 99) < 10 || (rate['1day']?.left ?? 99) < 25) { complete = false; stopped = "Buffer's request allowance is running low"; break; }
        after = conn.pageInfo.endCursor;
      }
      return { posts, pages, complete, rate, ...(stopped ? { stopped } : {}) };
    },

    /** Everything that can be known without the network: what would stop Buffer taking this post. */
    async plan(post, { settings } = {}) {
      const blockers = [], warnings = [];
      const add = (code, message) => blockers.push({ code, message });
      // (the plan step itself says "Connect a Buffer account for <brand>" and "Choose the channels", so only this channel is looked at here)
      const channel = post.channel;
      const cached = (settings.channelCache ?? []).find((c) => c.id === channel?.id);
      if (!channel?.id) { /* nothing more to say about a channel that is not there */ }
      else if (cached?.disconnected) add('channel-disconnected', `The Buffer channel "${cached.name}" is disconnected: reconnect it in Buffer.`);
      else if (cached?.locked) add('channel-locked', `The Buffer channel "${cached.name}" is locked in Buffer (plan limit).`);
      if (!settings.options?.mediaBaseUrl) add('no-public-url', 'Buffer needs a public web address for each picture and video, and no media web address is set. Use the export folder and host it, or upload by hand in Buffer. (A tunnel option does not exist yet.)');
      if (post.format === 'story' && !STORIES && post.variant !== 'story') add('story-unsupported', 'Stories are not scheduled through Buffer yet: use the export folder and add the story in Buffer.');
      const service = channel?.service ?? cached?.service ?? null;
      if (service && !SERVICES.includes(service)) add('service-unsupported', `Nordle sends to Instagram and Facebook channels through Buffer, not to ${service} yet: use the export folder for this one.`);
      if (post.variant === 'story') {
        warnings.push(post.format === 'reel' ? 'Story: the video is shared again as a Story (a Story is at most 60 seconds, so a longer video is cut).' : 'Story: only the first picture goes in the Story, and a 4:5 picture shows with bars above and below (a Story is 9:16).');
      } else if (service === 'instagram' || !service) {
        if (instagramLength(post.caption) > INSTAGRAM_CAPTION_LIMIT) add('caption-too-long', `The caption is ${instagramLength(post.caption)} characters (a line break counts as 2) and Instagram takes ${INSTAGRAM_CAPTION_LIMIT}.`);
      }
      if (service === 'facebook' && post.format === 'reel' && post.variant !== 'story') warnings.push('Facebook: this is sent to Buffer as a Facebook Reel (a vertical video, type "reel"). Whether Facebook accepts it as one is checked by Buffer when it is published.');
      if (!service && channel?.id) warnings.push('The channel type is not known yet (use "Test connection" in the settings to load your channels): Instagram settings are left out until it is.');
      const images = post.media.filter((m) => m.kind === 'image');
      if (images.length > MAX_CAROUSEL) add('too-many-pages', `${images.length} pictures: a carousel takes at most ${MAX_CAROUSEL}.`);
      if (post.format === 'reel' && post.variant !== 'story' && !Number.isFinite(post.coverTime)) warnings.push('No cover frame is chosen for this reel yet: the best one is picked automatically when you press Schedule. To choose it yourself, open the post and use the cover button.');
      if (post.format === 'carousel' && post.variant !== 'story' && images.length < 2) warnings.push('A carousel with one picture goes out as a single post.');
      return { blockers, warnings };
    },

    /** Hand one post to Buffer for `when` (a Date). Throws PublishError. */
    async schedule(post, { channel, when }, settings, ctx = {}) {
      if (!channel?.id) throw new PublishError(400, `No Buffer channel is chosen for ${post.project}.`);
      if (!settings.options?.mediaBaseUrl) throw new PublishError(400, 'Buffer needs a public web address for each picture: set the media web address, or use the export folder and upload in Buffer.', { code: 'no-public-url' });
      const dueAt = new Date(when);
      if (Number.isNaN(dueAt.getTime())) throw new PublishError(400, 'That posting time is not a real time.');
      const exported = exportBundle(post, { wipe: ctx.firstOfPost !== false });   // the files that the addresses below must serve
      if (settings.hosting) {                                                     // the owner's bucket: put them where those addresses point
        const files = post.media.filter((m) => m.kind !== 'cover').map((m) => ({ key: keyFor(post.project, bundleFolderName(post), m.file), abs: join(exported.dir, m.file) }));
        await uploadAll(settings.hosting, files, { fetchImpl });
      }
      const assets = [];
      for (const m of post.media) {
        if (m.kind === 'cover') continue;                                    // Buffer takes a frame time, not a cover picture
        const url = mediaUrl(post, m, settings);
        let problem;
        if (ctx.probeCache?.has(url)) problem = ctx.probeCache.get(url);       // one check per file per run, however many channels use it
        else { problem = await probe(url); ctx.probeCache?.set(url, problem); }
        if (problem) throw new PublishError(409, `Buffer would not be able to read this file later: ${problem}. Host the export folder (out/publish/${bundleFolderName(post)}) at the media web address and try again.`, { code: 'media-unreachable' });
        assets.push(m.kind === 'video' ? { video: { url, ...(Number.isFinite(post.coverTime) ? { metadata: { thumbnailOffset: Math.max(0, Math.round(post.coverTime * 1000)) } } : {}) } } : { image: { url, ...(m.alt ? { metadata: { altText: m.alt } } : {}) } });
      }
      const service = channel.service ?? (settings.channelCache ?? []).find((c) => c.id === channel.id)?.service;
      const story = post.variant === 'story';
      const input = {
        ...(story ? {} : { text: post.caption }),
        channelId: channel.id,
        schedulingType: settings.options?.schedulingType ?? 'automatic',
        mode: 'customScheduled',
        dueAt: dueAt.toISOString(),
        assets,
        ...(service === 'instagram' ? { metadata: { instagram: { type: story ? 'story' : instagramType(post), shouldShareToFeed: !story } } } : {}),
        ...(service === 'facebook' ? { metadata: { facebook: { type: story ? 'story' : facebookType(post) } } } : {}),
        ...(settings.options?.saveToDraft ? { saveToDraft: true } : {}),
      };
      const data = await gql(settings, M_CREATE, { input }, { mutation: true });
      const r = data?.createPost;
      if (r?.post?.id) return { remoteId: String(r.post.id), scheduledAt: r.post.dueAt ?? dueAt.toISOString(), message: `Scheduled${story ? ' as a Story' : ''} in Buffer${settings.options?.saveToDraft ? ' as a draft' : ''} for ${r.post.dueAt ?? dueAt.toISOString()}.` };
      if (typeof r?.message === 'string') throw new PublishError(422, `Buffer refused it: ${redact(r.message, settings.token)}`, { code: 'refused' });
      throw new PublishError(502, 'Buffer gave an answer that is neither a post nor an error. Look in Buffer before trying again.', { code: 'bad-response', uncertain: true });
    },

    /** Take a scheduled post out of Buffer. A post that is already gone counts as deleted. Network, costs one request. */
    async deletePost(settings, remoteId) {
      let data;
      try { data = await gql(settings, M_DELETE, { input: { id: String(remoteId) } }, { mutation: true }); } catch (e) { if (e instanceof PublishError && /not ?found/i.test(e.message)) return { remoteId: String(remoteId), message: 'Already gone from Buffer.', gone: true }; throw e; }
      const r = data?.deletePost;
      if (r?.__typename === 'DeletePostSuccess' || r?.id) return { remoteId: String(remoteId), message: 'Deleted from Buffer.' };
      if (typeof r?.message === 'string') { if (/not ?found/i.test(r.message)) return { remoteId: String(remoteId), message: 'Already gone from Buffer.', gone: true }; throw new PublishError(422, `Buffer refused it: ${redact(r.message, settings.token)}`, { code: 'refused' }); }
      throw new PublishError(502, 'Buffer gave an answer that is neither a deletion nor an error. Look in Buffer before trying again.', { code: 'bad-response', uncertain: true });
    },

    /**
     * Move a scheduled post to another time. Buffer checks a whole post when it is edited, so the post is read first (one request) and sent back as it is
     * (words, pictures, type) with only the time changed (a second request). Costs two requests.
     */
    async moveDue(settings, remoteId, when) {
      const dueAt = new Date(when);
      if (Number.isNaN(dueAt.getTime())) throw new PublishError(400, 'That posting time is not a real time.');
      const post = (await gql(settings, Q_ONE, { id: String(remoteId) }))?.post;
      if (!post?.id) throw new PublishError(404, 'Buffer does not hold that post any more.', { code: 'not-found' });
      if (!['scheduled', 'sending'].includes(post.status)) throw new PublishError(409, `That post is ${post.status} in Buffer, so it is not moved.`, { code: 'not-scheduled' });
      const assets = (post.assets ?? []).map((a) => (a.type === 'video' || a.__typename === 'VideoAsset' ? { video: { url: a.source, ...(Number.isFinite(a.video?.thumbnailOffset) || a.video?.title ? { metadata: { ...(Number.isFinite(a.video?.thumbnailOffset) ? { thumbnailOffset: a.video.thumbnailOffset } : {}), ...(a.video?.title ? { title: a.video.title } : {}) } } : {}) } } : { image: { url: a.source } }));
      const m = post.metadata;
      const metadata = m?.__typename === 'InstagramPostMetadata' ? { instagram: { type: m.type, shouldShareToFeed: !!m.shouldShareToFeed, ...(m.firstComment ? { firstComment: m.firstComment } : {}) } }
        : m?.__typename === 'FacebookPostMetadata' ? { facebook: { type: m.type, ...(m.firstComment ? { firstComment: m.firstComment } : {}) } } : undefined;
      const input = { id: String(remoteId), mode: 'customScheduled', dueAt: dueAt.toISOString(), ...(post.text ? { text: post.text } : {}), assets, ...(metadata ? { metadata } : {}), ...(post.schedulingType ? { schedulingType: post.schedulingType } : {}) };
      const data = await gql(settings, M_EDIT_DUE, { input }, { mutation: true });
      const r = data?.editPost;
      if (r?.post?.id) return { remoteId: String(r.post.id), scheduledAt: r.post.dueAt ?? dueAt.toISOString(), status: r.post.status ?? null, message: 'Moved in Buffer.' };
      if (typeof r?.message === 'string') throw new PublishError(422, `Buffer refused it: ${redact(r.message, settings.token)}`, { code: 'refused' });
      throw new PublishError(502, 'Buffer gave an answer that is neither a post nor an error. Look in Buffer before trying again.', { code: 'bad-response', uncertain: true });
    },

    /** Does the key work? Lists the organisations it can see. Network. */
    async check(settings) {
      try {
        const orgs = (await gql(settings, Q_ORGS))?.account?.organizations ?? [];
        return { ok: true, message: orgs.length ? `Connected to Buffer: ${orgs.map((o) => o.name ?? o.id).join(', ')}.` : 'Connected to Buffer, but the key sees no organisation.', organizations: orgs.map((o) => ({ id: o.id, name: o.name })) };
      } catch (e) {
        if (e instanceof PublishError) return { ok: false, message: e.message, code: e.code };
        throw e;
      }
    },

    // exposed for tests and the plan step
    mediaUrl,
    bundleFileName,
  };
}

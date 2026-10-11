// Media hosting: Nordle puts a scheduled post's files in the owner's own bucket so Buffer can read them. The network is always faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHosting, hostingView, putFile, signRequest, uploadAll, validateHosting } from '../src/publish/hosting.mjs';
import { createBufferAdapter } from '../src/publish/adapters/buffer.mjs';

const H = { kind: 's3', endpoint: 'https://acct.r2.example.com', region: 'auto', bucket: 'posts', accessKeyId: 'AKIDEXAMPLE1234', secretAccessKey: 'SECRETSECRET', publicBaseUrl: 'https://pub-1.r2.example.dev' };

test('the request signer matches the example Amazon publishes for a PUT', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (Example: PUT Object)
  const r = signRequest({
    method: 'PUT', host: 'examplebucket.s3.amazonaws.com', path: '/test%24file.text', payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z',
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
  });
  assert.equal(r.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('hosting settings: a saved secret is kept when it is not sent again, bad addresses are refused, and the view never shows the secret', () => {
  const saved = validateHosting(H);
  const edited = validateHosting({ bucket: 'other' }, saved);
  assert.equal(edited.bucket, 'other');
  assert.equal(edited.secretAccessKey, 'SECRETSECRET', 'the secret stays');
  assert.throws(() => validateHosting({ ...H, publicBaseUrl: 'http://pub.example.com' }), /https/);
  assert.throws(() => validateHosting({ ...H, bucket: 'bad bucket!' }), /bucket/i);
  assert.throws(() => validateHosting({ ...H, extra: 1 }), /Unknown hosting setting/);
  assert.equal(validateHosting(null), null);
  const view = JSON.stringify(hostingView(saved));
  assert.ok(!view.includes('SECRETSECRET') && !view.includes('AKIDEXAMPLE1234'), 'no secret in the view');
  assert.match(view, /…1234/);
});

const storage = () => {
  const objects = new Map(), calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method, url: String(url), headers: init.headers });
    if (u.host === 'acct.r2.example.com') {
      const key = decodeURIComponent(u.pathname);
      if (!/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE1234\//.test(init.headers?.authorization ?? '')) return new Response('', { status: 403 });
      if (init.method === 'PUT') { objects.set(key, Buffer.from(init.body)); return new Response('', { status: 200 }); }
      if (init.method === 'HEAD') return objects.has(key) ? new Response('', { status: 200, headers: { 'content-length': String(objects.get(key).length) } }) : new Response('', { status: 404 });
    }
    if (u.host === 'pub-1.r2.example.dev') {
      const key = `/posts${u.pathname}`;
      return objects.has(key) ? new Response(objects.get(key), { status: 200, headers: { 'content-type': u.pathname.endsWith('.png') ? 'image/png' : 'text/plain' } }) : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  };
  return { objects, calls, fetchImpl };
};

test('a file goes up once: the same size already there is kept, and the bucket sees signed requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nordle-host-'));
  const f = join(dir, '01-cover.png');
  writeFileSync(f, Buffer.from('pretend png bytes'));
  const s = storage();
  assert.equal(await putFile(H, 'brand/2026-11-12-post/01-cover.png', f, { fetchImpl: s.fetchImpl }), 'uploaded');
  assert.equal(await putFile(H, 'brand/2026-11-12-post/01-cover.png', f, { fetchImpl: s.fetchImpl }), 'kept');
  assert.equal(s.objects.get('/posts/brand/2026-11-12-post/01-cover.png').toString(), 'pretend png bytes');
  const put = s.calls.find((c) => c.method === 'PUT');
  assert.equal(put.headers['content-type'], 'image/png');
  assert.match(put.headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(s.calls).includes('SECRETSECRET'), 'the secret is never sent');
  await assert.rejects(() => uploadAll(H, [{ key: 'a/b.png', abs: join(dir, 'missing.png') }], { fetchImpl: s.fetchImpl }), /not in the export folder/);
  await assert.rejects(() => putFile({ ...H, accessKeyId: 'WRONG' }, 'x/y.png', f, { fetchImpl: s.fetchImpl }), /refused the keys/);
});

test('the Test button reads a file back from the public address and says what to fix when it cannot', async () => {
  const ok = storage();
  assert.match((await checkHosting(H, { fetchImpl: ok.fetchImpl })).message, /Working/);
  const privateBucket = { ...ok, fetchImpl: async (url, init) => (new URL(url).host === 'pub-1.r2.example.dev' ? new Response('', { status: 403 }) : ok.fetchImpl(url, init)) };
  const r = await checkHosting(H, { fetchImpl: privateBucket.fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.message, /allow public reads/);
  assert.match((await checkHosting({ ...H, accessKeyId: 'NOPE' }, { fetchImpl: ok.fetchImpl })).message, /refused the keys/);
});

test('scheduling in Buffer puts the post\'s pictures in the bucket first, then points Buffer at their public addresses', async () => {
  const project = mkdtempSync(join(tmpdir(), 'nordle-bufhost-'));
  const src = join(project, 'out', 'pages');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'a.png'), Buffer.from('page one'));
  writeFileSync(join(src, 'b.png'), Buffer.from('page two'));
  const s = storage();
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url) === 'https://api.buffer.com') { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p1', dueAt: '2026-11-12T07:30:00.000Z' } } } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    return s.fetchImpl(url, init);
  };
  const adapter = createBufferAdapter({ fetch: fetchImpl });
  const post = {
    project: 'brand', projectDir: project, date: '2026-11-12', docId: 'carousel-one', format: 'carousel', caption: 'Hello', channel: { id: 'ch1', service: 'facebook' },
    media: [{ kind: 'image', abs: join(src, 'a.png'), rel: 'a.png', page: 'cover', file: '01-cover.png', alt: 'one' }, { kind: 'image', abs: join(src, 'b.png'), rel: 'b.png', page: 'two', file: '02-two.png', alt: 'two' }],
  };
  const settings = { token: 'KEY', options: { mediaBaseUrl: H.publicBaseUrl }, hosting: H, channelCache: [{ id: 'ch1', name: 'Page', service: 'facebook' }] };
  const r = await adapter.schedule(post, { channel: post.channel, when: '2026-11-12T07:30:00.000Z' }, settings, {});
  assert.match(r.message, /Scheduled in Buffer/);
  assert.deepEqual([...s.objects.keys()].sort(), ['/posts/brand/2026-11-12-carousel-one/01-cover.png', '/posts/brand/2026-11-12-carousel-one/02-two.png']);
  const urls = sent[0].variables.input.assets.map((a) => a.image.url);
  assert.deepEqual(urls, [`${H.publicBaseUrl}/brand/2026-11-12-carousel-one/01-cover.png`, `${H.publicBaseUrl}/brand/2026-11-12-carousel-one/02-two.png`]);
});

test('saving hosting through the settings call: the secret stays on the server, the media address follows it, an edit keeps the secret, and null switches it off', async () => {
  process.env.NORDLE_PUBLISH_DIR = mkdtempSync(join(tmpdir(), 'nordle-hostsettings-'));
  const { saveSettingsFor, describeAdapter, getAdapter, PublishError } = await import('../src/publish/index.mjs');
  const { loadSettings } = await import('../src/publish/store.mjs');
  assert.throws(() => saveSettingsFor('buffer', { hosting: H }, 'claude'), PublishError, 'only the owner');
  assert.throws(() => saveSettingsFor('bundle', { hosting: H }, 'human'), /needs no hosting/);
  saveSettingsFor('buffer', { hosting: H }, 'human');
  const d = await describeAdapter(getAdapter('buffer'));
  assert.equal(d.hosting.configured, true);
  assert.equal(d.options.mediaBaseUrl, H.publicBaseUrl, 'Buffer reads from the bucket\'s public address');
  assert.ok(!d.needs.some((n) => /Somewhere public/.test(n)), 'the "somewhere public" need is met');
  const shown = JSON.stringify(d);
  assert.ok(!shown.includes('SECRETSECRET') && !shown.includes('AKIDEXAMPLE1234'), 'nothing secret in what the Studio is told');
  saveSettingsFor('buffer', { hosting: { bucket: 'second' } }, 'human');
  assert.equal(loadSettings().hosting.bucket, 'second');
  assert.equal(loadSettings().hosting.secretAccessKey, 'SECRETSECRET', 'an edit keeps the saved secret');
  saveSettingsFor('buffer', { hosting: null }, 'human');
  assert.equal(loadSettings().hosting, undefined);
  assert.equal((await describeAdapter(getAdapter('buffer'))).hosting.configured, false);
});

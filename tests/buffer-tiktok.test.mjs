// TikTok channels are sent through Buffer like Instagram and Facebook ones (29 Oct 2026); other services are still blocked, not guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBufferAdapter } from '../src/publish/adapters/buffer.mjs';

const adapter = createBufferAdapter();
const settings = { options: { mediaBaseUrl: 'https://media.example.com/nordle' }, channelCache: [] };
const post = (service, extra = {}) => ({ project: 'little-gannet', format: 'reel', variant: null, caption: 'A short caption', media: [{ kind: 'video', file: 'reel.mp4' }], coverTime: 3, channel: { id: 'ch_1', service }, ...extra });
const codes = async (p) => (await adapter.plan(p, { settings })).blockers.map((b) => b.code);

test('a TikTok channel is not blocked', async () => {
  assert.deepEqual(await codes(post('tiktok')), []);
});

test('a TikTok caption over 2200 characters is blocked, and a TikTok Story is too', async () => {
  assert.deepEqual(await codes(post('tiktok', { caption: 'x'.repeat(2201) })), ['caption-too-long']);
  assert.deepEqual(await codes(post('tiktok', { variant: 'story' })), ['story-unsupported']);
});

test('services Nordle has not been written for are still blocked', async () => {
  const plan = await adapter.plan(post('linkedin'), { settings });
  assert.deepEqual(plan.blockers.map((b) => b.code), ['service-unsupported']);
  assert.match(plan.blockers[0].message, /Instagram, Facebook and TikTok channels/);
});

import assert from 'node:assert/strict';

import {
  createLoadProgress,
  fetchJsonWithProgress,
  fetchTextWithProgress,
  formatLoadBytes,
  responseContentLength,
} from './load-progress.js';

assert.equal(formatLoadBytes(0), '0.00 KB');
assert.equal(formatLoadBytes(1536), '1.50 KB');
assert.equal(formatLoadBytes(2 * 1024 * 1024), '2.00 MB');

assert.equal(responseContentLength(new Response('', { headers: { 'Content-Length': '42' } })), 42);
assert.equal(responseContentLength(new Response('', { headers: { 'Content-Length': 'unknown' } })), null);

const snapshots = [];
const progress = createLoadProgress({ phase: 'Manifest', shardsTotal: 2 });
const unsubscribe = progress.subscribe((state) => snapshots.push(state));
progress.update({ phase: 'Shard 1', bytesLoaded: 5, bytesTotal: 10, shardsLoaded: 1 });
unsubscribe();
assert.equal(snapshots.length, 2);
assert.equal(snapshots[1].phase, 'Shard 1');

const encoder = new TextEncoder();
const chunks = ['{"records":', '[1,2]}'].map((value) => encoder.encode(value));
const byteLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
const streamResponse = new Response(new ReadableStream({
  pull(controller) {
    const chunk = chunks.shift();
    if (chunk) controller.enqueue(chunk);
    else controller.close();
  },
}), { headers: { 'Content-Length': String(byteLength) } });
const updates = [];
const phases = [];
const streamed = await fetchJsonWithProgress('/known.json', {}, {
  fetchImpl: async () => streamResponse,
  onProgress: (state) => updates.push(state),
  onPhase: (phase) => phases.push(phase),
});
assert.deepEqual(streamed.data, { records: [1, 2] });
assert.equal(streamed.bytesLoaded, byteLength);
assert.deepEqual(updates.at(-1), { loaded: byteLength, total: byteLength });
assert.deepEqual(phases, ['parsing']);

const text = await fetchTextWithProgress('/text', {}, {
  fetchImpl: async () => new Response('one\ntwo\n'),
});
assert.equal(text.text, 'one\ntwo\n');
assert.equal(text.bytesTotal, null);

await assert.rejects(
  fetchJsonWithProgress('/missing.json', {}, {
    fetchImpl: async () => new Response('', { status: 404 }),
  }),
  /\/missing\.json HTTP 404/,
);

console.log('KCSC load progress checks passed');

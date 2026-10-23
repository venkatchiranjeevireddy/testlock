import assert from 'node:assert/strict';
import { encode } from '@msgpack/msgpack';
import { loadMapping, validateMind, ViewerError } from '../src/mapping.js';

const mind = (n, v = 2) => encode({ v, dataList: Array.from({ length: n }, (_, i) => ({ targetImage: { width: 100 + i, height: 50 + i }, trackingData: [], matchingData: [] })) });
const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

function fakeDb({ sets, pairs, err }) {
  return { from(table) {
    const q = { _t: table, select() { return q; }, order() { return q; }, limit() { return q; }, in() { return q; },
      then(res) { return Promise.resolve(err ? { data: null, error: { message: err } } : { data: table === 'target_sets' ? sets : pairs, error: null }).then(res); } };
    return q;
  } };
}
const pub = (p) => `https://x.test/${p}`;
const okFetch = (n) => async () => ({ ok: true, status: 200, arrayBuffer: async () => toAB(mind(n)) });
const rejects = async (p, re, kind) => { await assert.rejects(p, (e) => { assert.ok(e instanceof ViewerError, String(e)); assert.match(e.message, re); if (kind) assert.equal(e.kind, kind); return true; }); };

const P = (id) => ({ id, label: id, image_path: `images/${id}.jpg`, video_path: `videos/${id}.mp4` });

// 1. order is taken from pair_ids, NOT from DB return order
let r = await loadMapping({ db: fakeDb({ sets: [{ version: 3, mind_path: 'targets/v3.mind', pair_ids: ['b', 'a', 'c'] }], pairs: [P('a'), P('c'), P('b')] }), publicUrl: pub, fetchFn: okFetch(3) });
assert.deepEqual(r.pairs.map((p) => p.id), ['b', 'a', 'c']);
assert.equal(r.pairs[0].videoUrl, 'https://x.test/videos/b.mp4');
assert.equal(r.version, 3);

// 2. nothing registered -> 'empty', not a hang
await rejects(loadMapping({ db: fakeDb({ sets: [], pairs: [] }), publicUrl: pub, fetchFn: okFetch(0) }), /No images/, 'empty');

// 3. server error surfaced
await rejects(loadMapping({ db: fakeDb({ err: 'boom' }), publicUrl: pub, fetchFn: okFetch(1) }), /boom/);

// 4. missing pair row
await rejects(loadMapping({ db: fakeDb({ sets: [{ version: 1, mind_path: 'm', pair_ids: ['a', 'zz'] }], pairs: [P('a')] }), publicUrl: pub, fetchFn: okFetch(2) }), /missing/);

// 5. target count mismatch (would map wrong videos) is refused
await rejects(loadMapping({ db: fakeDb({ sets: [{ version: 1, mind_path: 'm', pair_ids: ['a', 'b'] }], pairs: [P('a'), P('b')] }), publicUrl: pub, fetchFn: okFetch(3) }), /3 targets but 2 mappings/);

// 6. inaccessible .mind (HTTP 404)
await rejects(loadMapping({ db: fakeDb({ sets: [{ version: 1, mind_path: 'm', pair_ids: ['a'] }], pairs: [P('a')] }), publicUrl: pub, fetchFn: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);

// 7. network failure on .mind
await rejects(loadMapping({ db: fakeDb({ sets: [{ version: 1, mind_path: 'm', pair_ids: ['a'] }], pairs: [P('a')] }), publicUrl: pub, fetchFn: async () => { throw new Error('offline'); } }), /offline/);

// 8. hung request -> timeout error instead of endless "Loading…"
await rejects(loadMapping({ db: fakeDb({ sets: [{ version: 1, mind_path: 'm', pair_ids: ['a'] }], pairs: [P('a')] }), publicUrl: pub, timeoutMs: 50, fetchFn: () => new Promise(() => {}) }), /timed out/);

// 9. corrupt / wrong-version .mind
assert.throws(() => validateMind(new Uint8Array([1, 2, 3]), 1), /corrupt/);
assert.throws(() => validateMind(toAB(mind(1, 1)), 1), /unsupported/);
assert.deepEqual(validateMind(toAB(mind(2)), 2), [[100, 50], [101, 51]]);

console.log('OK: 9 mapping/validation scenarios passed');

// Real-compiler test (Node, CPU backend): compile 3 distinct images with MindAR's OfflineCompiler,
// merge them one by one exactly like the Dev App does, and verify the result imports cleanly with
// MindAR's own importData() and keeps every target in the right order.
import assert from 'node:assert/strict';
import { createCanvas } from 'canvas'; // @napi-rs/canvas via npm override
import { OfflineCompiler } from 'mind-ar/src/image-target/offline-compiler.js';
import { mergeMind, readMind } from '../src/merge.js';

function makeImage(seed, w, h) {
  // deterministic textured image: many random rectangles/circles so there are plenty of feature points
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#ddd'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 160; i++) {
    g.fillStyle = `rgb(${rnd() * 255 | 0},${rnd() * 255 | 0},${rnd() * 255 | 0})`;
    if (i % 2) g.fillRect(rnd() * w, rnd() * h, 10 + rnd() * 50, 10 + rnd() * 50);
    else { g.beginPath(); g.arc(rnd() * w, rnd() * h, 6 + rnd() * 30, 0, 7); g.fill(); }
  }
  c.width = w; c.height = h; // mind-ar reads img.width / img.height
  return c;
}

async function compileOne(img) {
  const compiler = new OfflineCompiler();
  await compiler.compileImageTargets([img], () => {});
  return compiler.exportData();
}

const sizes = [[300, 200], [240, 320], [280, 280]];
const singles = [];
for (let i = 0; i < sizes.length; i++) {
  console.log(`compiling image ${i + 1}/${sizes.length} (${sizes[i].join('x')})...`);
  singles.push(await compileOne(makeImage(1000 + i * 77, ...sizes[i])));
}

let merged = null;
for (let i = 0; i < singles.length; i++) {
  const r = mergeMind(merged, singles[i]);
  assert.equal(r.addedIndex, i, 'new target appended at the end');
  assert.equal(r.count, i + 1);
  merged = r.buffer;
}

// Validate with MindAR's own importer (same code the viewer's Controller uses)
const check = new OfflineCompiler();
const data = check.importData(merged);
assert.equal(data.length, 3, 'all targets present');
for (let i = 0; i < 3; i++) {
  assert.deepEqual(
    [data[i].targetImage.width, data[i].targetImage.height],
    sizes[i],
    `target ${i} dimensions preserved in order`
  );
  const orig = readMind(singles[i]).dataList[0];
  assert.deepEqual(data[i].matchingData, orig.matchingData, `target ${i} matching data identical to standalone compile`);
  assert.deepEqual(data[i].trackingData, orig.trackingData, `target ${i} tracking data identical to standalone compile`);
}

// Negative cases
assert.throws(() => mergeMind(null, new Uint8Array([1, 2, 3])), /./, 'garbage rejected');
const { encode } = await import('@msgpack/msgpack');
assert.throws(() => mergeMind(null, encode({ v: 1, dataList: [{}] })), /Unsupported/, 'old format rejected');

console.log('OK: 3 targets compiled, merged incrementally, imported by MindAR importData, order + data verified.');
process.exit(0);

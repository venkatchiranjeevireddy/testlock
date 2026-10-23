// Merge MindAR ".mind" files.
//
// A .mind file is a msgpack document: { v: <format version>, dataList: [one entry per target image] }.
// MindAR's Controller loads dataList in order and reports each match as `targetIndex` = position in dataList.
// Two .mind files can therefore NOT be byte-concatenated, but their dataLists CAN be appended safely,
// as long as the format version matches. This lets us compile only the NEW image and add it to the set.
import { decode, encode } from '@msgpack/msgpack';

// Must match CURRENT_VERSION in mind-ar (src/image-target/compiler-base.js).
export const MIND_FORMAT_VERSION = 2;

export function readMind(buffer) {
  const content = decode(new Uint8Array(buffer));
  if (!content || content.v !== MIND_FORMAT_VERSION || !Array.isArray(content.dataList)) {
    throw new Error(
      `Unsupported or corrupt .mind data (format v${content && content.v}, expected v${MIND_FORMAT_VERSION}).`
    );
  }
  return content;
}

// base: ArrayBuffer/Uint8Array of the existing .mind, or null for the first target.
// addition: .mind buffer that contains exactly the new target(s).
// Returns { buffer: Uint8Array, count: total targets, addedIndex: index of the first added target }.
export function mergeMind(base, addition) {
  const add = readMind(addition);
  if (add.dataList.length < 1) throw new Error('Newly compiled target is empty.');
  const old = base ? readMind(base) : { dataList: [] };
  const dataList = [...old.dataList, ...add.dataList];
  return {
    buffer: encode({ v: MIND_FORMAT_VERSION, dataList }),
    count: dataList.length,
    addedIndex: old.dataList.length,
  };
}

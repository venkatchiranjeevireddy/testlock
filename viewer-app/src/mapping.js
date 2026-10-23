// Loads everything the viewer needs from Supabase and VALIDATES it before MindAR ever sees it.
// Why: MindAR's own addImageTargets() has no error handling -- a failed/invalid .mind download leaves the
// page on "Loading…" forever. We download + verify the file ourselves and fail with a clear message instead.
import { decode } from '@msgpack/msgpack';

export const MIND_FORMAT_VERSION = 2; // mind-ar 1.2.x

export class ViewerError extends Error {
  constructor(message, kind = 'error') { super(message); this.kind = kind; }
}

export function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new ViewerError(`${what} timed out. Check your connection and reload.`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export function validateMind(buffer, expectedCount) {
  let content;
  try { content = decode(new Uint8Array(buffer)); } catch { throw new ViewerError('The tracking file is corrupt. Re-upload an image from the Dev App.'); }
  if (!content || content.v !== MIND_FORMAT_VERSION || !Array.isArray(content.dataList)) {
    throw new ViewerError('The tracking file has an unsupported format version. Re-upload from the Dev App.');
  }
  if (content.dataList.length !== expectedCount) {
    throw new ViewerError(`Tracking file has ${content.dataList.length} targets but ${expectedCount} mappings are registered. Refusing to start so no wrong video can show.`);
  }
  return content.dataList.map((d) => [d.targetImage.width, d.targetImage.height]);
}

/**
 * @param {{db: any, publicUrl: (path:string)=>string, fetchFn?: typeof fetch, timeoutMs?: number}} deps
 * @returns {{version:number, pairs:Array<{id,label,videoUrl,imageUrl}>, mindBuffer:ArrayBuffer}}
 */
export async function loadMapping({ db, publicUrl, fetchFn = fetch, timeoutMs = 20000 }) {
  const ts = await withTimeout(
    Promise.resolve(db.from('target_sets').select('version, mind_path, pair_ids').order('version', { ascending: false }).limit(1)),
    timeoutMs, 'Loading mappings');
  if (ts.error) throw new ViewerError(`Could not reach the server: ${ts.error.message}`);
  if (!ts.data || !ts.data.length) throw new ViewerError('No images have been registered yet. Upload one in the Dev App first.', 'empty');
  const set = ts.data[0];
  if (!Array.isArray(set.pair_ids) || !set.pair_ids.length) throw new ViewerError('The published target set is empty.', 'empty');

  const pr = await withTimeout(
    Promise.resolve(db.from('pairs').select('id, label, image_path, video_path').in('id', set.pair_ids)),
    timeoutMs, 'Loading pairs');
  if (pr.error) throw new ViewerError(`Could not load pairs: ${pr.error.message}`);
  const byId = new Map((pr.data || []).map((p) => [p.id, p]));
  // ORDER MATTERS: pair_ids[i] is MindAR targetIndex i
  const pairs = set.pair_ids.map((id) => {
    const p = byId.get(id);
    if (!p) throw new ViewerError('A registered mapping is missing from the database. Refusing to start.');
    if (!p.video_path) throw new ViewerError('A mapping has no video. Refusing to start.');
    return { id: p.id, label: p.label, imageUrl: publicUrl(p.image_path), videoUrl: publicUrl(p.video_path) };
  });

  let res;
  try { res = await withTimeout(fetchFn(publicUrl(set.mind_path)), timeoutMs * 2, 'Downloading tracking data'); }
  catch (e) { throw e instanceof ViewerError ? e : new ViewerError(`Could not download tracking data: ${e.message}`); }
  if (!res.ok) throw new ViewerError(`Tracking file is not accessible (HTTP ${res.status}). Check that the "wedding-ar" bucket is public.`);
  const mindBuffer = await res.arrayBuffer();
  validateMind(mindBuffer, pairs.length);

  return { version: set.version, pairs, mindBuffer };
}

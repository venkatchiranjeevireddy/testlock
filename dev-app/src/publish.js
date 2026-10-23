import { supabase, BUCKET, publicUrl } from './supabase.js';
import { compileTarget, checkVideoPlayable } from './compile.js';
import { mergeMind, readMind } from './merge.js';

const MAX_PUBLISH_ATTEMPTS = 5;
const NET_TIMEOUT_MS = 60000;

const uid = () => crypto.randomUUID();
const extOf = (name, fallback) => {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : fallback;
};

function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s. Check your connection and try again.`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function fetchBuffer(url, what) {
  const res = await withTimeout(fetch(url, { cache: 'no-store' }), NET_TIMEOUT_MS, what);
  if (!res.ok) throw new Error(`${what} failed (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

async function upload(path, body, contentType) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, body, { contentType, upsert: false, cacheControl: '31536000' });
  if (error) throw new Error(`Upload of ${path} failed: ${error.message}`);
}

async function removeQuietly(paths) {
  if (!paths.length) return [];
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  return error ? paths : [];
}

async function latestTargetSet() {
  const { data, error } = await supabase
    .from('target_sets').select('version, mind_path, pair_ids').order('version', { ascending: false }).limit(1);
  if (error) throw new Error(`Could not read current target set: ${error.message}`);
  return data && data.length ? data[0] : { version: 0, mind_path: null, pair_ids: [] };
}

/**
 * Full automatic pipeline. `step(id, state, detail)` reports progress to the UI.
 * Resolves only when the pair is uploaded, compiled, merged, verified AND registered.
 * Anything that fails removes every file uploaded by this run, so the viewer never sees a broken mapping.
 */
export async function publishPair({ imageFile, videoFile, label }, step) {
  const uploaded = []; // storage paths created by THIS run (for cleanup)
  let registered = false; // once the DB row exists, the files are live and must NOT be removed
  try {
    // 1. validate inputs before touching the network
    step('validate', 'run');
    if (!imageFile || !videoFile) throw new Error('Choose both an image and a video.');
    if (!/^image\/(jpeg|png|webp)$/.test(imageFile.type)) throw new Error('Image must be JPG, PNG or WebP.');
    if (videoFile.type !== 'video/mp4' && !/\.mp4$/i.test(videoFile.name)) throw new Error('Video must be an MP4 file (H.264).');
    await checkVideoPlayable(videoFile);
    step('validate', 'done');

    // 2. generate the tracking target (fail early, before the big video upload)
    step('compile', 'run', '0%');
    const target = await compileTarget(imageFile, (p) => step('compile', 'run', `${p}%`));
    step('compile', 'done');

    // 3. upload the exact original files
    step('upload', 'run');
    const id = uid();
    const imagePath = `images/${id}.${extOf(imageFile.name, 'jpg')}`;
    const videoPath = `videos/${id}.mp4`;
    await upload(imagePath, imageFile, imageFile.type); uploaded.push(imagePath);
    await upload(videoPath, videoFile, 'video/mp4'); uploaded.push(videoPath);
    // make sure the public URLs really serve the files
    for (const p of [imagePath, videoPath]) {
      const r = await withTimeout(fetch(publicUrl(p), { method: 'HEAD', cache: 'no-store' }), NET_TIMEOUT_MS, 'Checking uploaded file');
      if (!r.ok) throw new Error(`Uploaded file ${p} is not publicly readable (HTTP ${r.status}). Is the "${BUCKET}" bucket public? Re-run supabase/setup.sql.`);
    }
    step('upload', 'done');

    // 4. merge into the combined target set, store it, verify it, then register atomically
    step('register', 'run');
    let result = null;
    for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS && !result; attempt++) {
      const current = await latestTargetSet();
      const base = current.mind_path ? await fetchBuffer(publicUrl(current.mind_path), 'Downloading current target set') : null;
      if (base) {
        const n = readMind(base).dataList.length;
        if (n !== current.pair_ids.length) throw new Error(`Stored target set is inconsistent (${n} targets vs ${current.pair_ids.length} mappings). Refusing to publish.`);
      }
      const merged = mergeMind(base, target.buffer);
      const nextVersion = current.version + 1;
      const mindPath = `targets/v${nextVersion}-${uid()}.mind`;

      await upload(mindPath, merged.buffer, 'application/octet-stream');
      uploaded.push(mindPath);

      // read it back from the public URL and validate before it can be referenced
      const back = await fetchBuffer(publicUrl(mindPath), 'Verifying stored target');
      if (readMind(back).dataList.length !== merged.count) throw new Error('Stored target file failed verification.');

      const { data, error } = await supabase.rpc('register_pair', {
        p_base_version: current.version,
        p_label: label || '',
        p_image_path: imagePath,
        p_video_path: videoPath,
        p_image_width: target.width,
        p_image_height: target.height,
        p_mind_path: mindPath,
      });
      if (!error) { registered = true; result = { data: Array.isArray(data) ? data[0] : data, mindPath, count: merged.count }; break; }

      if (/version_conflict/.test(error.message)) {
        // someone else published first: drop our stale .mind and merge again on top of theirs
        await removeQuietly([mindPath]);
        uploaded.splice(uploaded.indexOf(mindPath), 1);
        continue;
      }
      if (/not_admin/.test(error.message)) throw new Error('This account is not an admin. Run the "insert into public.admins" step from the README.');
      throw new Error(`Registering the pair failed: ${error.message}`);
    }
    if (!result) throw new Error('Another upload kept changing the target set. Please try again.');

    // 5. confirm the published state
    const confirm = await latestTargetSet();
    if (confirm.version < result.data.version || !confirm.pair_ids.includes(result.data.pair_id)) {
      throw new Error('Published mapping could not be confirmed.');
    }
    step('register', 'done', `${result.count} target(s) live`);
    return { pairId: result.data.pair_id, version: result.data.version, total: result.count };
  } catch (err) {
    // Roll back everything this run created. (DB rows are only created by the final atomic call.)
    const leftovers = registered ? [] : await removeQuietly(uploaded);
    err.cleanupNote = leftovers.length
      ? `Some temporary files could not be removed (${leftovers.join(', ')}). They are unreferenced and harmless.`
      : '';
    throw err;
  }
}

export async function listPairs() {
  const { data, error } = await supabase.from('pairs').select('id,label,image_path,video_path,created_at').order('created_at', { ascending: false });
  if (error) throw new Error(`Could not load pairs: ${error.message}`);
  return data;
}

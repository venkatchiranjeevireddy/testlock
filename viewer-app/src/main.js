import * as THREE from 'three';
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
import { supabase, publicUrl, configError } from './supabase.js';
import { loadMapping, withTimeout, ViewerError } from './mapping.js';

const $ = (id) => document.getElementById(id);
const panel = $('panel'), msg = $('msg'), action = $('action'), spinner = $('spinner');
const soundBtn = $('sound'), lockBtn = $('lock'), playBtn = $('play'), arBox = $('ar');

const START_TIMEOUT_MS = 60000;

let state = 'loading'; // loading | ready | starting | running | stopped | error
let mapping = null;
let ar = null;          // MindARThree instance
let blobUrl = null;
let videos = [];        // index = MindAR targetIndex = position in target_sets.pair_ids
let textures = [];
let videoBox = null;
let soundOn = false;
let lockedIndex = -1;
let toastTimer = null;

// ---------- UI helpers ----------
function show(text, { error = false, busy = false, button = null } = {}) {
  panel.classList.remove('hidden');
  panel.classList.toggle('error', error);
  msg.textContent = text;
  spinner.hidden = !busy;
  action.hidden = !button;
  if (button) { action.textContent = button.label; action.onclick = button.onClick; }
}
const hidePanel = () => panel.classList.add('hidden');
function toast(text) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;left:50%;top:max(16px,env(safe-area-inset-top));transform:translateX(-50%);z-index:30;background:rgba(0,0,0,.8);color:#fff;padding:10px 14px;border-radius:8px;font-size:14px;max-width:90vw;text-align:center';
    document.body.append(t);
  }
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)/i.test(navigator.userAgent);
const inAppHint = inAppBrowser ? '\n\nTip: you seem to be inside an app\'s built-in browser. Open this link in Chrome (Android) or Safari (iPhone).' : '';

function cameraErrorMessage(e) {
  switch (e && e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was blocked. Allow camera access for this site in your browser settings, then tap Retry.' + inAppHint;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is being used by another app. Close it and tap Retry.';
    default:
      return `Could not start the camera${e && e.message ? `: ${e.message}` : '.'}` + inAppHint;
  }
}

// ---------- startup: fetch + validate mappings ----------
async function init() {
  state = 'loading';
  if (configError) return fail(configError);
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return fail('This browser cannot open the camera here. Use Chrome (Android) or Safari (iPhone) on an HTTPS link.' + inAppHint);
  }
  show('Loading…', { busy: true });
  try {
    mapping = await loadMapping({ db: supabase, publicUrl });
  } catch (e) {
    return fail(e.message, e instanceof ViewerError && e.kind === 'empty');
  }
  state = 'ready';
  show('Point your camera at the printed picture to see it come alive.', { button: { label: 'Start camera', onClick: startAR } });
}

function fail(text, neutral = false) {
  state = 'error';
  show(text, { error: !neutral, button: { label: 'Retry', onClick: () => location.reload() } });
}

// ---------- AR ----------
function buildVideo(pair, i) {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.preload = 'auto';
  v.src = pair.videoUrl;
  v.addEventListener('loadedmetadata', () => fit(i));
  v.addEventListener('error', () => toast('This video could not be loaded.'));
  videoBox.append(v);
  return v;
}

const meshes = [];
let dims = [];
// Keep the video inside the printed image's rectangle (image width = 1 unit in MindAR anchor space).
function fit(i) {
  const mesh = meshes[i], v = videos[i], d = dims[i];
  if (!mesh || !d) return;
  const imgAspect = d[1] / d[0];
  let w = 1, h = imgAspect;
  if (v.videoWidth && v.videoHeight) {
    const vidAspect = v.videoHeight / v.videoWidth;
    if (vidAspect <= imgAspect) { w = 1; h = vidAspect; } else { h = imgAspect; w = imgAspect / vidAspect; }
  }
  mesh.scale.set(w, h, 1);
}

function playVideo(i) {
  videos.forEach((o, j) => { if (j !== i) o.pause(); }); // never two videos at once
  const v = videos[i];
  const p = v.play();
  if (p && p.catch) {
    p.catch((err) => {
      if (err && err.name === 'AbortError') return;
      // autoplay refused: let the user start it with one tap
      playBtn.hidden = false;
      playBtn.onclick = () => { v.muted = !soundOn; v.play().then(() => { playBtn.hidden = true; }).catch(() => toast('Could not play this video.')); };
    });
  }
}

async function startAR() {
  if (state !== 'ready') return;
  state = 'starting';
  show('Starting camera…', { busy: true });

  // 1) Ask for the camera ourselves first: MindAR swallows getUserMedia errors, which looks like a hang.
  try {
    const s = await withTimeout(navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }), 30000, 'Waiting for camera permission');
    s.getTracks().forEach((t) => t.stop());
  } catch (e) {
    return fail(e instanceof ViewerError ? e.message : cameraErrorMessage(e));
  }

  try {
    // 2) hand MindAR a blob of the already-validated .mind so its (error-less) fetch can't fail or hang
    blobUrl = URL.createObjectURL(new Blob([mapping.mindBuffer], { type: 'application/octet-stream' }));

    ar = new MindARThree({ container: arBox, imageTargetSrc: blobUrl, maxTrack: 1, uiLoading: 'no', uiScanning: 'yes', uiError: 'no' });
    const { renderer, scene, camera } = ar;

    videoBox = document.createElement('div');
    videoBox.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden';
    document.body.append(videoBox);

    mapping.pairs.forEach((pair, i) => {
      const v = buildVideo(pair, i);
      videos[i] = v;
      const tex = new THREE.VideoTexture(v);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      textures[i] = tex;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      meshes[i] = mesh;
      const anchor = ar.addAnchor(i); // targetIndex i  <->  pair_ids[i]
      anchor.group.add(mesh);
      anchor.onTargetFound = () => {
        lockBtn.hidden = false;
        playVideo(i);
      };
      anchor.onTargetLost = () => {
        if (lockedIndex === i) {
          scene.attach(mesh);
          mesh.visible = true;
          playVideo(i);
          return;
        }
        videos[i].pause();
        mesh.visible = false;
        playBtn.hidden = true;
      };
    });

    await withTimeout(ar.start().catch((e) => { throw new ViewerError(cameraErrorMessage(e)); }), START_TIMEOUT_MS, 'Starting AR');

    dims = ar.controller.markerDimensions || [];
    if (dims.length !== mapping.pairs.length) throw new ViewerError('Tracking data does not match the registered pictures. Refusing to run.');
    mapping.pairs.forEach((_, i) => fit(i));

    renderer.setAnimationLoop(() => renderer.render(scene, camera));
    const track = ar.video && ar.video.srcObject && ar.video.srcObject.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => { cleanup(); fail('The camera stopped. Tap Retry.'); });

    state = 'running';
    hidePanel();
    soundBtn.hidden = false;
    lockBtn.hidden = true;
  } catch (e) {
    cleanup();
    fail(e instanceof ViewerError ? e.message : `Could not start AR: ${e && e.message ? e.message : 'unknown error'}.` + inAppHint);
  }
}

// ---------- sound ----------
soundBtn.onclick = () => {
  soundOn = !soundOn;
  videos.forEach((v) => { v.muted = !soundOn; });
  soundBtn.textContent = soundOn ? '🔊 Sound on' : '🔇 Tap for sound';
  const active = ar && ar.anchors.findIndex((a) => a.visible);
  if (active >= 0 && videos[active] && videos[active].paused) videos[active].play().catch(() => {});
};

lockBtn.onclick = () => {
  if (!ar || state !== 'running') return;

  if (lockedIndex >= 0) {
    const i = lockedIndex;
    lockedIndex = -1;
    lockBtn.textContent = '🔒 Lock video';
    const anchor = ar.anchors[i];
    if (anchor && anchor.visible) {
      anchor.group.attach(meshes[i]);
      meshes[i].visible = true;
      playVideo(i);
    } else {
      videos[i].pause();
      meshes[i].visible = false;
      lockBtn.hidden = true;
      toast('Video unlocked. Scan the image to play it again.');
    }
    return;
  }

  const active = ar.anchors.findIndex((anchor) => anchor.visible);
  if (active < 0) {
    toast('Scan an image before locking the video.');
    return;
  }
  lockedIndex = active;
  lockBtn.textContent = '🔓 Unlock video';
  toast('Video locked. It will stay visible when tracking is lost.');
};

// ---------- cleanup ----------
function cleanup() {
  const wasRunning = state === 'running';
  try { if (ar) ar.renderer.setAnimationLoop(null); } catch { /* ignore */ }
  try { if (ar && ar.controller) ar.controller.dispose(); } catch { /* ignore */ }
  try { if (ar && ar.video && ar.video.srcObject) ar.video.srcObject.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  try { if (ar && ar.video) ar.video.remove(); } catch { /* ignore */ }
  try { if (ar) { ar.renderer.dispose(); ar.renderer.domElement.remove(); ar.cssRenderer.domElement.remove(); } } catch { /* ignore */ }
  videos.forEach((v) => { try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch { /* ignore */ } });
  textures.forEach((t) => t.dispose());
  if (videoBox) videoBox.remove();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  ar = null; videos = []; textures = []; meshes.length = 0; dims = []; videoBox = null; blobUrl = null;
  lockedIndex = -1;
  soundBtn.hidden = true; lockBtn.hidden = true; playBtn.hidden = true;
  document.querySelectorAll('.mindar-ui-overlay').forEach((n) => n.remove());
  return wasRunning;
}

// Free the camera whenever the page is hidden or closed.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'running') {
    cleanup();
    state = 'stopped';
    show('Paused to save battery and release the camera.', { button: { label: 'Resume', onClick: () => location.reload() } });
  }
});
window.addEventListener('pagehide', () => { cleanup(); });

init();

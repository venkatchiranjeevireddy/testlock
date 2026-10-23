// Compiles ONE image into a MindAR target using MindAR's own browser Compiler.
// The uploaded/stored original is never touched. For tracking only, a downscaled in-memory copy is
// compiled (MindAR builds its own scale pyramid anyway) to keep phones/laptops from running out of memory.
import { Compiler } from 'mind-ar/dist/mindar-image.prod.js';

const MAX_SIDE = 1024;

export async function loadBitmap(file) {
  try {
    return await createImageBitmap(file); // honours EXIF orientation
  } catch {
    throw new Error('Could not read that image. Use a JPG, PNG or WebP file.');
  }
}

export async function compileTarget(file, onProgress) {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const compiler = new Compiler();
  await compiler.compileImageTargets([canvas], (p) => onProgress?.(Math.min(100, Math.round(p))));
  const buffer = compiler.exportData(); // Uint8Array (.mind)
  if (!buffer || !buffer.byteLength) throw new Error('Target generation produced no data.');
  return { buffer, width, height };
}

// Make sure the browser can actually decode the chosen video (e.g. HEVC .mov often can't).
export function checkVideoPlayable(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (err) => { URL.revokeObjectURL(url); err ? reject(err) : resolve({ w: v.videoWidth, h: v.videoHeight }); };
    const t = setTimeout(() => done(new Error('Timed out reading the video file.')), 20000);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => { clearTimeout(t); v.videoWidth ? done() : done(new Error('The video has no picture track.')); };
    v.onerror = () => { clearTimeout(t); done(new Error('This browser cannot decode that video. Export it as H.264 MP4 (works on every phone).')); };
    v.src = url;
  });
}

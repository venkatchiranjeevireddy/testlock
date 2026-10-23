import { supabase, configError, publicUrl } from './supabase.js';
import { publishPair, listPairs } from './publish.js';

const app = document.getElementById('app');

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

function fatal(msg) {
  app.replaceChildren(el('h1', { textContent: 'Wedding AR — Dev App' }), el('div', { className: 'banner err', textContent: msg }));
}

if (configError) {
  fatal(configError);
} else {
  boot().catch((e) => fatal(`Startup failed: ${e.message}`));
}

async function boot() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  data.session ? await showUploader(data.session) : showLogin();
}

function showLogin(message = '') {
  const email = el('input', { type: 'email', autocomplete: 'username', required: true });
  const pass = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const btn = el('button', { type: 'submit', textContent: 'Sign in' });
  const msg = el('div', { className: message ? 'banner err' : '', textContent: message });
  const form = el('form', { className: 'card' },
    el('h2', { textContent: 'Admin sign in' }),
    el('label', { textContent: 'Email' }), email,
    el('label', { textContent: 'Password' }), pass, btn, msg);
  form.onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true; msg.className = ''; msg.textContent = '';
    const { error } = await supabase.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (error) { btn.disabled = false; msg.className = 'banner err'; msg.textContent = error.message; return; }
    boot().catch((e2) => fatal(e2.message));
  };
  app.replaceChildren(el('h1', { textContent: 'Wedding AR — Dev App' }), el('p', { className: 'muted', textContent: 'Upload an image and its video. Everything else is automatic.' }), form);
}

async function showUploader(session) {
  // must be listed in public.admins
  const { data: adminRow, error: adminErr } = await supabase.from('admins').select('user_id').eq('user_id', session.user.id).maybeSingle();
  if (adminErr) return fatal(`Could not verify admin access: ${adminErr.message}\nHave you run supabase/setup.sql?`);
  if (!adminRow) {
    await supabase.auth.signOut();
    return showLogin('This account is not an admin yet. Run the "insert into public.admins" step from the README, then sign in again.');
  }

  const label = el('input', { type: 'text', placeholder: 'e.g. Reception table 4 (optional)' });
  const image = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const video = el('input', { type: 'file', accept: 'video/mp4,.mp4' });
  const btn = el('button', { type: 'submit', textContent: 'Upload' });
  const bar = el('progress', { max: 100, value: 0, hidden: true });
  const steps = el('ul', { className: 'steps' });
  const result = el('div');

  const stepDefs = {
    validate: 'Checking files',
    compile: 'Generating tracking target',
    upload: 'Uploading image and video',
    register: 'Registering mapping & publishing to viewer',
  };
  const stepEls = {};
  const setStep = (id, state, detail = '') => {
    if (!stepEls[id]) { stepEls[id] = el('li'); steps.append(stepEls[id]); }
    stepEls[id].className = state;
    stepEls[id].textContent = stepDefs[id] + (detail ? ` — ${detail}` : '');
    const order = Object.keys(stepDefs);
    bar.value = (order.indexOf(id) + (state === 'done' ? 1 : 0.4)) / order.length * 100;
  };

  const form = el('form', { className: 'card' },
    el('h2', { textContent: 'Add an image + video pair' }),
    el('label', { textContent: 'Label (only for your own reference)' }), label,
    el('label', { textContent: 'Original image (the one you will print)' }), image,
    el('label', { textContent: 'Matching video (MP4)' }), video,
    btn, bar, steps, result);

  const list = el('div', { className: 'card' });

  async function refreshList() {
    try {
      const pairs = await listPairs();
      list.replaceChildren(el('h2', { textContent: `Registered pairs (${pairs.length})` }));
      if (!pairs.length) list.append(el('p', { className: 'muted', textContent: 'None yet.' }));
      for (const p of pairs) {
        list.append(el('div', { className: 'pair' },
          el('img', { src: publicUrl(p.image_path), alt: '' }),
          el('div', {}, el('div', { textContent: p.label || '(no label)' }),
            el('a', { href: publicUrl(p.video_path), target: '_blank', rel: 'noopener', textContent: 'open video' }))));
      }
    } catch (e) {
      list.replaceChildren(el('div', { className: 'banner err', textContent: e.message }));
    }
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true; bar.hidden = false; bar.value = 0;
    steps.replaceChildren(); Object.keys(stepEls).forEach((k) => delete stepEls[k]);
    result.className = ''; result.textContent = '';
    let current = 'validate';
    const tracked = (id, state, detail) => { current = id; setStep(id, state, detail); };
    try {
      const out = await publishPair({ imageFile: image.files[0], videoFile: video.files[0], label: label.value.trim() }, tracked);
      result.className = 'banner ok';
      result.textContent = `Done. Pair registered and live in the Viewer App (${out.total} image${out.total === 1 ? '' : 's'} total). Nothing else to do.`;
      form.reset();
      refreshList();
    } catch (err) {
      setStep(current, 'fail');
      result.className = 'banner err';
      result.textContent = `Upload failed — nothing was published.\n${err.message}${err.cleanupNote ? '\n' + err.cleanupNote : ''}`;
    } finally {
      btn.disabled = false;
    }
  };

  const signOut = el('button', { className: 'link', type: 'button', textContent: `Sign out (${session.user.email})` });
  signOut.onclick = async () => { await supabase.auth.signOut(); showLogin(); };

  app.replaceChildren(
    el('h1', { textContent: 'Wedding AR — Dev App' }),
    el('p', { className: 'muted', textContent: 'Pick the image and its video, press Upload. Tracking data is generated and published automatically.' }),
    form, list, el('p', {}, signOut));
  refreshList();
}

# Wedding AR System (MindAR.js + Supabase)

Two independent web apps that share one Supabase project:

| App | Folder | Who uses it | What it does |
|---|---|---|---|
| **Dev App** | `dev-app/` | You (admin) | Pick the original image + its MP4, press **Upload**. Everything else is automatic. |
| **Viewer App** | `viewer-app/` | Guests, on a phone | Open the link, allow the camera, point at the printed image, the matching video appears over it. |

Nothing here modifies the MindAR.js repository. MindAR is used as the published npm package `mind-ar@1.2.5`.

---

## How it works (and why it is built this way)

I read MindAR's source (`compiler-base.js`, `controller.js`, `three.js`) before designing this:

* A `.mind` file is a msgpack document `{ v: 2, dataList: [target0, target1, …] }`. MindAR reports a match as `targetIndex` = position in `dataList`.
* Separate `.mind` files **cannot be byte-concatenated**, but their `dataList` arrays **can** be appended (same format version). The Dev App therefore compiles only the *new* image with MindAR's own browser `Compiler`, appends it to the current set, and publishes the combined file. (Verified with MindAR's real compiler, see tests.)
* `Controller.addImageTargets()` has **no error handling**: if the `.mind` download fails or is invalid, the page stays on "Loading…" forever. That was the root cause of the stuck-viewer problem. The Viewer downloads and validates the file itself, with timeouts, and gives MindAR a verified blob.

**Publishing a pair (all automatic):**
1. Validate files (and check the browser can decode the video).
2. Compile the image into a MindAR target (in your browser, with MindAR's `Compiler`).
3. Upload the original image and the MP4 unchanged to Storage.
4. Download the current combined `.mind`, append the new target, upload as a new immutable, versioned file (`targets/v<N>-<uuid>.mind`), read it back and validate it.
5. Call the `register_pair` database function: in **one transaction** it creates the pair row and the new target-set row. If somebody else published in between it reports a version conflict and the Dev App re-merges and retries.
6. On *any* failure before step 5 completes, every file uploaded by that run is deleted, and no database row exists, so the viewer can never load a half-registered pair.

**Viewer:** reads the latest target set (ordered list of pair ids = target order) and the pairs, downloads + validates the `.mind`, and creates one video plane per target. Because files are versioned and immutable and the mapping query is `no-store`, a new upload is picked up on the next page load with no rebuild or redeploy.

The image you print is the exact file you uploaded. The `.mind` file is internal. (For tracking only, an in-memory copy is downscaled to max 1024 px before compiling; the stored original is untouched.)

---

## One-time setup

Requirements: Node.js 18+ and a free Supabase account.

### 1. Create a Supabase project
Dashboard → **New project**. Note the **Project URL** and the **anon public key** (Project Settings → API). Never use the `service_role` key in these apps.

### 2. Run the SQL
Dashboard → **SQL Editor → New query**, paste the whole of `supabase/setup.sql`, press **Run**. It is safe to re-run. It creates the tables, Row Level Security, the atomic `register_pair` function and the public `wedding-ar` storage bucket with admin-only write policies.

### 3. Create yourself as admin
1. Dashboard → **Authentication → Users → Add user** → *Create new user*: your email + a password (tick *Auto Confirm User*).
2. Recommended: in the Authentication settings, turn **off** "Allow new users to sign up" (the exact menu location varies by dashboard version).
3. SQL Editor, run (with your email):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'YOUR_EMAIL_HERE';
   ```

### 4. Configure each app
```bash
cd dev-app    && cp .env.example .env.local   # then edit: URL + anon key
cd ../viewer-app && cp .env.example .env.local
```

### 5. Install and run (two separate terminals)
```bash
# Dev App (http://localhost:5173)
cd dev-app && npm install && npm run dev

# Viewer App (https://<your-LAN-ip>:5174 or similar; uses a self-signed cert so a phone can use the camera)
cd viewer-app && npm install && npm run dev
```
Vite prints the exact URLs. For the phone, open the **Network** URL and accept the certificate warning.

> `npm install` note: `mind-ar` lists the native `canvas` package as a dependency, which often fails to compile and is only needed for Node-side compiling. Both apps include an npm `overrides` entry replacing it with a prebuilt package, so install works without build tools. Browser code does not use it.

### 6. Build and deploy
```bash
cd dev-app    && npm run build   # output: dev-app/dist
cd viewer-app && npm run build   # output: viewer-app/dist
```
Each `dist/` folder is a static site. Host them on any static host with **HTTPS** (Netlify, Vercel, Cloudflare Pages, GitHub Pages, your own server; this is only file hosting, all data lives in Supabase). Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as build-time environment variables on the host (Vite bakes them in at build). HTTPS is mandatory: phones only allow camera access on secure pages.

Tip: deploy the Dev App somewhere private, or just run it locally; only admins can write anyway (enforced by the database, not by the UI).

---

## Daily use

* **Add a pair:** open the Dev App, sign in, choose image + MP4, press Upload, wait for the green "Done" banner. That's all. Repeat any time, today or next week.
* **Guests:** open the Viewer link, tap **Start camera**, allow access, point at the printed image. Tap **🔇 Tap for sound** to hear audio (videos start muted so mobile browsers allow autoplay; if a phone still blocks autoplay a **▶ Tap to play** button appears).

### Tips for reliable recognition
* Print the image reasonably large, matte if possible, good lighting, avoid glare.
* Use images with rich detail/contrast (photos with texture work; large flat areas or repeating patterns track poorly). Keep each printed image visually distinct from the others.
* Videos: **H.264 MP4** (what phones and editors produce). Supabase's free plan has a per-file upload limit (50 MB at the time of writing); keep videos short/compressed or raise the limit in your Storage settings if your plan allows.

---

## Testing

### What I actually ran (in my build environment)
| Test | How to run | Result |
|---|---|---|
| Real MindAR compile of 3 images, incremental merge, import with MindAR's own `importData`, order + data identical to standalone compiles, bad/old-format rejection | `cd dev-app && npm test` | **passed** |
| Viewer mapping loader: ordering by `pair_ids`, empty DB, server error, missing pair, target-count mismatch, 404 `.mind`, network failure, hung request → timeout, corrupt/old `.mind` | `cd viewer-app && npm test` | **passed** (9 scenarios) |
| `setup.sql` on real PostgreSQL 16 (with minimal stand-ins for Supabase's `auth`/`storage` schemas): idempotent re-run, anon cannot write or call `register_pair`, non-admin rejected, admin publishes 3 pairs in order, stale version → conflict with nothing written, viewer sees correct order | `supabase/test/sql-test.sh` (needs a local Postgres, see script header) | **passed** |
| Browser end-to-end in headless Chromium with a fake camera, against a local mock of the Supabase endpoints: empty-DB message; Dev App sign-in; two uploads with real in-browser compile + merge; no orphan files; Viewer recognises printed image 1 → plays video 1 (red on screen) and image 2 → video 2 (blue), never both; camera refusal shows an error with Retry | `cd e2e && ./run.sh` (needs python3 + playwright + Chromium + Pillow + ffmpeg) | **17/17 passed** |
| Production builds of both apps | `npm run build` in each | **passed** |

### What I could NOT test, and you must
* **Real Supabase:** the browser E2E used a local mock of the endpoints (not Supabase). RLS/policies were tested on plain Postgres with stand-in schemas, not on Supabase itself. Real Storage upload limits, Auth, CORS and bucket policies are untested until you run it with your credentials.
* **A real phone and a real printed image:** recognition was proven on a fake camera feed showing the image full-frame. Real-world behaviour (print quality, lighting, angle, distance, iOS Safari / Android Chrome video-autoplay and permission dialogs, in-app browsers such as Instagram/WhatsApp) needs a physical test. Headless Chromium's refusal error text differs from a real "permission denied" prompt, so the exact permission wording is untested in a browser.
* **H.264 MP4 playback:** the test videos were VP9-in-MP4 because the test Chromium has no H.264 decoder.
* Concurrent uploads from two browsers (the version-conflict retry path is exercised only at the SQL level).

### Manual end-to-end test (about 10 minutes)
1. Complete the setup above. Open the Dev App, sign in.
2. Upload pair A (image A + video A). Expect the green "Done" banner and A in "Registered pairs".
3. Open the Viewer on your phone (HTTPS). Expect "Point your camera…" and a **Start camera** button (not an endless spinner). Tap it, allow the camera.
4. Show image A (printed, or on another screen) → video A appears on it. Move the phone; it should stay attached.
5. Without redeploying anything, upload pair B in the Dev App. Reload the Viewer. Show image B → video B; show A again → video A (never the wrong one).
6. Failure checks: turn on airplane mode before loading the Viewer (expect an error and Retry); deny the camera (expect a permission message and Retry); in the Dev App pick a non-MP4 video (expect a clear rejection and nothing uploaded; Storage stays unchanged).

### Troubleshooting
| Symptom | Likely cause / fix |
|---|---|
| Dev App: "Supabase is not configured" | `.env.local` missing or still has placeholders; restart `npm run dev`. |
| Dev App: "not an admin" | Run the `insert into public.admins …` SQL from step 3. |
| Dev App: "bucket is public?" | Re-run `supabase/setup.sql`. |
| Upload fails on big video | Supabase per-file size limit; compress the video or raise the limit. |
| Viewer: "No images have been registered yet" | Upload one in the Dev App. |
| Viewer: "Tracking file has N targets but M mappings…" | Inconsistent data was refused on purpose; contact the developer / re-upload the latest pair. |
| Camera does not open | Page must be HTTPS; avoid in-app browsers; allow camera in site settings. |

---

## Limitations (v1)
* There is no delete/reorder UI. Removing a pair would require rebuilding the `.mind` without that target; it's deliberately left out rather than done unsafely.
* Compilation runs in the admin's browser (a few seconds to about a minute per image, depending on the device).
* Anyone who has a file URL can read it (public bucket, needed for direct MP4 streaming). Don't upload anything you consider private.

## Project layout
```
dev-app/      Vite app: sign-in, upload, compile, merge, publish   (own package.json, .env.example)
viewer-app/   Vite app: load mappings, camera, AR video            (own package.json, .env.example)
supabase/     setup.sql (schema, RLS, functions, storage) + test/ (Postgres checks)
e2e/          local mock Supabase + headless-browser end-to-end test
```

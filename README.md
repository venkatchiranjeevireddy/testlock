# Wedding AR System (MindAR.js + Supabase)

Two independent web apps that share one Supabase project:

| App | Folder | Who uses it | What it does |
|---|---|---|---|
| **Dev App** | `dev-app/` | You (admin) | Pick the original image + its MP4, press **Upload**. Everything else is automatic. |
| **Viewer App** | `viewer-app/` | Guests, on a phone | Open the link, allow the camera, point at the printed image, the matching video appears over it. |

Nothing here modifies the MindAR.js repository. MindAR is used as the published npm package `mind-ar@1.2.5`.

---

## Product overview

Wedding AR turns a printed wedding photograph, invitation, table card, or sign into an interactive video trigger:

1. A guest opens the Viewer link on a phone.
2. The guest grants camera permission.
3. The camera recognizes one of the registered printed images.
4. The matching wedding video appears directly over the image.
5. The guest can tap the sound control to hear audio.

The system is designed for client delivery:

* The client receives one public Viewer URL to place on a QR code, invitation, or event sign.
* The operator uses the private Dev App to add new image/video pairs.
* New content becomes available after a Viewer reload; no Viewer rebuild or redeployment is needed.
* Supabase stores the database records and media; Vercel (or another static host) serves the web app.

### Roles

| Role | Access | Responsibility |
|---|---|---|
| Guest | Viewer URL only | Allow the camera and show a printed target |
| Operator/admin | Dev App + Supabase Auth account | Upload and publish image/video pairs |
| Developer | Repository, hosting, and Supabase project | Initial setup, maintenance, troubleshooting, and releases |

The Viewer does not contain an admin login or upload controls. The Dev App should not be shared with guests.

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

## Architecture

```text
                    ┌────────────────────────────┐
                    │        Supabase project     │
                    │  Auth · Postgres · Storage   │
                    └──────────────┬─────────────┘
                                   │
                 ┌─────────────────┴─────────────────┐
                 │                                   │
       ┌─────────▼─────────┐               ┌─────────▼─────────┐
       │     Dev App       │               │    Viewer App      │
       │  private operator │               │  public guest URL  │
       │  sign in/upload   │               │  camera/AR/video   │
       └─────────┬─────────┘               └─────────┬─────────┘
                 │                                   │
                 └───────────────┬───────────────────┘
                                 │
                    `wedding-ar` public media bucket
```

### Frontend technologies

* **Vite** builds each app as a static site.
* **MindAR.js 1.2.5** compiles image targets and tracks them in the camera.
* **Three.js** renders each matching video as a plane.
* **Supabase JS** handles Auth, database reads, RPC calls, and Storage.
* **Web APIs** provide camera access, video playback, and file validation.

### Supabase objects

`supabase/setup.sql` creates the following:

| Object | Purpose |
|---|---|
| `public.admins` | Allow-list of users who may publish |
| `public.pairs` | One record for each image/video pair |
| `public.target_sets` | Immutable versions of the combined MindAR target file |
| `public.is_admin()` | Security-definer admin check |
| `public.register_pair(...)` | Atomic pair + target-set registration |
| `storage.objects` in bucket `wedding-ar` | Original images, MP4 files, and `.mind` files |

`pairs` and `target_sets` are publicly readable because guests use the anon key. Writes are not public: database writes go through the admin-only RPC, and Storage insert/update/delete policies require an authenticated admin.

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

On Windows PowerShell, use:
```powershell
Copy-Item .env.example .env.local
```

The two required variables are:
```text
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-PUBLIC-KEY
```

Use the base project URL, not the REST endpoint. If the dashboard shows a URL ending in `/rest/v1/`, remove that suffix before saving it. The anon key is expected in a browser application; never put the `service_role` key in either app, Git, Vercel, or a client message.

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

## Recommended Vercel deployment

The Viewer App can be deployed as its own GitHub repository, as in the `vierapp` deployment. If the repository contains only the contents of `viewer-app/`, use these settings:

| Vercel setting | Value |
|---|---|
| Framework Preset | Vite |
| Root Directory | `./` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` |

If the full monorepo is imported instead, set **Root Directory** to `viewer-app`.

Add these Vercel environment variables for **Production** (and Preview if preview deployments are needed):

```text
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-PUBLIC-KEY
```

Vercel may call the visibility mode **Config**. Choose **Config**, not **Secret**, because `VITE_` variables are intentionally embedded into the public browser bundle. This is safe only for the anon key; Supabase Row Level Security must remain enabled.

After changing environment variables, redeploy without cache. Vite reads these values at build time, so changing a Vercel variable does not change an already-created deployment.

For a production release:
1. Push the Viewer code to Git.
2. Confirm the Vercel build finishes with `✓ built`.
3. Confirm the deployment is marked **Ready**.
4. Open the HTTPS URL on a real phone.
5. Test one printed target and its video before sharing the link with guests.

The Viewer requires HTTPS for camera access. Vercel provides HTTPS automatically. Do not test the public app inside Instagram, WhatsApp, or another embedded browser; open it in Chrome or Safari.

---

## Daily use

* **Add a pair:** open the Dev App, sign in, choose image + MP4, press Upload, wait for the green "Done" banner. That's all. Repeat any time, today or next week.
* **Guests:** open the Viewer link, tap **Start camera**, allow access, point at the printed image. Tap **🔇 Tap for sound** to hear audio (videos start muted so mobile browsers allow autoplay; if a phone still blocks autoplay a **▶ Tap to play** button appears).

### Tips for reliable recognition
* Print the image reasonably large, matte if possible, good lighting, avoid glare.
* Use images with rich detail/contrast (photos with texture work; large flat areas or repeating patterns track poorly). Keep each printed image visually distinct from the others.
* Videos: **H.264 MP4** (what phones and editors produce). Supabase's free plan has a per-file upload limit (50 MB at the time of writing); keep videos short/compressed or raise the limit in your Storage settings if your plan allows.

---

## End-to-end operating procedure

### Before the event

1. Create the Supabase project and run `supabase/setup.sql`.
2. Create the operator Auth account and add it to `public.admins`.
3. Deploy the Viewer over HTTPS.
4. Prepare a test image and a short H.264 MP4.
5. Upload the test pair from the Dev App.
6. Test recognition on the actual phone models guests will use.
7. Print the exact uploaded image without cropping, stretching, or heavy compression.
8. Generate a QR code pointing to the Viewer URL.
9. Test the QR code, camera permission, target recognition, video, and sound at the venue.
10. Keep the Dev App URL private and keep a copy of the Supabase project owner/recovery details with the project owner.

### Adding client content

For every image/video pair:

1. Use a visually detailed image with good contrast.
2. Export the matching video as H.264 MP4.
3. Open the Dev App and sign in.
4. Add an optional internal label.
5. Select the original image and matching MP4.
6. Click **Upload** and wait for the green completion message.
7. Reload the Viewer and test the new image.

The label is for the operator only. It is not shown to guests.

### During the event

* Keep the Viewer URL unchanged so printed QR codes continue to work.
* If a new pair is uploaded, guests must reload the Viewer page to fetch the latest target set.
* Keep the original images available for testing and replacement.
* If mobile data is weak, preload expectations with the client: the Viewer must download the target data and video from the network.
* If sound is muted, tap the sound control; mobile browsers commonly begin videos muted to satisfy autoplay rules.

### After the event

* Keep the Supabase project and Storage files until the client confirms retention or deletion.
* Do not delete individual files manually unless the related target-set history is understood.
* Export or record the Viewer URL, Supabase project reference, deployed Git commit, and operator email in the client handoff.
* Rotate the operator password if the project was shared with temporary staff.

---

## Data and publishing lifecycle

### First upload

When the first pair is published:

1. The Dev App validates the selected files.
2. MindAR compiles the image into target data.
3. `images/<uuid>.<extension>` and `videos/<uuid>.mp4` are uploaded.
4. The combined target file is stored as `targets/v1-<uuid>.mind`.
5. `register_pair` creates the pair and target-set records in one transaction.
6. The Viewer reads version 1 and maps target index 0 to that pair.

### Later uploads

For the next pair, the Dev App downloads the latest `.mind`, appends the new target, and publishes a new immutable version. Existing target order is retained:

```text
target_sets.pair_ids[1] → MindAR target index 0
target_sets.pair_ids[2] → MindAR target index 1
...
```

The Viewer uses this order rather than database row order, so the correct video is always attached to the correct target.

### Failure and recovery

If validation, compilation, upload, verification, or registration fails:

* The database is not registered with an incomplete pair.
* Files created by that upload are cleaned up.
* The Viewer continues using the last valid target set.

If two operators publish simultaneously, the stale publisher receives a version conflict, re-downloads the latest set, merges again, and retries up to five times.

---

## Client handoff checklist

Use this checklist when delivering a project:

- [ ] Supabase project created and billing/limits reviewed
- [ ] `supabase/setup.sql` executed successfully
- [ ] Storage bucket `wedding-ar` is public for reads
- [ ] RLS policies are enabled
- [ ] Operator Auth account created
- [ ] Operator added to `public.admins`
- [ ] Viewer deployed over HTTPS
- [ ] Production environment variables configured in the hosting dashboard
- [ ] At least one real image/video pair tested
- [ ] QR code points to the final Viewer URL
- [ ] Target printed at the intended physical size
- [ ] Android Chrome test completed
- [ ] iPhone Safari test completed
- [ ] Venue lighting/glare test completed
- [ ] Client received Viewer URL and basic guest instructions
- [ ] Client knows that adding content requires the private Dev App
- [ ] Client knows that changing a Vercel environment variable requires a redeploy
- [ ] Client knows that a public media URL is not suitable for confidential content

### Guest instructions

Give guests only these instructions:

1. Scan the QR code.
2. Open the link in Chrome or Safari.
3. Tap **Start camera** and allow camera access.
4. Point the camera at the printed wedding image.
5. Tap the sound button if audio is muted.

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

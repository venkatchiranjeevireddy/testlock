"""
End-to-end browser test (headless Chromium + fake camera) of BOTH apps against the local mock Supabase.
 1. Dev App: sign in, upload image1+video1, then image2+video2 (real in-browser MindAR compile + merge + publish).
 2. Viewer App: camera feed shows printed image 1 -> must play video 1 (red). New session with image 2 -> video 2 (blue).
Usage: python3 run_e2e.py <assets_dir> <dev_dist> <viewer_dist>
"""
import sys, time, subprocess, os, json, urllib.request
from playwright.sync_api import sync_playwright

assets, dev_dist, viewer_dist = sys.argv[1:4]
procs = []
def bg(cmd, **kw):
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, **kw); procs.append(p); return p

bg(['node', os.path.join(os.path.dirname(__file__), 'mock-supabase.mjs')], env={**os.environ, 'QUIET': '1'})
bg(['python3', '-m', 'http.server', '4173', '--bind', '127.0.0.1', '-d', dev_dist])
bg(['python3', '-m', 'http.server', '4174', '--bind', '127.0.0.1', '-d', viewer_dist])
time.sleep(2)
state = lambda: json.load(urllib.request.urlopen('http://127.0.0.1:54400/__state'))

GPU = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
results = []
def check(name, ok, detail=''):
    results.append((name, ok, detail)); print(('PASS' if ok else 'FAIL'), name, detail, flush=True)

try:
    with sync_playwright() as pw:
        # ---------------- Viewer with NOTHING registered yet ----------------
        b0 = pw.chromium.launch(args=GPU)
        p0 = b0.new_page(); p0.goto('http://127.0.0.1:4174/')
        p0.wait_for_function("document.getElementById('msg').textContent !== 'Loading…'", timeout=30000)
        check('viewer: empty database shows a clear message (not endless Loading)', 'No images have been registered' in p0.inner_text('#msg'), p0.inner_text('#msg'))
        b0.close()

        # ---------------- Dev App ----------------
        b = pw.chromium.launch(args=GPU)
        page = b.new_page()
        logs = []
        page.on('console', lambda m: logs.append(m.text))
        page.on('pageerror', lambda e: logs.append('PAGEERROR ' + str(e)))
        page.goto('http://127.0.0.1:4173/')
        page.fill('input[type=email]', 'admin@example.test'); page.fill('input[type=password]', 'x')
        page.click('button[type=submit]')
        page.wait_for_selector('input[type=file]', timeout=20000)
        check('dev: signed in as admin, uploader visible', True)

        for n in (1, 2):
            page.fill('input[type=text]', f'pair{n}')
            page.set_input_files('input[accept^="image"]', os.path.join(assets, f'img{n}.jpg'))
            page.set_input_files('input[accept^="video"]', os.path.join(assets, f'vid{n}.mp4'))
            t0 = time.time()
            page.click('form.card button[type=submit]')
            page.wait_for_selector('.banner.ok, .banner.err', timeout=420000)
            ok = page.locator('.banner.ok').count() == 1
            txt = page.locator('.banner').first.inner_text()
            check(f'dev: upload pair {n} succeeded ({time.time()-t0:.0f}s)', ok, txt.replace('\n', ' | '))
            if not ok: print('\n'.join(logs[-10:]))
        s = state()
        check('state: 2 pairs, 2 target sets, latest set has 2 ordered ids', len(s['pairs']) == 2 and len(s['sets']) == 2 and len(s['sets'][-1]['pair_ids']) == 2)
        check('state: files = 2 images + 2 videos + 2 .mind (no orphans)', len(s['files']) == 6, str(s['files']))
        b.close()

        # ---------------- Viewer App ----------------
        def viewer_run(cam, expect_idx, expect_color, name):
            b = pw.chromium.launch(args=GPU + ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', f'--use-file-for-fake-video-capture={cam}', '--autoplay-policy=no-user-gesture-required'])
            ctx = b.new_context(viewport={'width': 480, 'height': 800}, permissions=['camera'])
            vp = ctx.new_page(); vlogs = []
            vp.on('console', lambda m: vlogs.append(m.text)); vp.on('pageerror', lambda e: vlogs.append('PAGEERROR ' + str(e)))
            vp.goto('http://127.0.0.1:4174/')
            vp.wait_for_selector('#action:not([hidden])', timeout=30000)
            check(f'viewer[{name}]: loaded mappings and shows Start (not stuck on Loading)', 'Start camera' in vp.inner_text('#action'))
            vp.click('#action')
            try:
                vp.wait_for_selector('#panel.hidden', state='attached', timeout=120000)
                check(f'viewer[{name}]: camera + tracking started', True)
            except Exception:
                check(f'viewer[{name}]: camera + tracking started', False, vp.inner_text('#msg')); print('\n'.join(vlogs[-8:])); b.close(); return
            playing = None
            for _ in range(240):  # up to ~60 s for recognition
                playing = vp.evaluate('''() => [...document.querySelectorAll("video")].map((v, i) => ({ i, src: v.currentSrc || v.src, playing: !v.paused && !v.ended && v.readyState > 2 })).filter(x => x.src.includes("/videos/"))''')
                if any(x['playing'] for x in playing): break
                time.sleep(0.25)
            active = [x for x in playing if x['playing']]
            check(f'viewer[{name}]: image recognised -> exactly one video playing', len(active) == 1, str(playing))
            if len(active) == 1:
                st = state(); want = st['pairs'][[p['id'] for p in st['pairs']].index(st['sets'][-1]['pair_ids'][expect_idx])]['video_path']
                check(f'viewer[{name}]: playing video is the one mapped to this image', active[0]['src'].endswith(want), f"{active[0]['src'].split('/')[-1]} vs {want.split('/')[-1]}")
                time.sleep(1.5)
                shot = os.path.join(assets, f'viewer-{name}.png'); vp.screenshot(path=shot)
                from PIL import Image
                im = Image.open(shot).convert('RGB'); w, h = im.size
                r, g, bl = [sum(c) / 25 for c in zip(*[im.getpixel((w // 2 + dx, h // 2 + dy)) for dx in range(-2, 3) for dy in range(-2, 3)])]
                dom = 'red' if r > 150 and bl < 100 else 'blue' if bl > 150 and r < 100 else f'other({int(r)},{int(g)},{int(bl)})'
                check(f'viewer[{name}]: on-screen overlay colour is {expect_color}', dom == expect_color, dom)
            b.close()
        viewer_run(os.path.join(assets, 'cam1.y4m'), 0, 'red', 'image1')
        viewer_run(os.path.join(assets, 'cam2.y4m'), 1, 'blue', 'image2')

        # ---------------- Camera permission denied ----------------
        b3 = pw.chromium.launch(args=GPU + ['--use-fake-device-for-media-stream', '--deny-permission-prompts'])
        c3 = b3.new_context(permissions=[])
        p3 = c3.new_page(); p3.goto('http://127.0.0.1:4174/')
        p3.wait_for_selector('#action:not([hidden])', timeout=30000); p3.click('#action')
        p3.wait_for_selector('#panel.error', timeout=40000)
        m = p3.inner_text('#msg')
        check('viewer: camera request refused -> error panel with Retry (no endless spinner)', 'Retry' in p3.inner_text('#action') and 'Starting camera' not in m, m)
        b3.close()
finally:
    for p in procs: p.terminate()

bad = [r for r in results if not r[1]]
print(f'\n{len(results)-len(bad)}/{len(results)} checks passed')
sys.exit(1 if bad else 0)

#!/usr/bin/env bash
# Generates test images, test videos and fake-camera feeds for run_e2e.py. Needs: python3 + Pillow, ffmpeg.
set -euo pipefail
OUT=${1:-/tmp/e2e}; mkdir -p "$OUT"; cd "$OUT"
python3 - <<'PY'
from PIL import Image, ImageDraw
import random
for n, seed in ((1, 11), (2, 222)):
    random.seed(seed)
    im = Image.new('RGB', (800, 600), (220, 220, 220)); d = ImageDraw.Draw(im)
    for i in range(500):
        c = tuple(random.randint(0, 255) for _ in range(3))
        x, y = random.randint(0, 800), random.randint(0, 600); s = random.randint(8, 60)
        if i % 2: d.rectangle([x, y, x + s, y + random.randint(8, 60)], fill=c)
        else: d.ellipse([x, y, x + s, y + s], fill=c)
    im.save(f'img{n}.jpg', quality=92)
PY
# VP9-in-MP4 so stock Chromium (no H.264 codec) can play it; real phones use normal H.264 MP4.
ffmpeg -y -loglevel error -f lavfi -i "color=c=red:s=640x480:d=4:r=25"  -c:v libvpx-vp9 -b:v 300k -pix_fmt yuv420p vid1.mp4
ffmpeg -y -loglevel error -f lavfi -i "color=c=blue:s=640x480:d=4:r=25" -c:v libvpx-vp9 -b:v 300k -pix_fmt yuv420p vid2.mp4
for n in 1 2; do ffmpeg -y -loglevel error -loop 1 -i img$n.jpg -t 6 -r 15 -vf scale=640:480 -pix_fmt yuv420p cam$n.y4m; done
echo "assets in $OUT"

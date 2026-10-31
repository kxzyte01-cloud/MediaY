"""Pipeline test for the fast export engine (mediay-fast.js) in a real browser.

Real MP4 files -> real WebCodecs decode -> trim/speed/fade/overlay/rotation compositing -> real WebCodecs encode ->
the result is decoded by ffmpeg and checked frame by frame.

Source frames carry a 12-bit "barcode" of their frame number in the top-left corner, so the test can tell exactly
which source frame ended up in which output frame.

CODEC NOTE: Playwright's bundled Chromium has no H.264 (licensing), but it does have VP9 in WebCodecs. This test therefore
runs the whole pipeline with VP9 in an MP4 container. Everything except the H.264-specific parts is exercised here; the
H.264 parts (avcC parsing, Annex B conversion) are covered by tests/fast.test.js. Real H.264 encode/decode is only
exercised on a device (or desktop Chrome): see docs/fast-export.md.

Needs: ffmpeg + ffprobe on PATH, Playwright with Chromium.
Run: python tests/fast_pipeline.py
"""
import base64, functools, http.server, json, shutil, socketserver, subprocess, sys, tempfile, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FPS = 30


def sh(*cmd, binary=False):
    r = subprocess.run(cmd, capture_output=True, check=True)
    return r.stdout if binary else r.stdout.decode()


def make_source(path, offset=0, rot=None, seconds=4):
    """640x360 VP9-in-MP4. Top-left: barcode of (frame number + offset). Background: dark gradient (asymmetric, for rotation checks)."""
    expr = ("if(lt(Y,24),if(lt(X,288),if(bitand(floor((N+%d)/pow(2,floor(X/24))),1),235,16),16),16+X/8+Y/8)" % offset)
    tmp = str(path) + ".tmp.mp4" if rot else str(path)
    sh("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c=black:s=640x360:r={FPS}:d={seconds}",
       "-vf", f"format=gray,geq=lum='{expr}',format=yuv420p", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "22", "-g", "15",
       "-deadline", "realtime", "-cpu-used", "5", "-an", tmp)
    if rot:
        sh("ffmpeg", "-y", "-loglevel", "error", "-display_rotation", str(rot), "-i", tmp, "-c", "copy", str(path))


def decode_gray(path, w, h):
    raw = sh("ffmpeg", "-v", "error", "-i", str(path), "-vf", "format=gray", "-f", "rawvideo", "-", binary=True)
    n = len(raw) // (w * h)
    return [raw[i * w * h:(i + 1) * w * h] for i in range(n)]


def barcode(frame, w):
    bits = ["1" if frame[12 * w + 12 + 24 * i] > 128 else "0" for i in range(12)]
    return int("".join(reversed(bits)), 2)


def mean(frame, w, x0, y0, x1, y1):
    vals = [frame[y * w + x] for y in range(y0, y1) for x in range(x0, x1)]
    return sum(vals) / len(vals)


HARNESS = """
async (spec) => {
  const Fast = window.MediaYFast;
  const clips = [];
  for (const c of spec.clips) {
    const blob = await (await fetch(c.url)).blob();
    const { video } = await Fast.demux(blob);
    clips.push({ file: blob, track: video, in: c.in, out: c.out, speed: c.speed || 1, fade: !!c.fade });
  }
  const choice = await Fast.chooseEncoderConfig({ W: spec.W, H: spec.H, fps: spec.fps, codecs: ['vp09.00.10.08'], acceleration: ['no-preference'], bitrate: 6e6 });
  const sink = new Fast.IvfSink('VP90', spec.W, spec.H, spec.fps);
  const overlays = (spec.overlays || []).map(o => {
    const c = new OffscreenCanvas(o.w, o.h), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, o.w, o.h);
    return { bitmap: c.transferToImageBitmap(), x: o.x, y: o.y, w: o.w, h: o.h, start: o.start, end: o.end };
  });
  let polled = 0;
  const progress = [];
  let result, error = null;
  try {
    result = await Fast.renderTimeline({ clips, W: spec.W, H: spec.H, fps: spec.fps, choice, sink, overlays,
      isCancelled: () => spec.cancelAfter != null && ++polled > spec.cancelAfter, onProgress: p => progress.push(p) });
  } catch (e) { error = String(e && e.message || e); }
  const bytes = sink.finish();
  let bin = '';
  for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return { error, result, progress, b64: btoa(bin) };
}
"""

BENCH = """
async () => {
  const Fast = window.MediaYFast;
  const choice = await Fast.chooseEncoderConfig({ W: 640, H: 360, fps: 30, codecs: ['vp09.00.10.08'], acceleration: ['no-preference'] });
  return await Fast.benchmarkEncoder(choice, 12);
}
"""


def main():
    work = Path(tempfile.mkdtemp(prefix="mediay-fast-"))
    try:
        shutil.copy(ROOT / "mediay-fast.js", work / "mediay-fast.js")
        (work / "index.html").write_text("<!doctype html><title>t</title>")
        make_source(work / "a.mp4", 0)
        make_source(work / "b.mp4", 1000)
        make_source(work / "rot.mp4", 0, rot=90)

        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(work))
        handler.log_message = lambda *a, **k: None
        socketserver.TCPServer.allow_reuse_address = True
        server = socketserver.TCPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://localhost:{server.server_address[1]}"

        failures = []

        def check(name, cond, detail=""):
            print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  [{detail}]"))
            if not cond:
                failures.append(name)

        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base + "/index.html")
            page.add_script_tag(url=base + "/mediay-fast.js")

            def render(case_id, spec):
                out = page.evaluate(HARNESS, spec)
                ivf = work / f"{case_id}.ivf"
                ivf.write_bytes(base64.b64decode(out["b64"]))
                return out, ivf

            def ids(ivf, w, h):
                frames = decode_gray(ivf, w, h)
                return [barcode(f, w) for f in frames], frames

            def clip(url, a, b, **kw):
                return dict(url=f"{base}/{url}", **{"in": a, "out": b}, **kw)

            # A. plain pass-through
            out, ivf = render("A", dict(W=640, H=360, fps=30, clips=[clip("a.mp4", 0, 2)]))
            got, _ = ids(ivf, 640, 360)
            check("A: 2 s clip -> 60 frames in order", out["error"] is None and got == list(range(60)), f"{out['error']} {got[:6]}...{got[-3:]} n={len(got)}")
            check("A: progress reaches 1", out["progress"] and out["progress"][-1] == 1, str(out["progress"][-2:]))

            # B. trim
            out, ivf = render("B", dict(W=640, H=360, fps=30, clips=[clip("a.mp4", 1.0, 2.0)]))
            got, _ = ids(ivf, 640, 360)
            check("B: trim 1.0-2.0 s -> source frames 30..59", got == list(range(30, 60)), f"{got}")

            # C. 2x speed
            out, ivf = render("C", dict(W=640, H=360, fps=30, clips=[clip("a.mp4", 0, 2, speed=2)]))
            got, _ = ids(ivf, 640, 360)
            check("C: 2x speed -> every 2nd frame, 30 frames", got == list(range(0, 60, 2)), f"{got}")

            # D. half speed
            out, ivf = render("D", dict(W=640, H=360, fps=30, clips=[clip("a.mp4", 0, 1, speed=0.5)]))
            got, _ = ids(ivf, 640, 360)
            check("D: 0.5x speed -> each frame twice, 60 frames", got == [k // 2 for k in range(60)], f"{got}")

            # E. two clips from two files, one continuous stream
            out, ivf = render("E", dict(W=640, H=360, fps=30, clips=[clip("a.mp4", 0, 1), clip("b.mp4", 1, 2)]))
            got, _ = ids(ivf, 640, 360)
            check("E: two clips join without gap or repeat", got == list(range(0, 30)) + list(range(1030, 1060)), f"{got}")
            frames_total = out["result"]["frames"] if out["result"] else None
            check("E: engine reports 60 frames", frames_total == 60, str(out["result"]))

            # F. lower output frame rate
            out, ivf = render("F", dict(W=640, H=360, fps=15, clips=[clip("a.mp4", 0, 2)]))
            got, _ = ids(ivf, 640, 360)
            check("F: 15 fps output from 30 fps source", got == list(range(0, 60, 2)), f"{got}")

            # G. overlay window (timeline seconds 0.5 .. 1.0 inclusive -> frames 15..30)
            out, ivf = render("G", dict(W=640, H=360, fps=30, clips=[clip("a.mp4", 0, 2)],
                                        overlays=[dict(x=300, y=200, w=40, h=40, start=0.5, end=1.0)]))
            _, frames = ids(ivf, 640, 360)
            lit = [i for i, f in enumerate(frames) if mean(f, 640, 310, 210, 330, 230) > 200]
            check("G: overlay visible exactly on frames 15..30", lit == list(range(15, 31)), f"{lit}")

            # G2. overlay on the second clip uses TIMELINE time, not clip time
            out, ivf = render("G2", dict(W=640, H=360, fps=30, clips=[clip("a.mp4", 0, 1), clip("b.mp4", 1, 2)],
                                         overlays=[dict(x=300, y=200, w=40, h=40, start=1.5, end=1.8)]))
            _, frames = ids(ivf, 640, 360)
            lit = [i for i, f in enumerate(frames) if mean(f, 640, 310, 210, 330, 230) > 200]
            check("G2: overlay timing continues across clips", lit == list(range(45, 55)), f"{lit}")

            # H. letterbox: 640x360 into a 360x640 portrait frame
            out, ivf = render("H", dict(W=360, H=640, fps=30, clips=[clip("a.mp4", 0, 1)]))
            _, frames = ivf and ids(ivf, 360, 640)
            f = frames[10]
            top = mean(f, 360, 0, 10, 360, 100); mid = mean(f, 360, 0, 300, 360, 340)
            check("H: letterbox bars are black, picture in the middle", top < 25 and mid > 25 and len(frames) == 30, f"top={top:.1f} mid={mid:.1f} n={len(frames)}")

            # I. rotation: compare with ffmpeg's own auto-rotated decode of the same file
            out, ivf = render("I", dict(W=360, H=640, fps=30, clips=[clip("rot.mp4", 0, 1)]))
            _, ours = ids(ivf, 360, 640)
            ref = decode_gray(work / "rot.mp4", 360, 640)
            def diff(a, b):
                return sum(abs(x - y) for x, y in zip(a[::7], b[::7])) / len(a[::7])
            wrong = bytes(reversed(ref[10]))  # 180 degrees off
            d_ok, d_bad = diff(ours[10][100 * 360:], ref[10][100 * 360:]), diff(ours[10][100 * 360:], wrong[100 * 360:])
            check("I: 90-degree metadata is honoured (matches ffmpeg's autorotate)", d_ok < 12 and d_ok * 2 < d_bad and len(ref) >= 30, f"d_ok={d_ok:.1f} d_bad={d_bad:.1f}")

            # J. fade in/out
            out, ivf = render("J", dict(W=640, H=360, fps=30, clips=[clip("a.mp4", 0, 2, fade=True)]))
            _, frames = ids(ivf, 640, 360)
            first, middle, last = mean(frames[0], 640, 0, 100, 640, 360), mean(frames[30], 640, 0, 100, 640, 360), mean(frames[-1], 640, 0, 100, 640, 360)
            check("J: fade starts and ends near black", first < middle * 0.4 and last < middle * 0.4, f"{first:.1f} {middle:.1f} {last:.1f}")

            # K. cancel stops cleanly and fast
            out, ivf = render("K", dict(W=640, H=360, fps=30, clips=[clip("a.mp4", 0, 3)], cancelAfter=10))
            check("K: cancel is reported and does not hang", out["error"] and "cancel" in out["error"].lower(), str(out["error"]))

            # L. self-test benchmark
            bench = page.evaluate(BENCH)
            check("L: encoder self-test reports a speed", bench["fps"] > 1, str(bench))
            print(f"   (info) software VP9 encoder self-test here: {bench['fps']:.0f} fps at 640x360")

            check("no page errors", not errors, str(errors))
            browser.close()
        server.shutdown()
        if failures:
            print(f"\n{len(failures)} FAILED: {failures}")
            sys.exit(1)
        print("\nAll fast-export pipeline checks passed.")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

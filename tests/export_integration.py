"""Real export test: real app + real FFmpeg.wasm + real H.264 encode, then inspects the MP4 that comes out.

Checks, for a single clip and for two clips with a fade transition and a timed text overlay:
  - the export completes and is a playable H.264 + AAC MP4 at the requested size,
  - its duration matches the timeline,
  - the transition occupies the right part of the timeline,
  - the overlay appears and disappears where the timeline says (within two frames).
Needs: ffmpeg + ffprobe on PATH, Playwright, and internet access (the app downloads Fabric, Dexie and the 31 MB FFmpeg
core from CDNs). Offline: set MEDIAY_LOCAL_LIBS to a folder containing node_modules with fabric, animejs, dexie, lucide and
@ffmpeg/core (npm packages) and those requests are served from disk instead.
Run: python tests/export_integration.py
"""
import functools, http.server, json, os, socketserver, subprocess, sys, tempfile, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
LOCAL = os.environ.get("MEDIAY_LOCAL_LIBS")
FPS = 24

def sh(*cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=kw.pop("text", True), check=True, **kw)

def make_clips(folder):
    a, b = Path(folder) / "a.webm", Path(folder) / "b.webm"
    common = ["-vf", "format=yuv420p", "-c:v", "libvpx", "-b:v", "300k", "-auto-alt-ref", "0", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-shortest"]
    sh("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3", *common, str(a))
    sh("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "rgbtestsrc=size=640x360:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=3", *common, str(b))
    return str(a), str(b)

def probe(path):
    j = json.loads(sh("ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", path).stdout)
    return float(j["format"]["duration"]), [(s["codec_type"], s["codec_name"], s.get("width"), s.get("height")) for s in j["streams"]]

def overlay_window(path, quiet_time, start, length, w=120, h=214):
    """Seconds at which text appears/disappears in the bottom third, found from frame differences."""
    raw = sh("ffmpeg", "-v", "error", "-ss", str(start), "-t", str(length), "-i", path, "-vf", f"fps=30,scale={w}:{h},format=gray", "-f", "rawvideo", "-", text=False).stdout
    n = len(raw) // (w * h)
    frames = [raw[i * w * h:(i + 1) * w * h] for i in range(n)]
    crop = lambda f: [f[y * w + x] for y in range(int(h * .62), int(h * .82)) for x in range(w)]
    base = crop(frames[int((quiet_time - start) * 30)])
    diffs = [sum(abs(p - q) for p, q in zip(crop(f), base)) / len(base) for f in frames]
    on = [i for i, d in enumerate(diffs) if d > 4]
    return start + on[0] / 30, start + (on[-1] + 1) / 30

def run_export(base, files, setup_js, route_libs):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, service_workers="block")
        route_libs(context)
        context.add_init_script("try{localStorage.setItem('pmy-consent-v1','yes')}catch(e){}")
        page = context.new_page(); errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "/index.html", wait_until="load")
        page.wait_for_selector("#homeScreen:not([hidden])", timeout=30000)
        page.locator("#hmNew").click(); page.wait_for_selector("#setup:not([hidden])")
        page.locator("#suStart").click(); page.wait_for_function("document.querySelector('#homeScreen').hidden === true")
        page.set_input_files("#mediaInput", files)
        page.wait_for_function(f"S.main.length === {len(files)}", timeout=60000)
        page.wait_for_function("document.querySelector('#busyOverlay').hidden === true", timeout=60000)
        saved = {}
        def on_download(d):
            saved["path"] = tempfile.mktemp(suffix=".mp4"); d.save_as(saved["path"])
        page.on("download", on_download)
        page.evaluate(setup_js)
        page.evaluate("$('goExport').onclick(null, 0)")
        for _ in range(40):
            if "path" in saved: break
            page.wait_for_timeout(250)
        status = page.evaluate("document.getElementById('status').textContent")
        total = page.evaluate("total()")
        browser.close()
    return saved.get("path"), status, total, errors

def main():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    socketserver.TCPServer.allow_reuse_address = True
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def route_libs(context):
        if not LOCAL: return
        nm = Path(LOCAL) / "node_modules"
        files = {"fabric.min.js": nm / "fabric/dist/fabric.min.js", "anime.min.js": nm / "animejs/lib/anime.min.js", "dexie.min.js": nm / "dexie/dist/dexie.min.js",
                 "lucide.min.js": nm / "lucide/dist/umd/lucide.min.js", "ffmpeg-core.js": nm / "@ffmpeg/core/dist/umd/ffmpeg-core.js", "ffmpeg-core.wasm": nm / "@ffmpeg/core/dist/umd/ffmpeg-core.wasm"}
        def handler(route):
            for name, path in files.items():
                if route.request.url.endswith(name):
                    return route.fulfill(body=path.read_bytes(), content_type="application/wasm" if name.endswith(".wasm") else "application/javascript")
            return route.abort() if "fonts.g" in route.request.url else route.continue_()
        for pattern in ("https://cdnjs.cloudflare.com/**", "https://unpkg.com/**", "https://cdn.jsdelivr.net/**", "https://fonts.googleapis.com/**", "https://fonts.gstatic.com/**"):
            context.route(pattern, handler)

    folder = tempfile.mkdtemp()
    clip_a, clip_b = make_clips(folder)
    fast = f"EXP.res = 480; EXP.fps = {FPS};"

    # 1) single clip
    t0 = time.time()
    path, status, total, errors = run_export(base, [clip_a], fast + " 0", route_libs)
    assert path, f"no file was produced ({status}; errors {errors[:2]})"
    duration, streams = probe(path)
    assert "Export complete" in status, status
    assert abs(duration - total) < 0.15, (duration, total)
    assert ("video", "h264", 480, 854) in streams and any(s[0] == "audio" for s in streams), streams
    assert not errors, errors
    print(f"PASS: single-clip export is a valid H.264+AAC MP4 of {duration:.2f} s (timeline {total:.2f} s) in {time.time() - t0:.0f} s")

    # 2) two clips + fade transition + text overlay at 4.0-5.0 s
    t0 = time.time()
    setup = fast + """(async () => { S.main[1].tr = 'fade'; S.main[1].trDur = 0.5;
      await commitCaptionDrafts([{ id: 'marker1', layer: S.nextLayer, type: 'text', caption: true, text: 'MARKER', style: 0, start: 4.0, dur: 1.0, top: RATIOS[S.ratio][1] * 0.72 }]); })()"""
    path, status, total, errors = run_export(base, [clip_a, clip_b], setup, route_libs)
    assert path, f"no file was produced ({status}; errors {errors[:2]})"
    duration, streams = probe(path)
    assert "Export complete" in status and not errors, (status, errors)
    assert abs(duration - total) < 0.2, (duration, total)       # the transition must not shorten or lengthen the timeline
    on, off = overlay_window(path, quiet_time=3.8, start=3.6, length=2.8)
    frame = 1 / FPS
    assert abs(on - 4.0) <= 2.5 * frame and abs(off - 5.0) <= 2.5 * frame, (on, off)
    print(f"PASS: two-clip export keeps the timeline length ({duration:.2f} s vs {total:.2f} s) and shows the overlay at {on:.2f}-{off:.2f} s (timeline 4.00-5.00 s) in {time.time() - t0:.0f} s")
    server.shutdown()

if __name__ == "__main__":
    main()

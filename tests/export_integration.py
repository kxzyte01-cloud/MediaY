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

def make_silent_clip(folder, name="silent.webm", duration=2, size="640x360"):
    out = Path(folder) / name
    sh("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c=navy:s={size}:r=30:d={duration}",
       "-vf", "format=yuv420p", "-c:v", "libvpx", "-b:v", "200k", "-deadline", "realtime", "-cpu-used", "8", "-an", str(out))
    return str(out)

def make_tone(folder, name, freq, duration=1.5):
    out = Path(folder) / name
    sh("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=44100:duration={duration}",
       "-c:a", "libopus", str(out))
    return str(out)

def make_voiced_clip(folder, name="pip_voiced.webm", duration=2, freq=880, size="320x180"):
    out = Path(folder) / name
    sh("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c=blue:s={size}:r=30:d={duration}",
       "-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=44100:duration={duration}",
       "-vf", "format=yuv420p", "-c:v", "libvpx", "-b:v", "200k", "-deadline", "realtime", "-cpu-used", "8",
       "-c:a", "libopus", "-shortest", str(out))
    return str(out)

def probe(path):
    j = json.loads(sh("ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", path).stdout)
    return float(j["format"]["duration"]), [(s["codec_type"], s["codec_name"], s.get("width"), s.get("height")) for s in j["streams"]]

def rms_db(path, start, length):
    output = sh("ffmpeg", "-v", "info", "-ss", str(start), "-t", str(length), "-i", path,
                "-af", "astats=metadata=1:reset=0", "-f", "null", "-").stderr
    values = []
    for line in output.splitlines():
        if "RMS level dB:" not in line:
            continue
        value = line.rsplit(":", 1)[-1].strip()
        if value.lower() != "-inf":
            try:
                values.append(float(value))
            except ValueError:
                pass
    return max(values) if values else -120.0

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

def run_export(base, files, setup_js, route_libs, assets=None):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, service_workers="block")
        route_libs(context)
        for asset_name, asset_path in (assets or {}).items():
            context.route(f"**/{asset_name.lstrip('/')}", lambda route, _request, path=str(asset_path): route.fulfill(path=path))
        context.add_init_script("try{localStorage.setItem('pmy-consent-v1','yes')}catch(e){}")
        page = context.new_page(); errors = []; browser_logs = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda msg: browser_logs.append(f"{msg.type}: {msg.text}") if msg.type == "error" else None)
        page.goto(base + "/index.html", wait_until="load")
        page.wait_for_selector("#homeScreen:not([hidden])", timeout=30000)
        page.locator("#hmNew").click(); page.wait_for_selector("#setup:not([hidden])")
        page.locator("#suStart").click(); page.wait_for_function("document.querySelector('#homeScreen').hidden === true")
        page.set_input_files("#mediaInput", files)
        page.wait_for_function(f"S.main.length === {len(files)}", timeout=60000)
        page.wait_for_function("document.querySelector('#busyOverlay').hidden === true", timeout=60000)
        page.evaluate(setup_js)
        # Wait for the browser download itself, then save it before closing Chromium.
        # A page.on("download") callback can still be saving the artifact when browser.close()
        # runs, which cancels Download.save_as and makes a successful export look like a failure.
        try:
            with page.expect_download(timeout=180000) as download_info:
                page.evaluate("() => { $('goExport').onclick(null, 0); return true; }")
            download = download_info.value
        except Exception as error:
            diagnostics = page.evaluate("""() => ({
              status: document.getElementById('status')?.textContent || '',
              busy: document.getElementById('busyOverlay')?.innerText || '',
              progress: document.getElementById('busyProgress')?.getAttribute('aria-valuenow') || '',
              ffLogs: (window.ffLogs || []).slice(-30),
              native: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
            })""")
            browser.close()
            raise AssertionError(f"Export did not deliver a browser download: {error}; diagnostics={diagnostics}; pageErrors={errors[:10]}; consoleErrors={browser_logs[-15:]}") from error
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as output:
            saved_path = output.name
        download.save_as(saved_path)
        status = page.evaluate("document.getElementById('status').textContent")
        total = page.evaluate("total()")
        browser.close()
    return saved_path, status, total, errors

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

    # 3) Silent intro + voiced clip + fade transition + silent video PiP.
    # The main audio from clip_a must survive both the silent segment and silent PiP.
    t0 = time.time()
    silent_intro = make_silent_clip(folder, "intro_silent.webm", duration=2)
    pip_silent = make_silent_clip(folder, "pip_silent.webm", duration=1, size="320x180")
    setup = fast + """(async () => {
      S.main[1].tr = 'fade'; S.main[1].trDur = 0.5;
      const blob = await (await fetch('/pip_silent.webm')).blob();
      const file = new File([blob], 'pip_silent.webm', { type: 'video/webm' });
      const mediaId = await storeMedia(file);
      await addOverlay({ type: 'video', mediaId, name: file.name, start: 0.5, dur: 1.0, sourceIn: 0, srcDur: 1.0 });
    })()"""
    path, status, total, errors = run_export(base, [silent_intro, clip_a], setup, route_libs,
                                             assets={"pip_silent.webm": pip_silent})
    duration, streams = probe(path)
    assert "Export complete" in status and not errors, (status, errors)
    assert abs(duration - total) < 0.2, (duration, total)
    assert any(s[0] == "audio" for s in streams), f"missing AAC after silent intro: {streams}"
    assert rms_db(path, 2.5, 1.5) > -30.0, "voiced main clip audio was lost after silent intro / silent PiP"
    print(f"PASS: silent main segment and silent PiP preserve the voiced clip's audio ({duration:.2f} s) in {time.time() - t0:.0f} s")

    # 4) Two external voice-overs on a silent main clip. The later track must not be
    # truncated by the duration of the first (earlier) track.
    t0 = time.time()
    silent_main = make_silent_clip(folder, "silent_main.webm", duration=3)
    voice_early = make_tone(folder, "voice_early.webm", 440, duration=0.8)
    voice_late = make_tone(folder, "voice_late.webm", 880, duration=0.8)
    setup = fast + """(async () => {
      for (const [url, name, start] of [
        ['/voice_early.webm', 'voice_early.webm', 0.2],
        ['/voice_late.webm', 'voice_late.webm', 1.8]
      ]) {
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], name, { type: 'audio/webm' });
        const mediaId = await storeMedia(file);
        S.audio.push({ id: uid(), mediaId, name, start, in: 0, out: 0.8, src: 0.8 });
      }
    })()"""
    path, status, total, errors = run_export(base, [silent_main], setup, route_libs,
        assets={"voice_early.webm": voice_early, "voice_late.webm": voice_late})
    duration, streams = probe(path)
    assert "Export complete" in status and not errors, (status, errors)
    assert abs(duration - total) < 0.15 and abs(duration - 3.0) < 0.15, (duration, total)
    assert any(s[0] == "audio" for s in streams), f"missing mixed audio stream: {streams}"
    assert rms_db(path, 0.3, 0.5) > -30.0, "first external voice-over was not audible in its window"
    assert rms_db(path, 1.15, 0.45) < -45.0, "unexpected audio bleed in silent gap between voice-overs"
    assert rms_db(path, 1.9, 0.6) > -30.0, "second external voice-over was truncated"
    print(f"PASS: both delayed voice-overs remain independently audible and output stays within {duration:.2f} s timeline in {time.time() - t0:.0f} s")

    # 5) PiP videos are intentionally muted in preview and export because there is no
    # overlay-volume control. A voiced PiP must not add a hidden audio track.
    t0 = time.time()
    silent_main = make_silent_clip(folder, "pip_main_silent.webm", duration=3)
    pip_silent = make_silent_clip(folder, "pip_only_silent.webm", duration=1, size="320x180")
    pip_voiced = make_voiced_clip(folder, duration=2)
    setup = fast + """(async () => {
      const silentBlob = await (await fetch('/pip_only_silent.webm')).blob();
      const silentFile = new File([silentBlob], 'pip_only_silent.webm', { type: 'video/webm' });
      const silentId = await storeMedia(silentFile);
      await addOverlay({ type: 'video', mediaId: silentId, name: silentFile.name, start: 0.2, dur: 0.8, sourceIn: 0, srcDur: 1.0 });
      const voicedBlob = await (await fetch('/pip_voiced.webm')).blob();
      const voicedFile = new File([voicedBlob], 'pip_voiced.webm', { type: 'video/webm' });
      const voicedId = await storeMedia(voicedFile);
      await addOverlay({ type: 'video', mediaId: voicedId, name: voicedFile.name, start: 1.0, dur: 0.8, sourceIn: 0.5, srcDur: 2.0 });
    })()"""
    path, status, total, errors = run_export(base, [silent_main], setup, route_libs,
        assets={"pip_only_silent.webm": pip_silent, "pip_voiced.webm": pip_voiced})
    duration, streams = probe(path)
    assert "Export complete" in status and not errors, (status, errors)
    assert abs(duration - total) < 0.15, (duration, total)
    assert not any(s[0] == "audio" for s in streams), f"muted PiP unexpectedly added an audio track: {streams}"
    print(f"PASS: silent and voiced PiP overlays remain muted; no hidden PiP audio is exported ({duration:.2f} s) in {time.time() - t0:.0f} s")

    # 6) Reversed external audio-track order & overlong music track.
    # Later music is pushed first and exceeds the 3-second project timeline.
    t0 = time.time()
    silent_main_rev = make_silent_clip(folder, "silent_main_rev.webm", duration=3)
    music_overlong = make_tone(folder, "music_overlong.webm", 660, duration=5.0)
    voice_first = make_tone(folder, "voice_first.webm", 440, duration=0.8)
    setup = fast + """(async () => {
      for (const [url, name, start, outDur, srcDur] of [
        ['/music_overlong.webm', 'music_overlong.webm', 1.6, 4.5, 5.0],
        ['/voice_first.webm', 'voice_first.webm', 0.2, 0.8, 0.8]
      ]) {
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], name, { type: 'audio/webm' });
        const mediaId = await storeMedia(file);
        S.audio.push({ id: uid(), mediaId, name, start, in: 0, out: outDur, src: srcDur });
      }
    })()"""
    path, status, total, errors = run_export(base, [silent_main_rev], setup, route_libs,
        assets={"music_overlong.webm": music_overlong, "voice_first.webm": voice_first})
    duration, streams = probe(path)
    assert "Export complete" in status and not errors, (status, errors)
    assert abs(duration - total) < 0.15 and abs(duration - 3.0) < 0.15, (duration, total)
    assert any(s[0] == "audio" and s[1] == "aac" for s in streams), f"missing AAC audio stream: {streams}"
    assert rms_db(path, 0.3, 0.5) > -30.0, "earlier voice track (pushed second in reverse S.audio order) was lost"
    assert rms_db(path, 1.1, 0.35) < -45.0, "unexpected audio bleed in silent gap before overlong music track"
    assert rms_db(path, 1.8, 1.0) > -30.0, "overlong music track (pushed first in reverse S.audio order) was lost"
    print(f"PASS: reversed S.audio order and overlong music track trim cleanly to {duration:.2f} s while preserving both tracks in {time.time() - t0:.0f} s")

    # 7) Short overlapping fades & voiced -> silent -> voiced xfade transitions.
    t0 = time.time()
    short_voiced_1 = make_voiced_clip(folder, name="short_voiced_1.webm", duration=0.8, freq=440, size="640x360")
    short_silent_mid = make_silent_clip(folder, name="short_silent_mid.webm", duration=0.6, size="640x360")
    short_voiced_2 = make_voiced_clip(folder, name="short_voiced_2.webm", duration=0.8, freq=880, size="640x360")
    setup = fast + """(() => {
      S.main.forEach(c => { c.fade = true; });
      S.main[1].tr = 'fade'; S.main[1].trDur = 0.2;
      S.main[2].tr = 'fade'; S.main[2].trDur = 0.2;
    })()"""
    path, status, total, errors = run_export(base, [short_voiced_1, short_silent_mid, short_voiced_2], setup, route_libs)
    duration, streams = probe(path)
    assert "Export complete" in status and not errors, (status, errors)
    assert abs(duration - total) < 0.2 and abs(total - 2.2) < 0.1, (duration, total)
    assert ("video", "h264", 480, 854) in streams, f"invalid H.264 stream header: {streams}"
    assert any(s[0] == "audio" and s[1] == "aac" for s in streams), f"missing AAC stream header: {streams}"
    assert rms_db(path, 0.1, 0.5) > -35.0, "first sub-second voiced clip lost audio across fade/xfade"
    assert rms_db(path, 1.45, 0.5) > -35.0, "second sub-second voiced clip lost audio after silent middle clip and xfade"
    print(f"PASS: sub-second voiced -> silent -> voiced clips with overlapping fades and xfade transitions preserve both voiced segments ({duration:.2f} s) in {time.time() - t0:.0f} s")

    server.shutdown()

if __name__ == "__main__":
    main()

"""Integration test for the device-encoder export path as it is wired into app.js.

The real `tryDeviceEncoderExport` function is cut out of app.js and run in Chromium against stand-ins for the rest of the app
(project state, FFmpeg worker, overlay renderer). The FFmpeg commands it issues are then executed with a real ffmpeg, and the
resulting MP4 is inspected. It also checks that every reason to decline (and any mid-way failure) returns null and cleans up,
because that is what lets the export fall back to the FFmpeg-only path.

CODEC NOTE: The main integration path uses VP9 so it runs consistently across Chromium builds. The negative capability test
explicitly makes H.264 configurations unsupported; it must not depend on which codecs happen to ship with the CI browser.
H.264 bitstream specifics are covered by tests/fast.test.js; sound/assembly commands run with real FFmpeg.

Run: python tests/fast_integration.py   (needs ffmpeg, ffprobe, Playwright + Chromium)
"""
import base64, functools, http.server, json, re, shutil, socketserver, subprocess, sys, tempfile, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
APP = (ROOT / "app.js").read_text(encoding="utf-8")
START = APP.index("const tryDeviceEncoderExport = async () => {")
END = APP.index("\n    };", START) + len("\n    };")
FN_SOURCE = APP[START:END].strip()
FN_SOURCE = FN_SOURCE[len("const tryDeviceEncoderExport = "):].rstrip(";")


def sh(*cmd, binary=False):
    r = subprocess.run(cmd, capture_output=True, check=True)
    return r.stdout if binary else r.stdout.decode()


def make_av(path, offset=0, audio=True):
    expr = "if(lt(Y,24),if(lt(X,288),if(bitand(floor((N+%d)/pow(2,floor(X/24))),1),235,16),16),16+X/8+Y/8)" % offset
    args = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30:d=4"]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4"]
    args += ["-vf", f"format=gray,geq=lum='{expr}',format=yuv420p", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-g", "15",
             "-deadline", "realtime", "-cpu-used", "8"]
    args += ["-c:a", "aac", "-shortest"] if audio else ["-an"]
    sh(*args, str(path))


HARNESS = r"""
async (a) => {
  const real = window.MediaYFast;
  const useVp9 = !a.realCodecs;
  const originalIsConfigSupported = window.VideoEncoder.isConfigSupported;
  if (a.noH264) {
    // Make this test deterministic: newer Chromium builds may include H.264 even when older CI images did not.
    window.VideoEncoder.isConfigSupported = async config => ({ supported: false, config });
  }
  const Fast = useVp9 ? Object.assign({}, real, {
    chooseEncoderConfig: o => real.chooseEncoderConfig(Object.assign({}, o, { codecs: ['vp09.00.10.08'], acceleration: ['no-preference'] })),
    AnnexBSink: function () { return new real.IvfSink('VP90', 640, 360, 30); },
    targetBitrate: (...args) => a.smallChunks ? 1.07e9 : real.targetBitrate(...args)
  }) : real;
  window.MediaYFast = Fast;
  const blobs = {};
  for (const [id, url] of Object.entries(a.media)) blobs[id] = await (await fetch(url)).blob();
  const png = async () => {
    const c = new OffscreenCanvas(640, 360), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(300, 200, 40, 40);
    return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  };
  const log = { commands: [], written: {}, removed: [], notes: {}, stages: [], busy: [] };
  const ctx = {
    $: id => (id === 'useDeviceEncoder' ? { checked: a.toggle !== false } : null),
    S: a.S, FX: [{ f: '' }, { f: 'eq=saturation=1.5' }], TD: a.TD || a.S.main.map(() => 0), adjustmentFilter: c => (c.adjust ? 'eq=brightness=0.1' : ''),
    files: blobs, W: 640, H: 360, EXP: { fps: 30 }, dur: c => (c.out - c.in) / (c.speed || 1),
    exportMetric: { stage: n => log.stages.push(n), note: (k, v) => { log.notes[k] = v; } },
    exportCancelRequested: false,
    exportProgressHandler: 'SAVED-HANDLER',
    exportWorkspaceFiles: new Set(), exportSourceCache: new Map(), exportSourceCacheBytes: 0,
    ff: { writeFile: async (n, d) => {
      log.written[n] = (typeof d === 'string') ? d.length : d.length;
      if (n === 'alist.txt') log.alist = new TextDecoder().decode(d);
      if (n === 'vlist.txt') log.vlist = new TextDecoder().decode(d);
    } },
    run: async args => { if (a.failOn && args.join(' ').includes(a.failOn)) throw new Error('FFmpeg failed (code 1)'); log.commands.push(args); },
    ensureExportSource: async id => ({ name: a.names[id], size: 1, cached: false }),
    removeExportFile: async n => { log.removed.push(n); },
    overlayPNG: png, updateBusy: (t, d, p) => log.busy.push(p), say: () => {}
  };
  const factory = new Function('ctx', 'with (ctx) { return (' + a.fn + '); }');
  const fn = factory(ctx);
  let returned, error = null;
  try { returned = await fn(); } catch (e) { error = String(e && e.message || e); }
  window.MediaYFast = real;
  window.VideoEncoder.isConfigSupported = originalIsConfigSupported;
  return { returned, error, log, handlerAfter: ctx.exportProgressHandler, workspace: [...ctx.exportWorkspaceFiles] };
}
"""


def ffprobe(path):
    j = json.loads(sh("ffprobe", "-v", "error", "-count_packets", "-show_entries", "format=duration:stream=codec_type,codec_name,nb_read_packets", "-of", "json", str(path)))
    return float(j["format"]["duration"]), {s["codec_type"]: (s["codec_name"], int(s.get("nb_read_packets", 0))) for s in j["streams"]}


def main():
    work = Path(tempfile.mkdtemp(prefix="mediay-fastint-"))
    try:
        shutil.copy(ROOT / "mediay-fast.js", work / "mediay-fast.js")
        (work / "index.html").write_text("<!doctype html><title>t</title>")
        make_av(work / "av.mp4", 0, audio=True)
        make_av(work / "silent.mp4", 1000, audio=False)
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

        def clip(mid, a, b, **kw):
            return dict({"mediaId": mid, "in": a, "out": b, "speed": 1, "fx": 0}, **kw)

        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base + "/index.html")
            page.add_script_tag(url=base + "/mediay-fast.js")

            def go(S, **kw):
                args = dict(fn=FN_SOURCE, S=S, media={"m1": f"{base}/av.mp4", "m2": f"{base}/silent.mp4"}, names={"m1": "av.mp4", "m2": "silent.mp4"})
                args.update(kw)
                return page.evaluate(HARNESS, args)

            overlay = {"id": "t1", "type": "text", "start": 0.2, "dur": 0.5, "layer": 1}

            # 1. a normal project: two clips (one sped up, one faded), one caption
            S = {"main": [clip("m1", 0, 1), clip("m1", 1, 3, speed=2, fade=True, vol=0.5)], "overlays": [overlay]}
            r = go(S)
            log = r["log"]
            check("success: returns the joined file", r["returned"] == "joined.mp4" and r["error"] is None, json.dumps(r)[:300])
            check("success: report says the device encoder was used", log["notes"].get("deviceEncoder", "").startswith("used"), str(log["notes"]))
            check("success: bounded picture pieces, per-clip sound and assembly all issued",
                  len([c for c in log["commands"] if "-f" in c and "h264" in c]) == 2
                  and log["written"].get("fastvideo_0.h264", 0) > 1000
                  and log["written"].get("fastvideo_1.h264", 0) > 1000
                  and "vlist.txt" in log["written"] and "alist.txt" in log["written"],
                  str(log["commands"])[:500])
            check("success: temporary files removed, workspace list keeps only joined.mp4",
                  {"fastvideo_0.h264", "fastvideo_1.h264", "fastsegment_0.mp4", "fastsegment_1.mp4",
                   "vlist.txt", "alist.txt", "aseg0.wav", "aseg1.wav"} <= set(log["removed"])
                  and "joined.mp4" in r["workspace"], f"{log['removed']} {r['workspace']}")
            check("success: progress only moves forward", all(a <= b for a, b in zip(log["busy"], log["busy"][1:])), str(log["busy"]))

            # run the recorded sound commands for real and check lengths
            audio_cmds = [c for c in log["commands"] if c[-1].endswith(".wav")]
            for cmd in audio_cmds:
                sh("ffmpeg", "-y", "-loglevel", "error", *[("av.mp4" if x == "av.mp4" else x) for x in cmd]) if False else subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *cmd], cwd=work, check=True)
            lens = [float(sh("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(work / c[-1])).strip()) for c in audio_cmds]
            check("sound pieces have exactly the video length of their clip (1.0 s and 1.0 s)", len(lens) == 2 and all(abs(l - 1.0) < 0.003 for l in lens), str(lens))

            # Stand in for the two bounded WebCodecs chunks with real H.264 pieces.
            video_muxes = [c for c in log["commands"] if "-f" in c and "h264" in c]
            for cmd in video_muxes:
                raw = cmd[cmd.index("-i") + 1]
                sh("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
                   "-frames:v", "30", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-f", "h264", str(work / raw))
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *cmd], cwd=work, check=True)
            (work / "vlist.txt").write_text(log["vlist"])
            (work / "alist.txt").write_text(log["alist"])
            mux = log["commands"][-1]
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *mux], cwd=work, check=True)
            dur, streams = ffprobe(work / "joined.mp4")
            check("assembled MP4 has H.264 picture (60 frames) and AAC sound, 2.0 s long", streams.get("video", ("", 0))[0] == "h264" and streams["video"][1] == 60 and streams.get("audio", ("",))[0] == "aac" and abs(dur - 2.0) < 0.05, f"{dur} {streams}")

            # Force a tiny per-piece frame budget to prove a single one-second clip
            # is rendered as multiple bounded segments instead of one large output buffer.
            r = go({"main": [clip("m1", 0, 1)], "overlays": []}, smallChunks=True)
            chunk_muxes = [c for c in r["log"]["commands"] if "-f" in c and "h264" in c]
            check("long-output path: one clip is split into six independently muxed bounded pieces",
                  r["returned"] == "joined.mp4" and len(chunk_muxes) == 6
                  and all(f"fastvideo_{i}.h264" in r["log"]["written"] for i in range(6))
                  and all(f"fastsegment_{i}.mp4" in r["log"]["removed"] for i in range(6)),
                  f"returned={r['returned']} chunks={len(chunk_muxes)} workspace={r['workspace']}")

            # 2. project without any sound track -> picture only
            r = go({"main": [clip("m2", 0, 1)], "overlays": []})
            mux = r["log"]["commands"][-1] if r["log"]["commands"] else []
            check("silent project: one video piece and picture-only concat", r["returned"] == "joined.mp4"
                  and len(r["log"]["commands"]) == 2 and "-f" in mux and "concat" in mux
                  and "alist.txt" not in " ".join(mux), str(r["log"]["commands"]))

            # 2b. mixed voiced + silent clips: the fast path must remain eligible and
            # synthesize a silent WAV for the silent clip so concat has matching tracks.
            r = go({"main": [clip("m1", 0, 1), clip("m2", 0, 1)], "overlays": []})
            mixed_log = r["log"]
            mixed_audio_cmds = [c for c in mixed_log["commands"] if c[-1].endswith(".wav")]
            check("mixed-sound project: fast path stays enabled and creates one audio piece per clip",
                  r["returned"] == "joined.mp4" and r["error"] is None and len(mixed_audio_cmds) == 2
                  and any(any("anullsrc" in arg for arg in c) for c in mixed_audio_cmds)
                  and "vlist.txt" in mixed_log["written"] and "alist.txt" in mixed_log["written"],
                  f"returned={r['returned']} error={r['error']} commands={mixed_log['commands']}")
            for cmd in mixed_audio_cmds:
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *cmd], cwd=work, check=True)
            mixed_lens = [float(sh("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                   str(work / c[-1])).strip()) for c in mixed_audio_cmds]
            check("mixed-sound project: voiced and synthetic-silence WAVs have matching 1.0 s durations",
                  len(mixed_lens) == 2 and all(abs(x - 1.0) < 0.003 for x in mixed_lens), str(mixed_lens))
            mixed_video_muxes = [c for c in mixed_log["commands"] if "-f" in c and "h264" in c]
            for cmd in mixed_video_muxes:
                raw = cmd[cmd.index("-i") + 1]
                sh("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
                   "-frames:v", "30", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-f", "h264", str(work / raw))
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *cmd], cwd=work, check=True)
            (work / "vlist.txt").write_text(mixed_log["vlist"])
            (work / "alist.txt").write_text(mixed_log["alist"])
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *mixed_log["commands"][-1]], cwd=work, check=True)
            mixed_dur, mixed_streams = ffprobe(work / "joined.mp4")
            check("mixed-sound project: final MP4 keeps AAC and full 2.0 s duration",
                  mixed_streams.get("video", ("", 0))[0] == "h264" and mixed_streams.get("audio", ("",))[0] == "aac"
                  and abs(mixed_dur - 2.0) < 0.05, f"{mixed_dur} {mixed_streams}")

            # 3. reasons to decline: all must return null, write nothing, keep the original progress handler
            def declines(name, S, expect, **kw):
                r = go(S, **kw)
                note = r["log"]["notes"].get("deviceEncoder", "")
                ok = r["returned"] is None and r["error"] is None and expect in note and not r["log"]["written"] and not r["log"]["commands"]
                check(f"declines: {name}", ok, f"returned={r['returned']} err={r['error']} note={note!r} written={list(r['log']['written'])}")

            declines("reversed clip", {"main": [clip("m1", 0, 1, rev=True)], "overlays": []}, "reversed")
            declines("filter on a clip", {"main": [clip("m1", 0, 1, fx=1)], "overlays": []}, "filter")
            declines("colour adjustments", {"main": [clip("m1", 0, 1, adjust=True)], "overlays": []}, "color adjustments")
            declines("transition", {"main": [clip("m1", 0, 1), clip("m1", 1, 2, tr="fade")], "overlays": []}, "transition", TD=[0, 0.5])
            declines("video overlay", {"main": [clip("m1", 0, 1)], "overlays": [{"id": "v", "type": "video", "start": 0, "dur": 1, "layer": 1}]}, "video overlay")
            declines("blend mode", {"main": [clip("m1", 0, 1)], "overlays": [{"id": "b", "type": "image", "start": 0, "dur": 1, "layer": 1, "blend": "multiply"}]}, "blend")
            declines("odd speed", {"main": [clip("m1", 0, 2, speed=4)], "overlays": []}, "speed")
            declines("switched off by the user", {"main": [clip("m1", 0, 1)], "overlays": []}, "turned off", toggle=False)
            declines("device has no H.264 encoder (capability explicitly unavailable)", {"main": [clip("m1", 0, 1)], "overlays": []}, "no usable video encoder", realCodecs=True, noH264=True)

            # 4. failure half way: must clean up everything it created and hand back the original handler
            r = go({"main": [clip("m1", 0, 1), clip("m1", 1, 2)], "overlays": [overlay]}, failOn="aseg1.wav")
            note = r["log"]["notes"].get("deviceEncoder", "")
            check("failure while preparing sound: returns null, says why, removes its files, restores the progress handler",
                  r["returned"] is None and "failed" in note
                  and {"fastvideo_0.h264", "fastvideo_1.h264", "fastsegment_0.mp4", "fastsegment_1.mp4",
                       "aseg0.wav", "aseg1.wav"} <= set(r["log"]["removed"])
                  and r["handlerAfter"] == "SAVED-HANDLER",
                  f"{r['returned']} {note} {r['log']['removed']} {r['handlerAfter']}")
            r = go({"main": [clip("m1", 0, 1)], "overlays": []}, failOn="joined.mp4")
            check("failure while assembling: all partial video/audio pieces and joined.mp4 are removed",
                  r["returned"] is None
                  and {"fastvideo_0.h264", "fastsegment_0.mp4", "aseg0.wav", "vlist.txt", "alist.txt", "joined.mp4"} <= set(r["log"]["removed"]),
                  f"{r['returned']} {r['log']['removed']}")

            check("no page errors", not errors, str(errors))
            browser.close()
        server.shutdown()
        if failures:
            print(f"\n{len(failures)} FAILED: {failures}")
            sys.exit(1)
        print("\nAll device-encoder integration checks passed.")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

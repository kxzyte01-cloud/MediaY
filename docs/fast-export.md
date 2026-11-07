# Device-encoder export (WebCodecs fast path)

## Why

The FFmpeg.wasm export decodes and encodes every frame in WebAssembly. On a phone that is the dominant cost: a 3 min 28 s
project took about two hours. The fast path decodes with the device's own video decoder, composites on a canvas and encodes
with the device's own H.264 encoder (hardware where the phone has it). FFmpeg is still used for sound and for the final MP4,
which is cheap work.

**No speed-up has been measured on a phone yet.** Do not quote one until it has been (see "Measuring on a device").

## How it works (`mediay-fast.js`, wired in at `tryDeviceEncoderExport` in `app.js`)

1. `demux()` reads the MP4/MOV `moov` box and builds the sample table. Sample bytes are read later in ranges, so a large file
   is never loaded whole.
2. For each clip a `VideoDecoder` is started at the key frame at or before the trim point. Decoded frames are picked per output
   slot with the same rule as FFmpeg's `fps` filter (rounding to nearest, ties to the later slot), which also handles speed
   changes and 60 -> 30 fps.
3. Each frame is drawn on a canvas (letterbox like `scale+pad`, rotation metadata applied, fade), then caption/sticker overlays
   are drawn for their timeline window. Overlay PNGs come from the existing `overlayPNG()` and are cropped to their visible
   pixels first, so many captions cost little memory.
4. The timeline is divided on output-frame boundaries into short pieces. The maximum piece duration is derived from the
   existing 32 MiB in-memory sink budget and the estimated output bitrate (capped at 30 seconds). Each piece gets a fresh
   encoder session and begins with a keyframe; its Annex B stream is immediately muxed into a small MP4 segment and the raw
   temporary stream is deleted before the next piece is rendered. Clip fades are applied only at the original clip edges.
5. FFmpeg extracts each original clip's sound once (trim, speed, volume, fade, padded to the accumulated frame duration) as WAV.
   A concat-demuxer stream-copy pass joins the video segments and audio pieces into `joined.mp4`; the normal audio-mix and
   save steps follow unchanged. This avoids a single multi-minute JS output buffer and avoids re-encoding during final assembly.

## When it is used

Used only when all of these hold; otherwise the FFmpeg-only path runs exactly as before:

- the export-sheet checkbox "Use this phone's video encoder" is on (default on);
- no clip is reversed, has a filter, colour adjustments or a transition; no overlay is a video or uses a blend mode;
  playback speed is between 0.5x and 2x;
- every source is a plain (non-fragmented), 8-bit MP4/MOV with H.264/HEVC/VP9 video that this device can decode;
- either all clips have a sound track or none do;
- the device accepts an H.264 encoder configuration at the export size and its 12-frame self-test runs at 2 fps or better.

If anything fails after it has started (decoder stall, encoder error, FFmpeg error, out of memory) it removes its files, restores
the progress handler and returns to the FFmpeg-only path. Each await in the render loop has a 30 s watchdog. The Export pane's
performance report records `deviceEncoder: used (...)` or `not used: <reason>` plus the encoder self-test result.

## Known limits

- The browser pipeline runs its deterministic frame-accuracy matrix with VP9 and also exercises the actual H.264 WebCodecs
  encoder/Annex B output when the installed Chromium build exposes it (`tests/fast_pipeline.py`). This is desktop CI coverage,
  not proof that a particular Android WebView exposes a working or fast hardware H.264 encoder; that must still be checked on a phone.
- Each individual encoded piece is bounded by the existing 32 MiB sink budget. FFmpeg.wasm's virtual filesystem still retains the muxed segments until final assembly, so total project size is not a hard 32 MiB limit but total output bytes still consume browser memory.
- Filters, colour adjustments, transitions, reverse, video overlays and blend modes still use the FFmpeg-only path (slow).
  Porting the filters to canvas, or a native Android encoder, are the next steps if those matter.
- Sound from a clip is extracted by FFmpeg from a copy of the source in its virtual filesystem (same cost as before). Extracting
  AAC straight from the file would avoid that copy.
- 10-bit/HDR and fragmented MP4 sources are declined.

## Tests

- `node --test tests/fast.test.js` - parser vs ffprobe (B-frames, moov at end/start), rotation, Annex B conversion decoded
  by ffmpeg, planning maths, unsupported inputs. Needs ffmpeg for the media cases.
- `python tests/fast_pipeline.py` - real browser: frame-accurate trim, speed, fps change, two-clip join, overlay timing,
  letterbox, rotation vs ffmpeg autorotate, fade, cancel.
- `python tests/fast_integration.py` - runs the real `tryDeviceEncoderExport` text from `app.js` against stand-ins and runs the
  FFmpeg commands it produces with a real ffmpeg; checks every decline reason and clean-up on failure.

## Measuring on a device

Export the same project twice, once with the checkbox on and once off, at the same resolution and fps, and copy the performance
report (Export pane -> Performance diagnostics) for each. Record device model, chipset, RAM, source resolution/codec and the
`deviceEncoder` line. Only then state a speed-up.


## Encoder self-test safety

The device encoder capability check has a shared 15-second deadline covering queue drain and encoder flush. If either stalls, the probe rejects, closes the encoder in a `finally` block, and lets the normal FFmpeg export path continue. This is a safety timeout, not a performance guarantee: actual speed and hardware support must still be verified on the target Android device.

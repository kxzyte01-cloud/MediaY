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
4. One continuous `VideoEncoder` session encodes the whole timeline (no per-clip segments, so no SPS/PPS mismatch between
   pieces). Output is converted to an Annex B stream.
5. FFmpeg extracts each clip's sound (trim, speed, volume, fade, padded to the exact video length) as WAV, then one command
   joins picture + sound into `joined.mp4`. The normal audio-mix and save steps follow unchanged.

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

- Real H.264 encode/decode has only been exercised through unit tests on the container/bitstream side
  (`tests/fast.test.js`). The browser pipeline tests use VP9 because Playwright's Chromium has no H.264. Whether Android WebView
  exposes a hardware (or fast software) H.264 encoder is device dependent and must be checked on a phone.
- The finished picture stream (about the output bitrate x duration) is held in memory before being handed to FFmpeg.
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

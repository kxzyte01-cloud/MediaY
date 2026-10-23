# Instructions for AI coding agents

## Read first

- `docs/timeline-trim-architecture.md` — timeline timing model, trim invariants, and the intended transactional edit architecture.
- `docs/performance-triage.md` — what has been optimized, known latency limits, release gates, and the prioritized next-agent task list.

## Project constraints

MediaY is a browser-first video editor with a Capacitor Android build. Project media is stored locally in IndexedDB; do not introduce an upload/server dependency for editing or captions without explicitly designing the privacy model and asking for user consent.

The main video lane is a serialized list. Audio and overlays use independent absolute timeline positions. Do not implement global ripple by shifting every `start` field: items crossing a ripple range need source-correct splitting, and video overlays must preserve `sourceIn`.

Treat timeline edits as transactions:
1. Capture stable target IDs and source/timeline times.
2. Validate all affected ranges before mutation.
3. Commit one complete valid state as one Undo operation, or leave the project unchanged.
4. Keep preview timing, audio timing, export timing, autosave, and Undo/Redo consistent.

The FFmpeg export runs in WebAssembly. Memory usage is a first-class constraint on Android. Keep source/overlay asset caches bounded and clean generated FFmpeg virtual-filesystem files on both success and failure.

Auto captions use Transformers.js Whisper. A first run downloads the model; browser model caching is enabled by the library. Caption inference is chunked, but source audio decoding still uses whole-buffer `decodeAudioData`, which is a known long-file latency bottleneck. Do not claim performance improvements without recording measurements on real media.

## Required validation

For JavaScript changes:
```sh
node --check app.js
node --check setup.js
node --check sw.js
```

For browser and media-worker regressions, install Playwright plus Chromium and run:
```sh
python test_smoke.py
python test_ffmpeg_worker.py
```

The GitHub Actions **MediaY smoke tests** workflow runs those checks for pull requests. **Build APK** compiles the Android debug APK and uploads it as `ProjectMedia-Y-apk`. A worker smoke test is not a substitute for an app-level export test; add real end-to-end export coverage as the next agent task.

Do not merge if the same PR head has a failing/pending required check. After code changes, verify the Android APK build as well as browser tests.

## Releases

A push/merge to `main` builds and uploads an APK artifact but does not publish a GitHub Release automatically. Release publication is explicit: use **Actions → Build APK → Run workflow** and opt in to **Publish a GitHub Release for this APK build**. Do not trigger a release simply to make code available for another agent.

## Known scope gaps

- Physical-device export performance has not yet been benchmarked.
- No full app-level automated test validates export duration, frame/audio sync, and repeat export after Undo/Redo.
- Export cancellation and stage-by-stage timing diagnostics are not implemented.
- Whole-media caption audio decoding is still slow for long videos.
- Multi-thread FFmpeg has not been enabled; it requires cross-origin isolation / `SharedArrayBuffer` verification and may increase memory use.
- Global ripple-across-tracks, slip, and roll edits are not yet implemented.

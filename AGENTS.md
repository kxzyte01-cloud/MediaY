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

The FFmpeg export runs in WebAssembly (unless the device-encoder path in `docs/fast-export.md` handles the video). Memory usage is a first-class constraint on Android. Keep source/overlay asset caches bounded and clean generated FFmpeg virtual-filesystem files on both success and failure.

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

The GitHub Actions **MediaY smoke tests** workflow runs those checks for pull requests. **Build APK** compiles the Android debug APK and uploads it as `MediaY-debug-apk`. The build also stamps a monotonically increasing Android version code from the workflow run number. A worker smoke test is not a substitute for an app-level export test; add real end-to-end export coverage as the next agent task.

Do not merge if the same PR head has a failing/pending required check. After code changes, verify the Android APK build as well as browser tests.

## Releases

A push/merge to `main` builds and uploads only a **debug APK**. It does not publish a GitHub Release automatically.

Production release publication is explicit: use **Actions → Build APK → Run workflow** and opt in to **Build, sign, and publish a production GitHub Release**. Before doing so, the repository owner must configure these Actions secrets:

- `ANDROID_KEYSTORE_BASE64`: Base64-encoded contents of the private release keystore.
- `ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `ANDROID_KEY_ALIAS`: signing key alias.
- `ANDROID_KEY_PASSWORD`: key password.

Never commit the keystore, print the secrets, or replace an established app signing key without a deliberate migration plan. The workflow decodes the keystore into the ephemeral runner, builds `assembleRelease`, verifies the resulting APK with Android `apksigner`, and publishes the signed APK plus a SHA-256 checksum. Release tags are `v1.0.<workflow-run-number>`; Android `versionCode` uses the same positive run number. If a signing secret is absent, the release job should fail rather than publish a debug or unsigned APK. Debug APKs and production-signed APKs are different signing identities and may not update each other in place.

## Known scope gaps

- Physical-device export performance has not yet been benchmarked.
- The device-encoder (WebCodecs) export path in `mediay-fast.js` is new and has not run on a physical Android device. See `docs/fast-export.md`; it falls back to the FFmpeg-only path on any problem, and its H.264 encode/decode is untested in CI (Playwright's Chromium has no H.264).
- No full app-level automated test validates export duration, frame/audio sync, and repeat export after Undo/Redo.
- Export cancellation is not implemented. Export/caption stage timing diagnostics are available in the Export pane, but physical-device benchmark data is still missing.
- Whole-media caption audio decoding is still slow for long videos.
- Multi-thread FFmpeg has not been enabled; it requires cross-origin isolation / `SharedArrayBuffer` verification and may increase memory use.
- Global ripple-across-tracks, slip, and roll edits are not yet implemented.

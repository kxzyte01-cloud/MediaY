# MediaY Performance Triage and Next-Agent Handoff

## Current branch changes

This branch adds:
- **Fast draft export**: one click selects 480p / 24 fps. The regular resolution and frame-rate controls remain available for final output.
- **Bounded FFmpeg source cache**: source media assets are reused across repeated clip edits within an export, with a 96 MiB cache budget. Assets too large to cache are transient; the intent is to reduce repeated reads/writes without unbounded WebAssembly memory retention.
- **Bounded overlay PNG cache**: reusable image/text overlay renders are cached within an export, with a 12 MiB budget. Active assets are pinned while an encode pass is using them.
- **FFmpeg workspace cleanup ledger**: known generated input/output files are cleaned on normal completion and recoverable failures.
- **Chunked automatic captions**: transcription inference is issued in 30-second chunks and reports progress at each completed chunk.
- **Caption cancellation and transactional apply**: cancellation is honored between inference/object-build steps; draft captions are only committed after inference finishes. A cancelled inference should not leave a partial caption set.
- **Bounded audio decode reuse**: one decoded audio buffer is reused at most per caption operation, with channel downmixing and 16 kHz resampling when needed.
- **Silent-source skip**: very-low-energy audio tracks are skipped before inference.
- **Batched canvas work**: caption text objects are built without restacking after each item; the layer stack is recalculated once per batch.

## What is verified

On the current feature branch:
- JavaScript syntax check passed.
- Browser smoke tests passed, including trim/undo/redo regressions, fast preset settings, 30-second ASR chunk boundaries, caption source-time offsets, cancel-without-partial-drafts, and silent-audio skip.
- The FFmpeg worker integration smoke test passed.
- Android debug APK build passed.

These are correctness gates, not performance benchmarks. Do not claim a quantified speedup yet; measure representative media on a real device.

## Performance reports available in the app

The Export pane now contains **Performance diagnostics** and **Copy performance report**. The report captures the latest export and caption operation in the current app session. It contains timestamps, settings/counts, stage wall times, and FFmpeg command categories; it intentionally excludes media filenames and media content.

For export, compare preflight/media validation, FFmpeg initialization, asset staging + clip encoding, transition rendering, segment joining, audio mixing, output saving, and cleanup. FFmpeg command time categories are a subset of the stage totals, not additive extra time. For captions, compare model/runtime load, audio decode/resampling, inference, caption overlay creation/commit, and resource cleanup.

On captions, the busy progress dialog now exposes **Request cancellation** too; the previous button lived behind the blocking dialog and could not be clicked during generation. Cancellation is cooperative: it is honored when the current model/audio operation or inference chunk returns. It cannot instantly interrupt an in-flight WASM/GPU inference or the model download.

## Why export can still be slow

MediaY's export path uses FFmpeg WebAssembly in a worker. It encodes main clips individually, applies filters/overlays during each encode, assembles clips, then may mix separate audio tracks. This is substantially more work than a single simple transcode, and repeated clips, many overlays, transitions, high frame rates, and high output resolutions all add cost.

The cache avoids redundant work for repeated source IDs and reusable overlays, but unique large files still need to be copied into FFmpeg's virtual filesystem. The regular export remains a quality-oriented preset; use Fast draft (480p / 24 fps) to validate timing and structure quickly.

Official FFmpeg.wasm performance notes: https://ffmpegwasm.netlify.app/docs/performance/
Official FFmpeg.wasm threading requirements: https://ffmpegwasm.netlify.app/docs/getting-started/usage/#multi-thread
Threaded WebAssembly requires `SharedArrayBuffer` and cross-origin isolation. It is not safe to switch to the multi-thread core until the website host and Android WebView paths can satisfy the required headers and pass memory tests.

## Why automatic captions can still be slow

Captions currently rely on a Transformers.js Whisper-tiny pipeline. The first run downloads a speech model; WebGPU is attempted when the browser advertises it, with a compatibility fallback. Each source still passes through browser `decodeAudioData` for its full encoded media buffer before PCM slicing. That full-file decode and the first model download may dominate time for long source videos.

Chunked inference improves progress reporting, cancellation points, and inference task size; it does **not** guarantee lower total inference time and does not solve whole-file decode latency. Do not hide that distinction in the UI.

Transformers.js model/runtime documentation: https://huggingface.co/docs/transformers.js/guides/webgpu
ASR chunking parameters: https://huggingface.co/docs/transformers.js/api/pipelines#automaticspeechrecognitionspecificparams

## Prioritized work list for the next AI agent

### P0 — measure before changing more knobs
1. Add stage timings around source validation, FFmpeg initialization, input-file staging, each clip encode, transition assembly, audio mixing, and output writing. Show the totals in a diagnostics panel or copyable report.
2. Benchmark the same 30-second and 3-minute test assets at 480p/24, 720p/30, and 1080p/30 on desktop Chromium and a physical Android device. Capture wall-clock time, peak memory if available, output size, output duration, and frame/audio sync.
3. Add a genuine app-level export integration fixture with generated short video + audio, overlays, and one transition. Verify exported frames, audible audio, duration, and repeat export after Undo/Redo. The existing worker smoke test is not full export-path coverage.

### P1 — tackle actual wall-clock bottlenecks
4. Replace full-file caption decode with source-range/streaming audio decode. Evaluate a maintained MP4 demuxer + WebCodecs path and compare it against FFmpeg extraction; preserve container support and Android fallback behavior.
5. Use the in-app stage report to profile Whisper model download, model initialization, decode, and inference separately. Benchmark WebGPU and WASM on supported devices and languages. Keep the compatibility path and do not make a model/version upgrade without comparing WER/quality, load time, steady-state time, cancellation behavior, and peak memory.
6. Profile cache hit rate and source staging. Tune the bounded FFmpeg FS budgets from device measurements; test many unique sources and alternating repeated clips to ensure the cache neither increases OOMs nor leaves stale virtual files.
7. Evaluate `@ffmpeg/core-mt` only after configuring cross-origin isolation for every web deployment and verifying Capacitor/WebView support. Multi-threading can improve throughput but increases CPU/memory pressure and is not a free upgrade.

### P1 — fault tolerance and UX
8. Add an export-cancel action with explicit semantics. FFmpeg WASM currently runs a long task in its worker; design termination/recovery so cancellation cleans workspace files and the next export reloads the engine safely.
9. Improve caption failures by classifying no audio, no speech, offline model download, GPU initialization/inference, and decode failure separately. Preserve the project unchanged on cancellation/failure.
10. Ensure export output and saved project are not reported complete until the output file has actually been saved/shared, and validate the second export after an engine recovery.

### P2 — editing foundation
11. Centralize edits as validated commands over candidate state; one edit equals one Undo step or no mutation.
12. Implement selected-lane ripple, all-unlocked-tracks ripple, slip, and roll as distinct commands. When a time cut crosses audio or video overlays, split source ranges correctly and preserve transforms/effects/source offsets. Never implement global ripple by indiscriminately shifting all `start` fields.
13. Add fractional frame-rate/VFR tests and separate project-frame positions from source timestamps.
14. Add keyboard shortcuts only after each shortcut routes through the same edit-command implementation.

## Merge and release policy

The trim/performance branch may merge after syntax, browser tests, FFmpeg worker integration, and Android APK build all pass on the same branch head. A merge to `main` should build and upload the APK artifact but must not automatically publish a GitHub Release. Release publication is opt-in through **Actions → Build APK → Run workflow → Publish a GitHub Release for this APK build**.

Before calling the latency work complete, run the representative on-device benchmarks above and record the actual timings. Do not publish a release based on a successful build alone.

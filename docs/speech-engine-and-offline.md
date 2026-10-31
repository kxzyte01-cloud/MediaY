# Speech captions: what needs the internet, what is stored where

Automatic captions use three separate pieces. They fail, cache and recover independently.

| Piece | Size | Where it comes from | Stored where | Needs internet? |
|---|---|---|---|---|
| Speech library (JavaScript) | 0.9 MB | **Bundled in the app** by the build (fetched from npm and SHA-256 verified by `scripts/fetch_speech_engine.sh`): `vendor/transformers/transformers.min.js` (@xenova/transformers 2.17.2) | Inside the APK | No |
| Speech runtime (WebAssembly) | 10 MB (+9 MB fallback) | **Bundled in the app**: `vendor/transformers/ort-wasm-simd.wasm`, `ort-wasm.wasm` | Inside the APK | No |
| Speech model (Whisper tiny) | ~40 MB | huggingface.co, first use only | Browser Cache Storage `transformers-cache` inside the app's private storage | **Yes, once.** Then no, while Android keeps the app's storage |

Optional GPU engine (transformers 3.x, `useWebGPU`): its library is loaded from cdn.jsdelivr.net each time it is used
(not bundled). If it cannot be loaded, MediaY uses the bundled CPU engine automatically.

## Behaviour
- **First captions run, online:** library + runtime load from the app, then the 40 MB model downloads with one overall percentage.
  Files that finished downloading are kept if the download is interrupted; the next attempt continues with the rest.
- **Later runs, offline:** work, provided the model files are still in the cache. Android can clear them if the user clears app
  storage or the phone is critically low on space. Then the next run needs the internet once more.
- **First run, offline:** MediaY says so plainly ("not downloaded yet… connect once, about 40 MB") instead of a technical error.
- **Damaged cache:** a model file that fails to parse is deleted once and downloaded again automatically.
- **Retries:** up to 3 model attempts (1.5 s, 3 s back-off). The online fallback copy of the library gets 3 attempts with a fresh URL
  each time (browsers remember a failed `import()` of the same URL).
- **Cancel:** checked between attempts and between 30-second audio windows. A download that is already in progress cannot be
  aborted mid-file (the library offers no way to), so the cancel takes effect when that step ends.

## Other downloads the app makes (not captions)
- FFmpeg core (31 MB, jsdelivr): downloaded on first export, cached in Cache Storage. **The first export needs the internet.**
- Fabric, Dexie, anime.js, Lucide and the DM Sans font load from CDNs on every start (the Android shell does not bundle them yet).

## Making captions fully offline later
Place the Whisper model files under `models/Xenova/whisper-tiny/` in the web bundle and set `env.allowLocalModels = true`,
`env.localModelPath = './models/'` in `createSpeechPipeline`. This is NOT done: the model could not be downloaded in the
build environment and it would add ~40 MB to the APK.

## Verification
`python tests/offline_speech_runtime.py` runs a real ONNX inference through the bundled library and runtime with every
external request blocked (it also fails if the bundled WASM is removed, which is the failure mode of a library-only bundle).

# Bundled speech engine (CPU)

The four third-party files below are NOT committed to Git (they are listed in `.gitignore`). `bash scripts/fetch_speech_engine.sh`
downloads `@xenova/transformers@2.17.2` from npm and refuses to continue unless every file matches `SHA256SUMS`. CI and the APK
build run it automatically. Only `SHA256SUMS` and this README are committed.

- `transformers.min.js` — @xenova/transformers 2.17.2 `dist/transformers.min.js`, unmodified (Apache-2.0, see LICENSE).
- `ort-wasm-simd.wasm`, `ort-wasm.wasm` — the ONNX Runtime WebAssembly binaries shipped in the same npm package
  (`dist/`). Without them the library downloads its runtime from cdn.jsdelivr.net, so the library alone is NOT offline-capable.
  Only the single-thread variants are bundled because the Android WebView is not cross-origin isolated (no threads).
- `SHA256SUMS` — checked in CI (`sha256sum -c SHA256SUMS`). To update: `npm pack @xenova/transformers@<version>`, copy the
  four files above from the package, regenerate `SHA256SUMS`, and update `SPEECH_ENGINE` in `app.js`.

The speech MODEL (Xenova/whisper-tiny, ~40 MB) is not bundled: it downloads from huggingface.co on first use and is kept in
the browser Cache Storage (`transformers-cache`).


## Android test APKs and signing

The APK produced by the normal GitHub Actions build is a **debug APK** signed with the runner's generated debug keystore. A fresh runner can generate a different key, so debug APKs from separate workflow runs are not guaranteed to install as updates over one another. If Android reports a signature conflict, uninstall the older debug build before installing the newer one; this removes app-private local projects and imported media, so export or back up anything important first.

A production-signed APK can only be built with the project's original signing keystore and credentials. CI success or a successful APK build does not establish that the APK was installed or tested on a physical Android phone.

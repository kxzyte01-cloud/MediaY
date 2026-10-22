# MediaY FFmpeg worker assets

These files are the small UMD wrapper and worker chunk from `@ffmpeg/ffmpeg` 0.12.15.

- `ffmpeg.js`: exposes `FFmpegWASM.FFmpeg`.
- `814.ffmpeg.js`: class worker chunk loaded by the wrapper.
- `LICENSE`: upstream MIT license.

The wrapper and worker are served from the same origin as MediaY. The upstream wrapper derives the worker URL from the script's own location, so it must be loaded from this local path using a normal script tag; loading it dynamically from a CDN may point the browser at a cross-origin worker URL and fail with an unloaded FFmpeg engine.

The much larger `@ffmpeg/core` JS and WASM files are fetched at runtime from jsDelivr and converted to blob URLs before loading. MediaY's current code pins the core to `@ffmpeg/core@0.12.6`.

Upstream project: https://github.com/ffmpegwasm/ffmpeg.wasm
Vendored source copy: https://github.com/simonw/tools/tree/befbcec31fc3990b87957a7322da61a6c59708bc/ffmpeg-wasm

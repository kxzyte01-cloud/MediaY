#!/usr/bin/env bash
# Downloads the pinned speech engine files (library + ONNX Runtime WASM) from the npm registry and verifies
# their SHA-256 checksums against vendor/transformers/SHA256SUMS. Nothing is trusted unless the checksums match.
# Used by the CI workflows before the tests and before the APK web bundle is assembled.
# Local use:  bash scripts/fetch_speech_engine.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="2.17.2"
DEST="vendor/transformers"
mkdir -p "$DEST"
if (cd "$DEST" && sha256sum -c SHA256SUMS >/dev/null 2>&1); then
  echo "Speech engine files already present and verified."
  exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
(cd "$TMP" && npm pack "@xenova/transformers@${VERSION}" --silent >/dev/null && tar -xzf ./*.tgz)
for f in transformers.min.js ort-wasm-simd.wasm ort-wasm.wasm; do cp "$TMP/package/dist/$f" "$DEST/$f"; done
cp "$TMP/package/LICENSE" "$DEST/LICENSE"
(cd "$DEST" && sha256sum -c SHA256SUMS)
echo "Speech engine ${VERSION} downloaded and verified."

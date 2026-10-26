"""Proves the bundled speech engine (JavaScript + WASM runtime) runs with ALL external network blocked.

It loads vendor/transformers/transformers.min.js in headless Chromium, points the library at the bundled WASM
runtime exactly as app.js does (SPEECH_ENGINE.bundledRuntime), and runs a real ONNX inference on a tiny local model.
The Whisper model weights are NOT bundled, so this does not claim offline captions: only that the code and runtime
need no internet. Run: python tests/offline_speech_runtime.py
"""
import base64, functools, http.server, json, re, socketserver, subprocess, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FETCH = ROOT / "scripts" / "fetch_speech_engine.sh"
MODEL_B64 = ROOT / "tests" / "fixtures" / "offline" / "tiny_model.onnx.b64"   # a 343-byte ONNX graph, stored as text
PAGE = """<!doctype html><meta charset=utf-8><script type="module">
window.run = async () => {
  const { env, AutoModel, Tensor } = await import('/vendor/transformers/transformers.min.js');
  env.allowLocalModels = true; env.allowRemoteModels = false; env.useBrowserCache = false;
  env.localModelPath = '/tests/fixtures/offline/models/';
  env.backends.onnx.wasm.wasmPaths = new URL('/vendor/transformers/', location.href).href;   // same as app.js
  env.backends.onnx.wasm.numThreads = 1;
  const model = await AutoModel.from_pretrained('tiny', { quantized: false });
  const ids = a => new Tensor('int64', BigInt64Array.from(a.map(BigInt)), [1, a.length]);
  const out = await model({ input_ids: ids([1, 2, 3]), attention_mask: ids([1, 1, 1]), token_type_ids: ids([0, 0, 0]) });
  return Array.from(out.last_hidden_state.data);
};
window.ready = true;
</script>"""

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

def main():
    # The third-party speech engine files are not committed; they are downloaded and checksum-verified on demand.
    subprocess.run(["bash", str(FETCH)], check=True, cwd=ROOT)
    app_js = (ROOT / "app.js").read_text()
    assert re.search(r"wasmPaths\s*=\s*absoluteUrl\(SPEECH_ENGINE\.bundledRuntime\)", app_js) and "bundledRuntimeAvailable" in app_js, "app.js must point the library at the bundled WASM runtime"
    socketserver.TCPServer.allow_reuse_address = True
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    external = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(service_workers="block")
        def block(route):
            external.append(route.request.url); route.abort()
        context.route(lambda url: not url.startswith(base), block)
        context.route(base + "/__offline_test__.html", lambda route: route.fulfill(body=PAGE, content_type="text/html"))
        model_bytes = base64.b64decode(MODEL_B64.read_text())
        context.route(base + "/tests/fixtures/offline/models/tiny/onnx/model.onnx", lambda route: route.fulfill(body=model_bytes, content_type="application/octet-stream"))
        page = context.new_page()
        page.goto(base + "/__offline_test__.html")
        page.wait_for_function("window.ready === true")
        values = page.evaluate("window.run()")
        browser.close()
    server.shutdown()
    assert values == [2, 3, 4], values
    assert not external, f"the speech engine tried to use the internet: {external}"
    print("PASS: bundled speech engine runs a real ONNX inference with all external network blocked", json.dumps(values))

if __name__ == "__main__":
    main()

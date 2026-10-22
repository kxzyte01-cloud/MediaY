from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright
import json

ROOT = Path(__file__).resolve().parent
handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT))
server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
Thread(target=server.serve_forever, daemon=True).start()
base_url = f"http://127.0.0.1:{server.server_port}"

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page()
        page.set_default_timeout(240_000)
        page.on("pageerror", lambda error: print("PAGE ERROR:", error))
        page.goto(base_url + "/ffmpeg-worker-smoke.html", wait_until="domcontentloaded")
        page.wait_for_function("window.testResult !== undefined", timeout=240_000)
        result = page.evaluate("window.testResult")
        print(json.dumps(result))
        browser.close()
        if not result.get("ok"):
            raise SystemExit("FFmpeg worker integration test failed: " + str(result.get("error")))
finally:
    server.shutdown()
    server.server_close()

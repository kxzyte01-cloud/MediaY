ProjectMedia Y — mobile editor repair package

This patch is based on the source files read from https://github.com/kxzyte01-cloud/MediaY and the project files supplied in the conversation.

REPLACEMENT FILES
- index.html
- app.js
- style.css
- setup.js
- setup.css
- sw.js

WHAT THIS PATCH FIXES / ADDS
1. Home dashboard is shown on every app launch, after the saved editor state finishes restoring.
2. A Home button stays in the editor toolbar so the dashboard is reachable while editing.
3. Fixes the opposite empty-state visibility condition in updateChrome(). When a video, overlay, or audio track exists, the “What are you making?” panel no longer reappears over the editor/preview.
4. Enables pointer/touch interaction on Fabric's overlay canvas and recalculates canvas offset after responsive layout changes.
5. Adds a local project library: save named projects, continue the recent project, open other saved projects, and delete saved project records. Starting a new project first preserves the existing edit instead of silently replacing it.
6. Makes home-screen loading wait for IndexedDB project restoration, preventing the dashboard from racing startup.
7. Keeps transition duration changes in one undo step after the slider is released.
8. Updates the service worker cache version and makes its shell caching tolerant of optional/missing routes so a single missing file does not prevent installation.

INSTALL
1. Download and extract this ZIP.
2. In the root of the GitHub repository, replace the six files listed above.
3. Commit the changes and wait for your host / GitHub Pages deployment to finish.
4. On the phone, reload the website. If it still serves the old app, clear the site's stored cache/service worker or open it in a private tab to verify the new version.
5. Test: open Home, create a project, add a video, add an overlay, move/resize it, save the project, go Home, create another project, and reopen the saved project. Also test template save/use and export with a short video.

TESTING
- JavaScript syntax checks passed for app.js, setup.js, and sw.js.
- Automated Chromium smoke test passed for: home on startup, new-project setup, entering editor, returning Home, empty-state stays hidden when an overlay exists, named project save, and preservation of a previous project when starting another.
- The smoke test uses stubs for browser libraries and does not validate real media decoding, Fabric touch behavior on a physical Android device, FFmpeg export, or native APK packaging.

IMPORTANT
- This is a web-source patch, not a rebuilt APK. If your Android app embeds the web project, rebuild/repackage the APK after the source is deployed.
- Projects and media are stored locally in the browser's IndexedDB. They are not synced to GitHub or another device. Deleting browser storage can remove local projects/media.
- The GitHub integration allowed reading the repository files, but GitHub rejected write/branch operations with HTTP 403. Therefore this ZIP is prepared for upload; the repository itself has NOT been changed by this assistant.

ProjectMedia Y — mobile editor patch

Included replacement files:
- index.html   Adds an adjustable transition duration control to the Transition sheet.
- app.js       Fixes template edge cases and supports adjustable transition duration during export.
- style.css    Existing editor styling from the supplied project.
- setup.js     Adds a mobile-first Home screen with Continue Editing, New Project, My Templates, and Export Last Project.
- setup.css    Home screen, setup flow, overlay touch handling, and transition styling.
- sw.js        Bumps the service-worker cache and precaches the setup files. The precache list only uses files supplied in this patch.

How to use
1. Download and extract the ZIP.
2. In your GitHub repository root, replace the six files above with the files from this ZIP.
3. Commit and push the changes, then wait for GitHub Pages/your host to deploy.
4. On the phone, fully reload the site. If it still shows the old UI, clear the site's cached data/service worker or open it once in a private tab to test.
5. Test: Home > New project > Start editing > Media; add a video, tap Overlay to add a picture/video, select the overlay and drag/resize it in the preview; open Templates to save and reuse a template; select the second main clip > Transition to choose an effect and duration; export.

Important limitations
- This is a source-code patch, not a rebuilt APK. If you install a native APK, rebuild/repackage it from the updated web source.
- The supplied app currently stores one active project as “current”; the Home screen resumes that last project. It does not yet provide a multi-project library/history.
- Transition effects and their chosen duration are rendered during export; this source does not implement real-time transition preview playback in the editor.
- Export uses FFmpeg.wasm and may be slow or memory-limited on phones, especially at 2K/4K.

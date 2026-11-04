# MediaY Security Baseline

Last reviewed: 2026-11-05

## Architecture and scope
MediaY is a browser-first, local-first editor. Project media is stored in browser IndexedDB and the Android package uses Capacitor. The repository currently has no application backend, user accounts, database service, Stripe integration, admin API, or server-side webhook endpoint.

The reel's Supabase RLS, IDOR, admin-route, Stripe webhook, and account-signup examples are therefore not current MediaY attack surfaces. Do not add pretend RLS policies or fake webhook verification to this client-only application. If a backend, accounts, cloud sync, payments, or AI proxy is introduced, those controls become mandatory release gates.

## Current security rules
1. No frontend secrets. Anything in HTML, JavaScript, WASM, an APK, source maps, or browser storage is inspectable. Never put provider API keys, service-role credentials, signing keys, or private tokens in the client.
2. Keep local media local by default. Do not upload source media, project files, captions, or diagnostics without a clear design, user consent, and privacy disclosure.
3. Treat imported files as untrusted. Validate media metadata and file sizes; do not build shell commands from filenames or user-controlled strings; keep FFmpeg arguments structured; clean temporary virtual filesystem files on success and failure.
4. Avoid unsafe DOM sinks. Do not pass untrusted media metadata, captions, filenames, or model output to innerHTML. Prefer textContent, DOM construction, and allowlisted markup.
5. Keep dependencies controlled. Pin dependency versions. Prefer local runtime assets for offline-critical paths. CDN scripts are executable third-party code and must be reviewed; do not silently add remote scripts or fonts.
6. Keep service-worker caching scoped to known application assets. Bump the cache key when shipped assets change; never cache secrets or user media in the application shell.
7. Request only Android permissions required for the selected action. Do not log media contents, credentials, or private file URIs.
8. Keep keystores and passwords in protected GitHub Actions secrets. Never commit signing material or private credentials. Disable public source maps unless there is a deliberate policy.
9. Treat AI model output and prompt content as untrusted data. Do not give a client-side model privileged shell, repository, payment, or account-management tools. Enforce spend limits on any future server-side AI proxy.

## Backend-only controls — required if that architecture is added
- Enable RLS on every user-data table; policies must be ownership-scoped and default-deny.
- Enforce object ownership on every server-side read/write; test with two distinct users.
- Check admin roles on the server using trusted claims or a protected role table, never client-editable profile metadata.
- Verify payment webhooks with official signature verification, event IDs, and replay/idempotency controls.
- Rate-limit signup, login, password reset, and billable AI endpoints; add abuse controls and per-account spend limits.
- Apply HSTS, nosniff, frame restrictions, and a CSP at the actual hosting/server layer. A static HTML meta tag is not a substitute for response headers.

## Pre-release checks
- Review tracked files for .env, private keys, tokens, and accidental credentials.
- Scan built web bundles and APK contents for secrets; all client-bundled values are public.
- Run dependency vulnerability checks against actual lockfiles and vendored dependencies.
- Test import, export, caption, cancellation, offline, and project restore paths with malformed and unusually large media.
- Re-check hosting headers and service-worker cache behavior on the deployed origin.
- If backend features are introduced, add two-user authorization, webhook-signature, rate-limit, and backup-restore tests before enabling signups.
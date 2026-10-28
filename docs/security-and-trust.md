# Authentication, network traffic, and trust

This document describes the published source, not a third-party security audit. Open source makes inspection possible; it does not automatically make a program or a downloaded binary safe.

## Authentication and local data

- Sign-in and additional verification take place in the official Kindle page in a dedicated Chromium profile. KindleToZip does not provide its own account system or sign-in server.
- The source does not intentionally read password fields, export Amazon cookies with Playwright's cookie APIs, save `storageState`, or upload authentication data to an application-operated service. The reader adapter inspects selected visible reader elements and captures displayed pixels. Playwright controls the browser; it must not be described as technically incapable of accessing page data.
- Login state is saved **by default** in the dedicated browser profile. The browser can write cookies, tokens, cache, and browsing history. Disabling retention creates a separate temporary profile; normal shutdown removes that temporary profile. Crashes can leave files behind.
- Profiles are separate from the normal browser. Portable builds use `data/` beside the executable; development uses `artifacts/mvp-data/`. Captured pages, titles, manifests, previews, and archives are sensitive local information.
- Previews are held in application memory. Review and capture data may be written to the selected local job directory. Do not capture a login page, and verify the preview before approving it.

Implementation: [reader](../app/reader.mjs), [application](../app/application.mjs), [session preference](../app/session-preference.mjs), and [Rust store](../poc/controller/src/store.rs).

## Network destinations

| Activity | Destination / behavior |
| --- | --- |
| Local control window and API | `http://127.0.0.1:<ephemeral-port>`. The API checks its startup token and origin/host. The control browser is restricted to its own loopback origin. |
| Open Kindle | Entry point `https://read.amazon.co.jp/`. The official page and its authentication, content, and CDN dependencies make normal browser requests. |
| Browser behavior | The real reader is not restricted to an app-maintained domain allowlist, and service workers are allowed. Navigation, upstream content, Chromium background services, and upstream telemetry can introduce other requests. This is not a guarantee that every browser request stays on an Amazon hostname. |
| App analytics, crash uploads, update checks | No application-operated telemetry, crash-report upload, or automatic update-check endpoint is implemented in this source. |
| Support / donation pages | No automatic access and no active in-app support link. Future links must open only after an explicit user action. |
| npm setup | `registry.npmjs.org`, with package URLs and integrity values in `package-lock.json`. |
| Rust setup | `win.rustup.rs`, `static.rust-lang.org`, and the crates.io index/download infrastructure used by Cargo. |
| Browser setup | Playwright's configured browser download mirrors, including Microsoft's Playwright distribution/CDN infrastructure. Hosts can change with the pinned Playwright package or redirects. |
| Git clone, Actions, releases, verification | GitHub and its artifact/download/attestation infrastructure. This is separate from normal capture, not an app update service. |

Setup scripts and the browser can follow redirects; this table is a functional disclosure, not a complete packet-capture audit or firewall policy. Offline capture still depends on what the official reader has made available. The application cannot promise that the official service does not observe reader activity.

Implementation: [server](../app/server.mjs), [control window](../app/control-window.mjs), [reader network policy](../app/reader.mjs), [browser installer](../scripts/install-browser.mjs), and [Rust installer](../scripts/install-rust.ps1).

## Limits and reporting

- The local token and Windows ACLs are not protection against malware, an administrator, or another process running as the same Windows user.
- A modified source tree, compromised dependency, or unrelated executable can behave differently. Verify release provenance, review the exact source revision, and keep Windows and browser security protections enabled.
- There is no claim of independent penetration testing, complete dependency audit, secure SSD erasure, or protection from all network leakage.
- Do not attach login profiles, cookies, credentials, real book pages, browser traces, or unredacted logs to public issues. Use GitHub's private vulnerability reporting if it is available on the repository; otherwise report only non-sensitive symptoms and request a private contact channel before sharing details.

## Support policy

The tool is free, with no additional KindleToZip account, usage quota, watermark, or paid DLC. The official Kindle service can still require an Amazon account or payment for its own content.

Financial support is optional and must never unlock capture features or be required for export. On 2026-10-28 the author's GitHub account did not have an active Sponsors listing. No payment account or sponsorship has been created by this repository setup. Once the author enables it, use the same `zufall-upon` Sponsors destination across projects and add an unobtrusive, user-clicked link after export. Until then, no inactive payment URL is presented as working.

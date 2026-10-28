[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# KindleToZip

Capture the Kindle web reader on Windows, review your PNG screenshots, and save them as an ordered ZIP or CBZ.

**Free & open source · Windows x64 · No KindleToZip account · No paid DLC**

> **Experimental: source available, no public Portable executable yet.**
> Known test failures remain. This is not a verified, ready-to-use release.

**[Get started from source](docs/getting-started.md)** · [Check release availability](https://github.com/zufall-upon/KindleToZip/releases)

## Three stages, from reader to archive

**Open → Capture → Review & save**

1. **Open.** Sign in on the official Kindle page in the dedicated browser, open a book, and select its reader tab.
2. **Capture.** Select the reading area and check its preview. Approve it, then start capture in a separate action.
3. **Review & save.** Stop, inspect the saved images, adjust their order or crop, and export ZIP / CBZ.

These are **three stages, not three clicks**. Follow the app's next-action guidance and its three main controls: **Confirm / Next**, **Cancel / Back**, and **Finish / Start over**.

## App preview

![KindleToZip's Japanese control window, with language selection, reader-tab selection, and three main controls](docs/images/kindletozip-workflow.png)

*Actual app screenshot supplied by the author, cropped to the control window. Japanese UI is shown before sign-in has been verified; no book content is displayed. [Open full-size image](docs/images/kindletozip-workflow.png).*

## What you can do

The following features are implemented in the source, but remain subject to the known issues below.

- **Dedicated browser:** display the Kindle web reader separately from your usual browser profile.
- **Area selection & preview:** choose the displayed reading area and verify it before capture.
- **Page capture:** explicitly start page turning and save displayed pages as PNG screenshots.
- **Spread splitting & order:** optionally split left/right pages, choose reading direction, and reorder captured images.
- **Image review:** include or exclude images without deleting originals, and apply non-destructive crops.
- **ZIP / CBZ export:** save the included PNGs in the chosen order, without overwriting existing output files.
- **Review after stopping:** inspect and export already committed images without capturing them again.
- **Three UI languages:** Japanese, English, and Simplified Chinese, selected in the app's language menu.

## Getting started

**There is currently no public Windows Portable download.** To try this experimental version, use the [source setup guide](docs/getting-started.md). It requires **Windows x64, Git, Node.js 22 or later, and PowerShell 7**; the guide installs the isolated Rust toolchain and dedicated browser.

After setup, run `npm start` from the project folder. The local control window guides you through opening the dedicated reader, previewing, capturing, and saving. For a check without a real book, use the self-authored sample described in the guide.

If you want an installer-free app without a development setup, check [Releases](https://github.com/zufall-upon/KindleToZip/releases) later. The portable build scripts exist, but that does **not** mean a tested public executable is available.

### FAQ

**Is KindleToZip free? Do I need another account?**

Yes, it is free and open source. No KindleToZip account or paid feature unlock is required. The official Kindle service still requires your Amazon account and any applicable content purchase or subscription.

**Where can I download the Windows portable EXE?**

No public executable is available yet. Use the source guide now, or wait for a published release.

**Does it remove DRM or work with the Windows Kindle desktop app?**

No. It captures displayed content in the Kindle web reader. It does not decrypt ebook files, bypass DRM or capture restrictions, or operate the desktop app.

**Will it capture an entire book in the correct order automatically?**

That is not guaranteed. Check the captured range, page order, spread splits, and stopping point yourself. A valid ZIP does not prove the whole book was captured.

**Can I change the app language?**

Yes. Use the language menu to select Japanese, English, or Simplified Chinese. Language support is implemented; the validation report still includes a failed language-flow test.

## Safety & privacy

- **Sign in only on the official page.** The app has no independent login server and does not intentionally read password fields or upload Amazon cookies to an app-operated service.
- **Login state is saved by default.** Disable sign-in retention to use a separate temporary profile. Temporary data is removed on normal shutdown; crashes can leave files behind.
- **Keep local data private.** Development uses `artifacts/mvp-data/`; portable builds use `runtime/`, `data/`, and `temp/` beside the EXE. These can hold cookies, history, book information, and captured pages. Do not share them or attach them to issues.
- **Network access is still required.** The official reader, authentication services, browser, and initial setup make network requests. The app has no application telemetry, automatic update checks, or automatic support-page access; this does not mean Chromium or the official site makes no other requests.

See [authentication, network destinations, and trust boundaries](docs/security-and-trust.md). Open source enables inspection; it is **not a security guarantee**. Local tokens and Windows permissions do not protect against malware, administrators, or other processes running as the same Windows user.

## Limitations & responsible use

- **Known failures:** the initial published source's `npm test` run reported **125 passed / 12 failed** in about **576 seconds**, including parent/subtest failures. Rust, IPC/local-store, and deployment checks passed separately. This documentation update does not fix or waive those failures. See the [validation report](docs/validation.md).
- **Compatibility is not guaranteed:** clean Windows PCs, every Kindle layout, complete-book capture, ZIP64, and every CBZ viewer are not verified. The current entry point targets the Japanese Kindle web reader. Other regions are unverified; the Windows Kindle desktop app is unsupported.
- **Image limits:** standard or 2× rendering is available, with a safety limit of **16 megapixels / 32 MiB per PNG**. Higher density cannot restore detail absent from the displayed source. Review spread splits yourself; they are not semantic page recognition.
- **No DRM bypass does not establish legal permission.** Amazon's conditions exclude robot-like data gathering tools from the granted permission. Automated capture and distribution of this tool can still raise contractual and copyright issues. Use only content you are authorized to capture; GPLv3 does not grant rights to books or permission to redistribute captured pages.

KindleToZip is **unofficial and independent**, not affiliated with, endorsed by, or sponsored by Amazon. Amazon and Kindle are trademarks of Amazon.com, Inc. or its affiliates. No clearance from Amazon or a legal professional is claimed. Read the [legal questions and review limits](docs/legal-notes-ja.md) (Japanese) before use.

## Support development

KindleToZip is free and open source. If it saves you time, consider supporting its development through **[zufall-upon on GitHub Sponsors](https://github.com/sponsors/zufall-upon)**.

Support is **entirely optional**. Basic features have no usage fees, paid quotas, watermarks, or paid DLC. The Sponsors page may redirect to the author's profile while the listing is pending or unavailable; accepting financial support has **not** been confirmed. Feedback and bug reports are also welcome.

## License & developer documentation

Copyright (C) 2026 **[zufall-upon](https://github.com/zufall-upon)**. Licensed under **GNU GPL v3.0 only** (`GPL-3.0-only`); see [LICENSE](LICENSE). The software is provided without warranty. Third-party dependencies retain their own licenses.

- [Documentation index](docs/README.md) — source guides and document languages
- [Development, tests, and portable builds](docs/development.md)
- [Validation results and known failures](docs/validation.md)
- [Releases, SHA-256, and build provenance](docs/releasing.md)
- [Security and network details](docs/security-and-trust.md)
- [Legal notes](docs/legal-notes-ja.md) (Japanese)
- [Rust JSONL IPC contract](docs/09-mvp-ipc-ja.md) (Japanese)

[GitHub Actions](https://github.com/zufall-upon/KindleToZip/actions) provides source checks and a separate manual **draft-release** workflow. Its presence is not proof of a passing release, independent audit, legal clearance, or bit-for-bit reproducibility.

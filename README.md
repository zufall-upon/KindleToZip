[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# KindleToZip

[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-2563eb?style=flat-square)](LICENSE) [![Platform: Windows x64](https://img.shields.io/badge/Windows-x64-0078d4?style=flat-square)](docs/getting-started.md) [![UI: English, Japanese, Simplified Chinese](https://img.shields.io/badge/UI-EN%20%7C%20JA%20%7C%20ZH--CN-8b5cf6?style=flat-square)](docs/screenshots.md)

**Capture. Review. Archive.**

Capture displayed pages in the Kindle web reader on Windows, review and split your PNG or JPEG screenshots, then save them as an ordered **ZIP or CBZ**.

**Capture screenshots in the background. Keep working while you wait.**

**Free & open source · Windows x64 · No KindleToZip account · No paid DLC**

> **Windows x64 Portable v0.1.6 is available.**
> Mandatory source and packaged-fixture checks passed. The user confirmed the local crop/region candidate without specifying the scope; the earlier clean-Windows/whole-book report concerns v0.1.2, not this hosted EXE.

**[Download Portable ZIP](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.6/KindleToZip-Portable-v0.1.6-win-x64.zip)** · [Portable quick start](docs/portable.md) · [Run from source](docs/getting-started.md)

<a href="docs/screenshots.md#animation"><img src="docs/images/kindletozip-demo.gif" alt="Author-recorded sample: image review and ZIP saving in the Japanese UI" width="340"></a>

*8-second sample demo · Japanese UI · Edited, with local paths masked. [Recording notes & still images](docs/screenshots.md#animation).*

[![Status: released](https://img.shields.io/badge/status-released-16a34a?style=flat-square)](docs/validation.md) [![Latest main-branch source checks](https://img.shields.io/github/actions/workflow/status/zufall-upon/KindleToZip/ci.yml?branch=main&style=flat-square&label=source%20checks)](https://github.com/zufall-upon/KindleToZip/actions/workflows/ci.yml) [![GitHub stars](https://img.shields.io/github/stars/zufall-upon/KindleToZip?style=flat-square&label=stars)](https://github.com/zufall-upon/KindleToZip/stargazers) [![Last repository commit](https://img.shields.io/github/last-commit/zufall-upon/KindleToZip?style=flat-square)](https://github.com/zufall-upon/KindleToZip/commits/main/)

## Why I built it

My previous way of turning Kindle books into ZIP archives stopped working at some point, so I built KindleToZip. It captures the pages displayed in the Kindle web reader rather than decrypting ebook files.

The aim is to make the waiting time useful: the dedicated reader window does not need to stay in the foreground during capture, so you can work in another app, then review and organize the images before saving an archive.

## From reader to archive

1. **Open.** Sign in on the official Kindle page in the dedicated browser, open a book, and select its reader tab.
2. **Capture.** Select the reading area and check the preview. Approve it, then start capture in a separate action.
3. **Review & save.** Stop, inspect the images, adjust splits, order or crop, and export ZIP / CBZ.

**Background capture:** keep the dedicated reader window open and not minimized, and the PC awake and unlocked. Background capture does not promise operation while minimized, locked, or asleep. Preview and approval before capture, and checking the captured range and page order afterward, are still required.

[![Actual KindleToZip UI: preview split pages, review three reordered captures, and a verified six-image ZIP export](docs/images/kindletozip-overview.png)](docs/screenshots.md)

*Real English UI with self-authored sample content; cropped views, not a mockup. Local export paths are masked. This sample success does not verify real-book capture or a packaged release.*

**Full-size:** [Preview](docs/screenshots.md#preview) · [Review & split](docs/screenshots.md#review) · [ZIP saved](docs/screenshots.md#export) · [Japanese UI](docs/screenshots.md#japanese-ui)

## Review and organize your captures

Included in the Portable build and source, with the limits below:

- **Check before capturing.** Dedicated browser profile, reading-area selection, preview, and explicit approval before a separate start action.
- **Split and organize.** Optional left/right spread splitting, reading direction, and image reordering.
- **Keep the originals.** Include or exclude images and apply non-destructive crops; review committed images after stopping without recapturing them.
- **Save an ordered archive.** Export included PNG/JPEG images to ZIP / CBZ without overwriting an existing file.
- **Choose your language.** Japanese, English, and Simplified Chinese UI.

**Added in v0.1.4:** choose PNG or JPEG capture and JPEG quality from 1–100. JPEG is lossy at capture and is recompressed when cropped or split. In review, correct each image to one or two pages and choose their order. Crop margins manually and restore the original. Layout detection can be wrong, so check it visually. A small selected next button overlapping the capture area is hidden only during capture when safe; not all overlays can be removed.

**Added in v0.1.6:** in review, select an image and choose “Detect margins on selected image” to compare a candidate for continuous white or black edge margins with the original. Previewing or cancelling does not change saved data. Check text, frames and page numbers before explicitly applying; manual crop and restoring full size remain available. This is not content recognition, and a safe candidate may not be found. Applying a JPEG crop recompresses at its capture quality; the original is retained.

v0.1.6 also adds a **Kindle region** selector for **Japan, United States and United Kingdom**, independent of UI language (initially Japan on each app run). Select before opening the dedicated browser; close it before changing regions, then reselect the target tab, preview and approve again. Real accounts/books in each region remain unverified. The [adapter foundation and future plan](docs/store-adapters.md) separate store-specific behavior from shared image handling. BOOK☆WALKER, ebookjapan and コミックシーモア are **not supported**; terms, copying conditions and authorized-sample checks are separate work for each future integration. These features are included in the v0.1.6 Portable ZIP linked below.

## Get started

**Portable:** download the [v0.1.6 release ZIP](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.1.6), verify `SHA256SUMS.txt`, extract the entire ZIP into a writable folder, and run `KindleToZip-Portable.exe`. Node.js and the dedicated browser are bundled; no development setup is needed. See the [trilingual Portable guide](docs/portable.md).

**From source:** you need **Windows x64, Git, Node.js 22+, and PowerShell 7**. The [setup guide](docs/getting-started.md) installs an isolated Rust toolchain and browser, then launches the app with `npm start`. Start with the self-authored sample, without an Amazon login or a real book.

**Ubuntu experimental source:** the `linux-port` work supports **self-authored fixtures only**, not real Kindle, normal Wayland reading, or a Linux download. With the existing isolated prerequisites, see [Ubuntu source instructions](docs/getting-started.md#ubuntu-source). The control window is headed and the fixture reader is headless by default. An explicit `npm start -- --sample-headed` enables only the app-created standard fixture in a dedicated Wayland window; it does not authorize other sites or profiles. Target-local checks do not guarantee OS-wide visibility or non-interference with other apps or physical input. An installed `/usr/bin/zenity` is an optional destination picker; manual entry remains available, and choosing a path never starts saving or capture. Desktop/portal behavior still requires environment-specific validation; this is not a Linux release.

On Ubuntu 26.04, anonymous ZIP/CBZ destination selection and cancellation were manually exercised with the installed Zenity; the user reported normal display. No native-dialog image was provided or independently inspected. These checks confirmed that selection alone creates no archive; ZIP/CBZ output/content checks are separate integration evidence, not native-picker export or real-Kindle acceptance.

## Before you use it

- **Quality:** v0.1.6 passed every mandatory exact-source CI and tagged-release gate, including public source UI, deployment and packaged public selection/export regressions. Earlier failed runs remain historical. The user's local-improvement confirmation and earlier v0.1.2 clean-Windows/whole-book report are separate from this hosted EXE's fixture checks; see [validation history and release evidence](docs/validation.md).
- **Login & local data:** sign in only on the official page. **Login state is saved by default.** Turn retention off for a separate temporary profile; normal shutdown removes temporary data, but crashes may leave files. Never share profiles, cookies, book data, or captured pages. See [privacy and storage details](docs/security-and-trust.md).
- **Network & trust:** no app-operated login server, application telemetry, or automatic update checks. Reader, authentication, browser, and setup traffic still occurs. Open source is **not a security guarantee**; see [network destinations and trust boundaries](docs/security-and-trust.md).
- **Compatibility:** v0.1.6 offers Japan, US and UK Kindle entry points independently of UI language; actual regional books, every layout, ZIP64, and every CBZ viewer are unverified. User-confirmed clean-Windows and real-book operation does not guarantee all environments or books. Standard / 2× rendering has a **16-megapixel / 32 MiB limit per image**; it cannot restore missing source detail.
- **Terms & rights:** no DRM bypass does **not** establish legal permission. Amazon's conditions exclude robot-like data gathering tools from the granted permission; automated capture and tool distribution still raise unresolved contractual and copyright questions. Use only content you are authorized to capture, and do not redistribute pages without permission. Read the [legal notes](docs/legal-notes-ja.md) (Japanese).

KindleToZip is **unofficial and independent**, not affiliated with, endorsed by, or sponsored by Amazon. Amazon and Kindle are trademarks of Amazon.com, Inc. or its affiliates. No Amazon approval or professional legal clearance is claimed.

## FAQ

**Is it free? Do I need another account?**

KindleToZip is free and open source, with no separate account, paid quotas, watermarks, or paid feature unlocks. Amazon's account requirements and any content purchase or subscription still apply.

**Does it remove DRM or work with the Windows Kindle desktop app?**

No. It screenshots displayed web-reader content; it does not decrypt ebook files, bypass DRM or capture restrictions, or operate the desktop app.

**Will it save a whole book in the correct order?**

That is not guaranteed. Check the range, page order, spread splits, and stopping point yourself. A verified ZIP does not prove complete-book capture; splits are not semantic page recognition.

**Can I change the app language?**

Yes, in the language menu: Japanese, English, or Simplified Chinese. The public language-flow regression passed in current source CI; [validation history](docs/validation.md) keeps the earlier failure and distinguishes source checks from packaged acceptance.

## Support development

If you find this project useful, you can [buy me a coffee on Ko-fi](https://ko-fi.com/zufallupon). **Support is entirely optional** and unlocks no features.

[![Support development on Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/zufallupon)

Feedback and [bug reports](https://github.com/zufall-upon/KindleToZip/issues) are also welcome. [GitHub Sponsors](https://github.com/sponsors/zufall-upon) remains another option, but its listing may redirect to the author's profile; accepting contributions **through GitHub Sponsors** has not been confirmed.

## Documentation & license

[Documentation index](docs/README.md) · [Development & builds](docs/development.md) · [Release verification](docs/releasing.md) · [Screenshot review](docs/readme-review.md)

[GitHub Actions](https://github.com/zufall-upon/KindleToZip/actions) includes source checks and a separate manual draft-release workflow, not proof of release readiness, an independent audit, or bit-for-bit reproducibility.

Copyright (C) 2026 **[zufall-upon](https://github.com/zufall-upon)**. **GNU GPL v3.0 only** (`GPL-3.0-only`); see [LICENSE](LICENSE). Provided without warranty. Dependencies retain their own licenses; GPLv3 grants no rights to books or captured pages.

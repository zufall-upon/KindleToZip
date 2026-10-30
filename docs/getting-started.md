[English](getting-started.md) | [日本語](getting-started.ja.md) | [简体中文](getting-started.zh-CN.md)

# Get started from source

[Back to KindleToZip](../README.md)

## What is available now?

[Windows x64 Portable v0.1.6](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.1.6) is publicly available as a normal Release + Latest from **2026-10-29**. Mandatory source and packaged-fixture checks passed. The user confirmed the local image improvements; their earlier clean-Windows/whole-book report concerns v0.1.2, not this hosted EXE. [Validation history](validation.md) distinguishes these reports from automated checks and retains earlier failures.

For use without a development setup, follow the [Portable guide](portable.md): download the release ZIP, verify its checksum, extract it completely, and run `KindleToZip-Portable.exe`. The instructions below are for **source execution only**. No Amazon credentials are needed to install the source or use the self-authored sample.

## Requirements

<a id="ubuntu-source"></a>
### Ubuntu experimental source (existing environment)

On `linux-port`, only self-authored fixtures are in scope. Real Kindle, normal Wayland reading and Linux distribution are unavailable/unverified. Reuse the existing Node 22, Rust 1.99.1 controller and pinned Playwright/Chromium environment after checking space and mounts; do not run the Windows installer below on Ubuntu. See [the Ubuntu development path](development.md#experimental-ubuntu-source-development) for the existing-environment commands and limits.

The control window is headed and the fixture reader is headless. Linux optionally uses an executable `/usr/bin/zenity` to select a ZIP/CBZ destination. Selection/cancellation alone never saves or captures; export is a separate explicit action and never overwrites. If the picker is missing or fails, type the path manually. Nothing is installed automatically; desktop/portal behavior requires environment-specific validation.

On Ubuntu 26.04, anonymous ZIP/CBZ destination selection and cancellation were manually exercised with the installed Zenity; the user reported normal display. No native-dialog image was provided or independently inspected. These checks confirmed that selection alone creates no archive; ZIP/CBZ output/content checks are separate integration evidence, not native-picker export or real-Kindle acceptance.

Startup distinguishes known controller, private-storage, lock and control-window failures without repairing permissions or fetching dependencies. For a suspected long `TMPDIR`, explicitly select a short private directory with `KTZ_TEMP_DIR`; there is no automatic relocation or guessed path-length cutoff.

### Windows x64

- Windows x64, with a writable local project folder.
- Git, Node.js **22 or later**, and PowerShell **7** (`pwsh`). Run the commands below in PowerShell 7, not Windows PowerShell 5.1.
- Internet access for initial tool and dependency downloads.
- The scripts install isolated **Rust 1.99.1** and use **Playwright 1.64.1 / Chromium revision 1248**, without replacing your normal browser profile or changing the global Rust PATH.

Portable packaging, unlike source execution, requires **Node.js 22.14.0** exactly. See [developer build instructions](development.md).

## Install and launch

Run each command in order and stop if it fails. Do not continue past a failed checksum, failed build, or test failure. The launcher dependencies are fetched explicitly because the installer fetches the controller's dependencies; this is documentation of the existing scripts, not a change to them.

```powershell
git clone https://github.com/zufall-upon/KindleToZip.git
cd KindleToZip
npm ci --ignore-scripts --no-fund --no-audit
./scripts/install-rust.ps1 -FetchDependencies
& ./artifacts/toolchains/cargo/bin/cargo.exe fetch --manifest-path poc/launcher/Cargo.toml --locked
node scripts/install-browser.mjs
node scripts/install-browser.mjs --headed
pwsh -NoProfile -File scripts/test-rust.ps1
npm start
```

The Rust installer and the immediately following `cargo fetch` run in the same PowerShell session so the isolated toolchain environment is preserved. If script execution is blocked by your Windows policy, review the scripts and your organization's policy; do not disable security controls globally.

The local control window opens in a dedicated browser window. Close it, or press Ctrl+C in its launch terminal, to stop the app normally. If the controller EXE is in use, do not rebuild over it or terminate unrelated processes; close your own app normally before rebuilding, or use a separate source checkout.

## Try without a real book

1. Choose **Confirm / Next** to prepare a new job.
2. Expand the auxiliary dedicated-session/sample controls and choose the **self-authored sample**.
3. Select its reader tab, preview it, check the confirmation box, and approve. **Approval alone does not start capture.**
4. Explicitly start in a separate action, stop, and inspect the saved images before exporting.

The sample uses self-authored shapes and text. Its success does not prove that the current Kindle reader, every layout, or an entire book will work. Never use a login page as the capture target.

## Use the Kindle web reader

1. Open the dedicated Kindle browser from the app. Sign in and complete any additional verification **on the official page**, then open one book and choose its starting position yourself.
2. Return to the app and select the actual reader tab, not the library. v0.1.6 opens the Kindle web reader for the selected Japan, US or UK region. Try the matching Kindle preset; use manual area/identity/position/next-button selection if necessary.
3. Check the preview's book, area, direction, and position. Approve, then explicitly start in a separate action. Unclear targets, authentication changes, or uncertain page turns may stop capture.
4. After stopping, inspect included/excluded images, order, crops, and optional spread splits. Committed images can be exported even after capture or preview stops. Exporting a valid archive does not establish whole-book completeness.

The three main controls are **Confirm / Next**, **Cancel / Back**, and **Finish / Start over**. Follow the displayed next action; the three stages are not a promise of only three clicks. Japanese, English, and Simplified Chinese are selectable in the language menu. Current source CI passes the public language-flow regression; historical failures and packaged-test limits remain in [validation](validation.md).

### v0.1.6 region selection and margin comparison

Before opening the dedicated browser, choose Japan, United States or United Kingdom in **Kindle region**. This is independent of display language and initially Japan on each app run. To change regions, stop capture and close that browser, then choose the region, reselect the tab, preview, approve and start separately. Official entrypoint identification and anonymous boundary tests do not establish actual regional book compatibility.

In image review, select an image and use **Detect margins on selected image** to compare white/black edge candidates with the original. Check text, frames and page numbers before applying. Cancellation does not change saved data; manual crop and full-size restoration remain available. A candidate may not be found. JPEG application recompresses at capture quality. These additions are included in the v0.1.6 Portable release. The three services in the [adapter plan](store-adapters.md) remain unsupported.

## Images, saved data, and privacy

In v0.1.6, select the capture image format and JPEG quality (1–100) before previewing. JPEG is compressed at capture and recompressed on crop or split; inspect the quality and size. The captured original bytes are retained. In review, correct each image to one or two pages and choose their order, crop margins manually, or restore the original with Restore original size. Margin candidates require explicit comparison and application; they are not silently applied. Check layout and overlays yourself; detection and suppression are not complete.

- Standard or 2× rendering density changes how the page is rendered, not the amount of detail available from the source. Each image is limited to **16 megapixels / 32 MiB** for safety, not as a paid quota.
- Spread splitting is optional. Choose right-to-left or left-to-right reading order and check the result yourself; it is not semantic page recognition. Exclusion and cropping retain originals. Existing output files are not overwritten.
- Development work data and dedicated profiles are under `artifacts/mvp-data/`, unless you explicitly select another local job location. Portable builds create `runtime/`, `data/`, and `temp/` beside the EXE.
- **Login retention is ON by default.** Turning it off creates a separate temporary profile. Normal exit removes that temporary profile; crashes can leave data behind. Saved profiles are intended for the same PC and Windows user, and Amazon can still expire the session or require verification.
- Keep cookies, profiles, book titles, screenshots, and output archives private. Do not attach these folders to public issues. Secure erasure and secrecy from an administrator or the same Windows user are not guaranteed.
- Official reader/authentication traffic and setup downloads require the network. The app has no application-operated telemetry, automatic update check, or automatic support-page access. The official service and Chromium may make additional requests; this is not an offline or network-isolation guarantee.

Read [security and network details](security-and-trust.md), the [validation report](validation.md), and [legal notes](legal-notes-ja.md) (Japanese). No DRM bypass does not establish Amazon terms or copyright compliance. The app is unofficial, and GPLv3 grants no rights to redistribute book content.

## If something fails

Do not repeatedly start capture on an unclear or black preview. Stop, retain existing images, and use the displayed next-action guidance. Check [known validation failures](validation.md) before reporting a problem; documentation does not repair them. Sanitize any report to remove credentials, titles, book pages, and personal paths.

For source tests, portable packaging, and release provenance, continue to [development and testing](development.md) and [release verification](releasing.md). These are developer procedures, not an available public download or proof of a passing release.

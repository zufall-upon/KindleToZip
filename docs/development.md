# Development and testing

Looking for the current way to try the app? The [official Releases page](https://github.com/zufall-upon/KindleToZip/releases) offers the public Portable ZIP. For source execution, use the setup guide: [English](getting-started.md) · [日本語](getting-started.ja.md) · [简体中文](getting-started.zh-CN.md).

## Requirements

- Windows x64 with PowerShell 7 (`pwsh`) and Node.js 22 or later.
- Portable packaging requires Node.js 22.14.0 exactly.
- Rust 1.99.1 is installed locally under `artifacts/toolchains/`; setup does not change the global PATH.
- npm dependencies are pinned in `package-lock.json`; Rust dependencies and checksums are pinned in both `Cargo.lock` files.

Run the setup commands in the [source setup guide](getting-started.md) before testing. Run the Rust installer and the launcher's explicit dependency fetch in the same PowerShell 7 session, as shown there. Initial setup downloads tools and dependencies from their official distribution sites and registries.

## Architecture and implementation limits

The backend controller is Rust; the local web UI and browser adapter use Node.js and Playwright. This is not a Tauri app or a purely Rust-only runtime. Source execution needs the development tools above. The portable build embeds its runtime rather than requiring the end user to install Node.js, Rust, npm, or Chromium separately. The public v0.1.2 build and later local source/candidate have separate validation records.

PNG/JPEG storage, recovery, ordering, non-destructive crops, and archive verification belong to the Rust controller. JPEG capture and cropped/split output are lossy. Standard or 2× browser rendering does not reconstruct absent source detail. The image safety limit is 16 megapixels / 32 MiB per image, not a paid feature limit. Optional spread splitting must be reviewed by the user; it is not semantic page classification. ZIP64 and compatibility with all CBZ viewers remain unverified.

The [initial validation report](validation.md) records 125 passes and 12 failures for `npm test`, including parent/subtest failures. These documentation changes do not fix, waive, or replace those results. Keep real Kindle acceptance, source-fixture tests, packaged-fixture tests, and clean-Windows checks separate.

## Tests

```powershell
# Rust controller, launcher, and Node IPC/local-store regressions
pwsh -NoProfile -File scripts/test-rust.ps1

# Headless browser and public UI regressions using self-authored fixtures
npm test

# Portable metadata selection and deployment protections
npm run test:distribution
```

Browser fixtures contain self-authored shapes and text, not real book content. See [fixture rights](../poc/fixtures/RIGHTS.md). Automated fixture success does not establish real Kindle compatibility or clean-Windows acceptance.

### Experimental Ubuntu source development

This is a source-development path for self-authored fixtures, not a Linux distribution. Linux Kindle launching and capture are explicitly unavailable; normal Wayland reading, real Kindle, Windows GUI and arm64 execution have not been established by Linux fixture tests. The control window is headed; the Linux fixture reader is headless. The save-dialog button is unavailable on Linux: type the destination. Existing files are never overwritten. If a storage synchronization or publication result is uncertain, stop, restart and inspect the indicated destination and data; restarting does not itself prove consistency.

Reuse an already available Node 22, Rust 1.99.1 controller, pinned npm dependencies and Playwright Chromium revision 1248. Check space and mounts first. Do not download or replace an installed but incompatible tool without an explicit choice; provision missing prerequisites separately in an isolated location. With existing local `artifacts/browsers` and `artifacts/rust-target` (which may be previously established symlinks), resume from the project root:

```bash
export PLAYWRIGHT_BROWSERS_PATH="$PWD/artifacts/browsers"
export CARGO_TARGET_DIR="$PWD/artifacts/rust-target"
# If this exact controller is already built, do not rebuild merely to resume.
test -x "$CARGO_TARGET_DIR/debug/ktz-g02-controller"
npm run test:store
# The public-start lifecycle test needs an X display; Xvfb is not Wayland acceptance.
npm test
npm start
```

`KTZ_CONTROLLER_PATH` explicitly selects another controller; there is no PATH search or automatic build. The default is `artifacts/rust-target/debug/ktz-g02-controller` on Linux and the existing `.exe` path on Windows. Node sets a process-only `umask 077`; dedicated directories/files are private and unsafe existing settings/session entries are rejected, not repaired. If an inherited `TMPDIR` is too long for Chromium's Unix socket, select a short, private local temporary location rather than weakening permissions. Application-owned temporary browser data is removed on normal close; no personal browser profile is used.

The Ubuntu CI job installs dependencies on an ephemeral runner, including Rust, npm dependencies, Chromium headless shell and headed Chromium, OS browser libraries and Xvfb. The local retained copies occupy approximately 660 MiB (Rust), 681 MiB (browsers), 20 MiB (npm modules), and 401 MiB (Rust target); runner download and OS package sizes vary and can require several GiB of temporary space. This does not authorize downloads or global system changes on a developer's machine. CI remains unverified until a run actually completes; its virtual display does not prove normal Ubuntu/Wayland or Windows desktop behavior.

The following tests open visible windows. Run them only when you can participate without disrupting other work:

```powershell
npm run test:headed
npm run poc
npm run poc:manual -- --armed
```

The manual test requires a participant; do not treat completion of its harness as proof of non-interference. Use dummy input only. Never include real credentials or book content in test reports.

## Portable build

```powershell
npm run dist:build
node scripts/test-distribution.mjs --latest-portable
```

The build script verifies fixed Node, Rust, Playwright, and browser versions, then packages the application and dependencies into a Windows executable. It creates an immutable build directory under `artifacts/releases/` and deploys the fixed filename `KindleToZip-Portable.exe` to `_testenv/` using the deployment script. Existing work data is retained; deployment refuses an executable that is in use.

The packaged test runs an isolated copy with self-authored content. It does not replace testing on a clean Windows machine or with the current Kindle reader. No executable is published as part of the initial source push. Before distributing a binary, review third-party license, notice, and corresponding-source requirements for all bundled components.

Portable data is stored beside the executable in `runtime/`, `data/`, and `temp/`. Keep the entire folder together when moving it. Use a writable location supporting Windows ACLs; unsafe paths and links are rejected. Saved browser profiles may be tied to the original Windows user or PC.

## Repository privacy boundary

Only application source, generic development scripts, tests, self-authored fixtures, lockfiles, public documentation, and the explicitly reviewed app screenshot belong in Git. Local agent instructions, planning and participation records, build outputs, browser state, captured pages, and ZIP / CBZ exports are excluded by `.gitignore` and must remain private. The screenshot exception allows one exact file, not arbitrary local images.

Do not use `git add -f` to bypass those exclusions for runtime or browser data. Review staged filenames and content before publishing. Issue attachments and screenshots require a separate privacy review.

# Development and testing

## Requirements

- Windows x64 with PowerShell 7 (`pwsh`) and Node.js 22 or later.
- Portable packaging requires Node.js 22.14.0 exactly.
- Rust 1.99.1 is installed locally under `artifacts/toolchains/`; setup does not change the global PATH.
- npm dependencies are pinned in `package-lock.json`; Rust dependencies and checksums are pinned in both `Cargo.lock` files.

Run the setup commands in the [README](../README.md) before testing. Initial setup downloads tools and dependencies from their official distribution sites and registries.

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

Only application source, generic development scripts, tests, self-authored fixtures, lockfiles, and public documentation belong in Git. Local agent instructions, planning and participation records, build outputs, browser state, captured pages, and ZIP / CBZ exports are excluded by `.gitignore` and must remain private.

Do not use `git add -f` to bypass those exclusions for runtime or browser data. Review staged filenames and content before publishing. Issue attachments and screenshots require a separate privacy review.

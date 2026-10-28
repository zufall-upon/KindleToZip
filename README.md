# KindleToZip

Free and open-source Windows tool to capture pages displayed in the Kindle web reader, review and crop images, and export them as an ordered ZIP of PNG files. No DRM bypass.

Windows向けの無料・オープンソースツールです。専用ブラウザに表示したページを画像として保存し、点検・並べ替え・クロップ後にZIP / CBZへ出力します。

KindleToZip is free and open source. If this project saves you time, consider supporting its development. A financial support channel is not active yet; feedback and bug reports are welcome. Future financial support will use the author's shared GitHub Sponsors account, not a KindleToZip subscription.

**Status: experimental / 開発中。** This is a source-code release, not a verified production release. Compatibility with every Kindle layout, complete-book capture, and operation on a clean Windows PC are not guaranteed. No executable is included in this initial publication.

**Known validation failures:** the initial published implementation's isolated Windows `npm test` run reported **125 passed / 12 failed** in about 576 seconds (including parent/subtest failures). Rust, IPC/local-store, and deployment checks passed separately. The failing UI tests are not fixed or waived; see the [validation report](docs/validation.md). Do not treat this snapshot as a passing release candidate.

**Terms / legal risk remains unresolved:** Amazon's conditions exclude robot-like data gathering tools from the granted permission. No DRM bypass does not establish compliance. See the [terms review and outstanding legal questions](docs/legal-notes-ja.md). This project has not received legal clearance from Amazon or a legal professional.

## 3つの工程 / Three stages

| 工程 | 操作 |
| --- | --- |
| **1. 開く / Open** | 専用ブラウザで本人がKindleへログインし、1冊を開いて対象タブを選びます。 |
| **2. 取得する / Capture** | プレビューで本・領域・方向を確認して承認し、別操作で取得を開始します。承認だけでは開始しません。 |
| **3. 点検して保存 / Review & export** | 停止後に画像の順序・除外・クロップを点検し、PNGをZIP / CBZへ保存します。 |

These are three stages, not three clicks. The main controls are 「決定・次へ」 (confirm / next), 「キャンセル・前へ」 (cancel / back), and 「終了・最初から」 (finish / start over). Follow the next-action guidance shown in the app.

## Features

- Rust controller for local image storage, recovery, non-destructive cropping, and verified ZIP / CBZ export.
- Dedicated Playwright browser, separate from your normal browser profile.
- Preview approval and capture start are separate actions; uncertain targets or page turns stop capture.
- Image ordering, exclusion without deleting originals, and optional two-page spread splitting.
- Standard or 2× rendering density; this does not restore detail absent from the displayed source.
- No paid limits on page count, image quality, speed, or watermarks. Safety limits are 16 megapixels / 32 MiB per PNG.
- No application telemetry or upload of captured pages or book titles. Normal Kindle authentication and reader traffic, plus initial dependency downloads, require network access.
- No KindleToZip account, usage quota, or paid DLC. An Amazon account and any required authentication are still necessary for the official Kindle service.

## Run from source / ソースから起動

Requirements: Windows x64, Node.js 22 or later, and PowerShell 7 (`pwsh`). The portable build script requires **Node.js 22.14.0** exactly. The setup scripts use an isolated Rust **1.99.1** toolchain and Playwright **1.64.1** with Chromium revision **1248**.

```powershell
git clone https://github.com/zufall-upon/KindleToZip.git
cd KindleToZip
npm ci --ignore-scripts --no-fund --no-audit
pwsh -NoProfile -File scripts/install-rust.ps1 -FetchDependencies
npm run browser:install
npm run browser:install -- --headed
pwsh -NoProfile -File scripts/test-rust.ps1
npm start
```

The app opens a local control window. Use 「決定・次へ」 to prepare a job and open the dedicated Kindle browser. Sign in only on the official page, not in the local app. Development data is stored under `artifacts/mvp-data/`.

See [development and testing](docs/development.md) and the [Rust JSONL IPC contract](docs/09-mvp-ipc-ja.md).

## Public builds and verification

[GitHub Actions](https://github.com/zufall-upon/KindleToZip/actions) runs source tests. A separate, manually started workflow builds the Windows portable package from an existing tag matching the selected main-branch commit, tests the packaged public UI with self-authored fixtures, generates SHA-256 checksums and GitHub artifact attestations, and prepares a **draft** release. It does not automatically publish binaries.

The workflow is provided for transparency; until a successful run and review, it is not evidence of a verified release. Checksums detect changed bytes; provenance links artifacts to a workflow and commit. Neither proves the code is safe, legally cleared, or byte-for-byte reproducible. See [release and verification instructions](docs/releasing.md).

## Privacy / 保存データの注意

- The dedicated browser **saves login state by default**. Turn off 「ログイン状態を次回も保存する」 to use a new temporary profile. Temporary profiles are removed on normal shutdown; crashes may leave data behind.
- Portable builds create `runtime/`, `data/`, and `temp/` beside the executable. These folders can contain authentication cookies, browser history, captured pages, and book information. **Do not publish or share them.**
- Reusing a saved profile assumes the same PC and Windows user. Additional authentication may still be required. Secure erasure and secrecy from the same Windows user or administrators are not guaranteed.
- The repository excludes local profiles, captures, archives, build outputs, and private development records. Before reporting an issue, remove credentials, book content, titles, and personal paths from any attachments.

See [authentication, network traffic, and trust boundaries](docs/security-and-trust.md) for the implementation references, external destinations, and limits of these claims. The app has no automatic update checks or automatic support-page access.

## Limitations and responsible use

KindleToZip is an **unofficial, independent project**. It is not affiliated with, endorsed by, or sponsored by Amazon. Amazon and Kindle are trademarks of Amazon.com, Inc. or its affiliates.

The tool captures displayed content. It does not decrypt ebook files, bypass DRM, defeat capture restrictions, or bypass login or access controls. It does not operate the Windows Kindle desktop app. The current entry point targets the Japanese Kindle web reader; other regions and all reader layouts are not verified.

Use only content you are authorized to capture, and comply with applicable law and service terms. The software license does not grant rights to books or permission to redistribute captured pages. A successful ZIP export verifies the archive, not that the entire book was captured. ZIP64 and compatibility with every CBZ viewer are not verified.

Amazon非公式・非提携です。DRM・撮影抑止・認証制限の回避には対応しません。利用権限・著作権・サービス規約を守って使用してください。書籍の再配布を許可するものではありません。

## Author and license

Author: **[zufall-upon](https://github.com/zufall-upon)**

Copyright (C) 2026 zufall-upon.

Licensed under the **GNU General Public License v3.0 only** (`GPL-3.0-only`). See [LICENSE](LICENSE). Third-party dependencies retain their own licenses. The software is provided without warranty.

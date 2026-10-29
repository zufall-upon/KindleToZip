# Initial source validation

## v0.1.6 public release — 2026-10-29

**Published:** [v0.1.6 — Windows x64 Portable](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.1.6), **2026-10-29T10:45:35Z**, as a normal Release + **Latest**, titled **v0.1.6**. The actual desktop TOP-right Releases component showed the complete title and Latest badge without an experimental label. The annotated tag, package/lock/launcher version and workflow source agree at **`50bde1f1561eb40b19022097b6ca5f61fc3cda59`**, with Author/Committer/tagger `zufall-upon`. Earlier tags and public releases/assets are unchanged.

| Gate | Actual result |
| --- | --- |
| [Exact-source CI 40847394795, attempt 2](https://github.com/zufall-upon/KindleToZip/actions/runs/40847394795/attempts/2) | All mandatory gates passed before tagging; controller 24, launcher 3, IPC/store 25, public source UI 155/155 and deployment 4/4; job elapsed 15m21s |
| [Tagged release 40857160980](https://github.com/zufall-upon/KindleToZip/actions/runs/40857160980) | All existing source, deployment, build, packaged public selection/export, transferred-hash, attestation and Draft gates passed; build job 18m21s, Draft job 35s; packaged EXE public selection/export smoke 89.41s |
| Actual Draft | ZIP/EXE hash, size, source/tag/run, allowlisted archive contents, bundled source guide and notices matched; both provenance checks pinned source/signer digest, workflow and GitHub-hosted runner |
| Public assets/UI | Anonymous downloads of ZIP, checksums and Sigstore bundle matched the Draft assets; public API normal Release + Latest and actual right-side Releases UI verified |
| Local deployment | Public hosted EXE hash matched `_testenv/KindleToZip-Portable.exe`; the previous local EXE was copied under an exclusive lock to a new hash-named backup. No forced process termination or runtime/data/temp modification |

| Public file | Bytes | SHA-256 |
| --- | ---: | --- |
| [`KindleToZip-Portable-v0.1.6-win-x64.zip`](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.6/KindleToZip-Portable-v0.1.6-win-x64.zip) | 380,987,509 | `3ab2dccc4e0a90fe4edbfc858b05e9cc3cb2728232109443b79c66713cbc3891` |
| `KindleToZip-Portable.exe` inside ZIP | 860,033,264 | `aba27d20190701f25e0b1e8ef786fa3a08f167f86dd389c00636db317f336127` |

Companion assets: [`SHA256SUMS.txt`](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.6/SHA256SUMS.txt) and [`KindleToZip-build.sigstore.json`](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.6/KindleToZip-build.sigstore.json). The archive contains only the executable, license, frozen trilingual Portable guide, metadata and component notices; no used runtime/data/temp, credentials, book images or private validation records. Online region/crop instructions were updated after publication without replacing the frozen ZIP guide.

The user reported successful operation of the current local crop/region candidate without specifying every check. This is not a new all-region, all-book or clean-Windows acceptance of the hosted EXE; the earlier clean-Windows/complete-real-book report applies to v0.1.2. Hosted tests use self-authored anonymous fixtures. Independent security/legal review and complete redistribution compliance remain unverified. BOOK☆WALKER, ebookjapan and コミックシーモア remain unsupported future plans.

The first source-CI attempt [40847394795/attempts/1](https://github.com/zufall-upon/KindleToZip/actions/runs/40847394795/attempts/1) was **cancelled** at the 30-minute job limit: Rust/IPC passed, public UI stopped after the last reported test 28, and deployment did not run. The next public-MVP test passed in a bounded focused local check (1/1, 16.791s TAP). One debug-enabled rerun of the **same source** passed all mandatory checks; the earlier cancellation is not reclassified as success and its root cause remains unproven.

The first v0.1.6 tagged release [40854636627](https://github.com/zufall-upon/KindleToZip/actions/runs/40854636627) reported **154/155 public UI tests passed**, 807.690s, with a single 30-second reader-tab wait timeout in `captureRepairSaveContext`; no build or Draft followed. The two existing public save-context callers then passed a bounded focused local check (2/2, 41.852s TAP), without changing source or weakening assertions. A single second release dispatch at the unchanged tag/source passed all gates and produced the verified Draft. The earlier timeout and its unproven cause remain recorded.

Saved local evidence was reused: the old local EXE (internal 0.1.4; SHA-256 `4a999ade859efc3d830082501a87096c3a67caca00947a59481dff7a1facda9d`) and 37 bundled source files matched in a 1.422-second read-only collector before the version bump. The `Portable準備` version-alignment regression passed (1 test, 0.084s TAP). No unchanged local broad suite, local rebuild, real-book operation or cleanup was repeated. The bounded diagnostics above are not broad local reruns or substitutes for mandatory hosted gates. The hosted EXE is a new build with its own mandatory gates/hash, not a relabeled local result. Full local receipts are retained under ignored `artifacts/release-routine/v0.1.6/`.

## v0.1.5 release admission failure — 2026-10-29

Exact-source CI [40841975658](https://github.com/zufall-upon/KindleToZip/actions/runs/40841975658) passed every mandatory gate at `ccdefcc050f9da19dc87c8e278e971e2cf1d50ad` (15m40s job elapsed). The annotated `v0.1.5` tag retains that source and is not moved. Tagged release [40843974854](https://github.com/zufall-upon/KindleToZip/actions/runs/40843974854) passed Rust/IPC, then reported **154 passed / 1 failed / 155 tests**, **811.461 seconds** in public source UI. Build, packaged checks and Draft creation did not run; no v0.1.5 executable was produced or published.

The JPEG regression requested crop after observing application `Review` and no acquisition loop, but before the stop command had completed the persisted store transition to `review`. The resulting `wrong_state` correctly enforced the crop precondition. The test now also waits for `manifest.state === 'review'`; application behavior, state guards and all image/quality/original/archive assertions are unchanged. The existing focused JPEG test passed (exit 0, 1/1, 23.187 s TAP duration; test body 21.661 s). No broad local suite, rebuild, cleanup or real-book operation was repeated. The next candidate is v0.1.6; it still requires its own exact-source CI and all tagged release gates before any publication.

## Review correction: region choice versus polling — 2026-10-29 (unreleased)

Independent review reproduced a Medium public-UI defect: a previous `/api/state` response arriving during the change handler's initial paint could replace the selected US region with Japan before the command read the selection. The existing public region test now delivers that in-flight response after the change event. It failed before correction (`us` expected, `jp` actual; exit 1, 3.67 s TAP), without contacting Amazon. The handler now captures the event's selected ID synchronously, before yielding; the packaged region smoke exercises the same collision. Other adapter, capture, crop and Rust behavior is unchanged. This correction's final comparison is author self-recheck, not independent approval of the correction.

| Check | Actual result and scope |
| --- | --- |
| `node --test --test-concurrency=1 --test-name-pattern="Kindle地域公開UI" tests/mvp-workflow.test.mjs` | Exit 0, 1/1 test, 3.97 s TAP. Retains language independence, the actual synthetic regional launch URL, open-browser locking and fresh approval; additionally checks selection against an older polling response. |
| `npm run dist:build` | Exit 0, 10.22 s internal build elapsed. New local `artifacts/releases/build-20261029-065300-20d94408/KindleToZip-Portable.exe`, 860,077,129 bytes, SHA-256 `4a999ade859efc3d830082501a87096c3a67caca00947a59481dff7a1facda9d`; payload SHA-256 `91451c471ea746a14f7d0785df92eb11931cbb67f1b767e2b306e68126166993`. Existing `_testenv` deployment was skipped. |
| `node scripts/test-distribution.mjs --latest-portable` | Exit 0, 77.90 s. Receipt `artifacts/distribution-tests/run-31e6a0164355/smoke-result.json`. Actual new EXE exercised the region/poll collision and public language/region selection, PNG/JPEG automatic comparison/cancel/apply/restore, manual crop, per-image split/order, reopened ZIP/CBZ image bytes/dimensions/edge pixels, plus existing move/reuse, lock and write-denial checks. |

Both new EXE comparison screenshots (`fixture-auto-png.png` and `fixture-auto-jpeg.png` beside that receipt) were visually inspected: reduced black surround, retained thin left line, panel frames and lower isolated marks. The unchanged origin/safe-stop, moved-chrome, Rust and crop-only results below remain evidence from their original executions, not new reviewer executions. The earlier EXEs, receipts, published v0.1.4, tags, real-book/login data and unrelated files were retained. No commit, push or publication was performed; internal version remains 0.1.4 and this is not the hosted release. These are anonymous headless fixtures, not real regional book compatibility, clean-Windows testing or user visual acceptance.

## Local region/adapter and automatic-crop candidate — 2026-10-29 (unreleased)

This extends the retained automatic-margin work below; it is **not** the published v0.1.4. No release, tag, push, live login or real-book operation was performed. The final local executable is `artifacts/releases/build-20261029-063616-05b84512/KindleToZip-Portable.exe` (860,076,177 bytes), SHA-256 `e85bc2a0c3f35ea8b6bd7d8410a463d47d171aa9af2afa668d99bd5a1ae152ce`; payload SHA-256 `e7d2980b6dbdb6a28f341098e7ad1517ca5b39c2c4ad505227ae89289a8dccaf`. Its internal version remains 0.1.4 and must not be confused with the hosted release. The prior local `_testenv` executable was not deployed over; its observed SHA-256 is still `988c3e63f7cbfe0c3218c96cbd3fd5808adecc989ac31703a6492b58a3001e1b`.

The public UI independently selects Kindle Japan, US or UK before opening the browser. A fixed store adapter supplies launch, target-origin, library/chrome, visible identity and one-turn behavior to shared capture/review/export code. An open-browser region change is refused; closing and changing requires fresh tab selection, preview, approval and separate start. Other stores remain unsupported. [The adapter plan](store-adapters.md) records official-destination evidence and future BOOK☆WALKER, ebookjapan and コミックシーモア work. Official search-index excerpts identified all three destinations; direct HTTP root fetches returned 503. No real regional reader compatibility is inferred from those excerpts or synthetic responses.

| Check | Actual result and measured scope |
| --- | --- |
| `node --test --test-concurrency=1 --test-name-pattern="Kindle地域\|MVP読書タブ\|MVPプレビュー認証UI\|MVP安全停止\|撮影途中の対象変更\|別タブ・表示条件変更" tests/mvp-workflow.test.mjs tests/sample-safety.test.mjs` | Exit 0, 20/20 reported tests, 38.15 s TAP duration. Three regional origins, cross-region and lookalike rejection, picker, capture/turn, before/after target checks, public language-independent selection and actual launch-URL forwarding using exclusively local synthetic HTTPS responses, plus existing auth/book/tab safe stops. |
| `node --test --test-concurrency=1 --test-name-pattern="再プレビュー対象の切分け\|Kindleプリセットの可視証拠\|Kindle初回hidden" tests/portable-repair-flow.test.mjs` | Exit 0, 5/5 reported tests, 32.98 s TAP duration. Existing public consumers of the moved library/chrome behavior, including hidden-node evidence, position/replacement rejection and canvas/iframe recovery boundaries. |
| `npm run dist:build` | Exit 0, 17.27 s internal build elapsed. Unique local EXE above; existing `_testenv` deployment explicitly skipped. Existing pinned Node 22.14.0, Playwright 1.64.1, Chromium 1248 and isolated offline Rust 1.99.1 environment reused. |
| `node scripts/test-distribution.mjs --latest-portable` | Exit 0, 77.36 s runner elapsed. Receipt `artifacts/distribution-tests/run-947e805ad770/smoke-result.json`. Actual bundled public region/language selection and open-browser locking, selection/approval/separate start, PNG/JPEG comparison/cancel/apply/restore, manual crop, per-image split/order and reopened ZIP/CBZ image dimensions/bytes/edge pixels passed. Existing move/reuse, lock and write-denial checks also passed. |
| `node scripts/check-portable-delivery.mjs artifacts/releases/build-20261029-063616-05b84512/KindleToZip-Portable.json artifacts/distribution-tests/run-947e805ad770/smoke-result.json --headless-only` | Exit 0, 1.545 s collector elapsed. Saved EXE/payload, 37 bundled source files, launcher and receipt matched; the EXE tests were not rerun. |

The initial new region diagnostic failed (exit 1, 11.94 s TAP duration): navigation during screenshot correctly cleared the binding but exposed a null-binding TypeError before the intended error. Capture now checks binding identity after the screenshot and reports `target_changed`, without returning image bytes. The later declared combined regression above passed. No broad suite or unchanged Rust/crop-only suite was repeated; their retained earlier evidence is below. A server restart after the successful packaged run interrupted an additional read-only receipt collector. Saved native exits and the same EXE/receipt were reused; only that short collector was completed again, not the build or packaged app run.

The implementer inspected both actual EXE comparison screenshots, `artifacts/distribution-tests/run-947e805ad770/fixture-auto-png.png` and `fixture-auto-jpeg.png`: the black surround is reduced and the narrow left line, panel frames and lower page-number-like marks remain. These are headless, self-authored anonymous fixtures, not copies of the user's book images, user visual acceptance, clean-Windows testing, or real Kindle/whole-book results. Existing real-book/login data, unrelated untracked scripts and `.sortie-env` were left in place. Published assets and tags were not modified. This documentation-only result entry does not change the tested bundled application, fixtures or test commands.

## Local automatic-margin candidate — 2026-10-29 (not the published v0.1.4)

This is a new local build, not a replacement for the published release below, despite its unchanged internal version `0.1.4`. No release, tag or push was made. The candidate executable is `artifacts/releases/build-20261029-060812-bcaa13b2/KindleToZip-Portable.exe` (SHA-256 `4ce60f3c5cf40671be424f9e56be2012f2eacd2d07fa4b34fc1fc960ca0f9614`); its build report is `artifacts/releases/build-20261029-060812-bcaa13b2/KindleToZip-Portable.json`. The build now skips automatic deployment when an existing `_testenv/KindleToZip-Portable.exe` is present. The existing EXE's SHA-256 remained `988c3e63f7cbfe0c3218c96cbd3fd5808adecc989ac31703a6492b58a3001e1b` before and after this build; the skipped deployment is recorded in the build directory's `deployment.json`.

The detector examines complete opaque edge lines in the existing PNG/JPEG decoder representation, accepts only near-white or near-black runs, and retains a safety band. It does not reuse the layout heuristic's ignored edges or recognize content. A uniform image, coloured/grey border, transparency or other ambiguous edge can leave no candidate; the existing manual crop remains available. Preview and cancellation do not save a crop. Applying a candidate rechecks the original, job and render revision and uses the same original-coordinate, capture-quality, non-destructive derived-image path as manual crop. Review remains essential: even a conservative geometry rule cannot identify all content.

| Check | Result and scope |
| --- | --- |
| Pre-change `node --test --test-name-pattern="split spread preserves deliberate black crops" tests/local-store.test.mjs` | Exit 0, 3 reported tests, 0.95 s; the existing narrow-crop rejection preserved the manifest and produced no orphan. |
| Focused automatic-margin regression | Exit 0, 4 reported tests, 44.75 s; PNG/JPEG public comparison, cancel/apply/reset, retained capture quality after current settings changed, ZIP/CBZ order and edge/detail pixels, and store stale-candidate rejection. Separate grey-background/no-candidate and missing-ID state checks passed in 0.77 s. |
| `pwsh -NoProfile -File scripts/test-rust.ps1` | Exit 0; controller 24, launcher 3, and IPC/store 25 tests passed. Approximately 44.1 s between surrounding clock observations. |
| `node --test --test-concurrency=1 --test-name-pattern="自動余白\|JPEG匿名試料\|JPEG画像軽量化\|MVP単ページ" tests/mvp-workflow.test.mjs` | Exit 0, 11 reported tests, 105.76 s as measured by Node; includes the pre-existing JPEG and page-layout callers. The vertical bars in this table denote the command's regex alternatives. |
| `npm run dist:build` | Exit 0, 18.60 s as reported by the build. It produced the unique local executable above and preserved the previous `_testenv` executable. The existing `Portable準備` build-caller check passed (exit 0, 0.08 s); the separate existing `Portable配置` helper test passed (exit 0, 0.63 s). A full build with an initially absent `_testenv` EXE was not repeated. |
| `node scripts/test-distribution.mjs --latest-portable` | Exit 0, 74.74 s. The actual bundled EXE ran the public fixture selection, approval, separate start, PNG/JPEG capture, comparison/cancel/apply/reset, manual crop, left-first split, ZIP/CBZ read-back, dimensions, ordered bytes and edge pixels. The separate pre-existing move, lock and write-denial checks also passed. Receipt: `artifacts/distribution-tests/run-2b094c84ae54/smoke-result.json`. |
| `node scripts/check-portable-delivery.mjs artifacts/releases/build-20261029-060812-bcaa13b2/KindleToZip-Portable.json artifacts/distribution-tests/run-2b094c84ae54/smoke-result.json --headless-only` | Exit 0, 1.614 s; checked the saved EXE, payload, 35 bundled source files and receipt without rerunning the EXE. |

The first focused public test failed for both formats (exit 1, 84.45 s); two diagnostic reruns (exit 1, 23.00 s and 24.00 s) established that the fixture's grey CSS frame actually appeared in the captured edge. The detector correctly refused to discard that non-black edge. The fixture's geometry was retained, its frame colour was made continuous with its black surround, and the focused test was rerun successfully; the detection rule was not relaxed. A source execution of the packaged image-smoke function was repeated after UI selection-race protection changed (exit 0, about 50.7 s between clock observations).

The actual EXE comparison screenshots are `artifacts/distribution-tests/run-2b094c84ae54/fixture-auto-png.png` and `artifacts/distribution-tests/run-2b094c84ae54/fixture-auto-jpeg.png`. The implementer visually compared both original/candidate panels: the black surround is reduced while the fictional narrow left line, panel borders and lower page-number-like marks remain. They are independently drawn, headless samples, not copies of the user's book screenshots, not real Kindle/book operation, not a clean-Windows test, and not the user's own visual approval. Existing credentials, real books and the published release were not operated or changed.

## v0.1.4 public release — 2026-10-29

**Published:** [v0.1.4 — Windows x64 Portable](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.1.4), **2026-10-29 05:08:42 UTC**, as a normal Release + **Latest**, titled **v0.1.4**. The actual desktop TOP-right Releases component showed the complete `v0.1.4` title and Latest badge, without an experimental label. The annotated tag, package/launcher version and workflow source agree at **`b9cd7164813a6850c7bcf7671673aa8bea46d5c2`**. Earlier tags are unchanged, including failed packaging tag `v0.1.3`; v0.1.2's public assets remain unchanged.

| Gate | Actual result |
| --- | --- |
| [Tag-free package preflight 40817995533](https://github.com/zufall-upon/KindleToZip/actions/runs/40817995533) | Fresh build/deployment, packaged public selection/export, notices and transferred hashes passed; packaging job 3m10s, Linux verification 31s |
| [Exact-source CI 40818426954](https://github.com/zufall-upon/KindleToZip/actions/runs/40818426954) | Explicitly dispatched on the unchanged preflight commit; all mandatory gates passed, 14m5s job elapsed; controller 23, launcher 3, IPC/store 24, source UI 147/147, deployment 4/4 |
| [Tagged release 40819770601](https://github.com/zufall-upon/KindleToZip/actions/runs/40819770601) | Every existing source/build/packaged/transferred-hash/attestation/Draft gate passed; build job 16m35s, draft job 48s |
| Actual release EXE | Packaged public selection, approval/start, PNG/JPEG image handling, crop/order/split and reopened ZIP/CBZ, whole-folder reuse, locking, private paths and write-denial checks passed; 90.29 seconds internal smoke elapsed |
| Downloaded Draft | ZIP/EXE hashes, sizes, source/tag/run metadata, 21 allowlisted entries, trilingual guide and JPEG crate licenses/IJG notice matched; ZIP and EXE provenance verified the exact source, release workflow and GitHub-hosted runner |
| Published assets and screen | Anonymous HTTP 200 downloads of all three assets matched the verified Draft; public API returned normal Release + Latest; rendered trilingual notes and the actual right-side Releases component verified |

| Public file | Bytes | SHA-256 |
| --- | ---: | --- |
| [`KindleToZip-Portable-v0.1.4-win-x64.zip`](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.4/KindleToZip-Portable-v0.1.4-win-x64.zip) | 380,974,486 | `523e525a957b52ef8a042ae56bfc88c47ce9459afa7a2afb9bb9151bb1ac3fbf` |
| `KindleToZip-Portable.exe` inside ZIP | 859,950,108 | `f45638610edf56a554d52e80d5a0ca2590342273b9a506bcce94e507b4c0427e` |

Companion assets: [`SHA256SUMS.txt`](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.4/SHA256SUMS.txt) and [`KindleToZip-build.sigstore.json`](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.4/KindleToZip-build.sigstore.json). The archive contains only the executable, project license, frozen Portable guide, metadata and component notices. It contains no used runtime/data/temp, login profiles, book images or private evidence. JPEG license collection is not a full independent redistribution/legal review.

The user confirmed the local improvements without detailing the scope. The earlier clean-Windows/whole-real-book report concerns v0.1.2, not byte-specific acceptance of this new hosted EXE. Hosted tests used self-authored fixtures. Current Kindle layouts/regions, all books, independent legal/security audit and complete redistribution obligations remain unverified. The original local EXE and saved evidence were reused without local rebuild, broad retest, cleanup or real-book operation. The two corrected admission groups and CRLF packaging regression above are targeted checks, not a repeated local suite. The `[skip ci]` push was not accepted as CI; the same commit's mandatory CI was explicitly dispatched before tagging.

## v0.1.3 release admission — 2026-10-29

The corrected exact-source CI [40814810009](https://github.com/zufall-upon/KindleToZip/actions/runs/40814810009) passed all mandatory gates at `a14bc750db9e365991ce5cb6cb0e962afd56cf1a` (14 minutes 16 seconds job elapsed); the annotated `v0.1.3` tag retains that source. Release run [40816212315](https://github.com/zufall-upon/KindleToZip/actions/runs/40816212315) passed Rust/IPC, public UI, deployment, build, and packaged public selection/export, then failed JPEG notice collection: its PowerShell lockfile regex did not accept CRLF after the version line. No draft or public assets resulted. The tag is not moved. The next candidate is **v0.1.4**, with a minimal CRLF-compatible regex and an LF/CRLF/wrong-version regression. Application code and the accepted local EXE remain unchanged; tag-free package preflight must pass before another tag is created, followed by mandatory exact-source CI and all tagged release gates.

The first exact-source CI [40813169826](https://github.com/zufall-upon/KindleToZip/actions/runs/40813169826) at `db77598f3f8f3576ddf13fc7e54d9ade0682c176` passed Rust/IPC but failed public UI admission: **143 passed / 4 failed / 147 reported tests**, including the failed parent, in **806.25 seconds**. Deployment was skipped; no version tag or draft was created from this failed run.

Two test assumptions predated navigation suppression. The iframe race hook now injects movement only during the actual advance operation, not the earlier capture geometry query. The same-position/different-image resume check now changes the anonymous canvas pixels, rather than relying on the next button's disabled appearance, which is intentionally excluded from captures. The existing geometry, no-wrong-click, retained-original, no-duplicate and separate resume approval assertions remain intact. The two affected groups passed locally (5 reported tests, **45.34 seconds** command elapsed). Application code and the accepted local EXE are unchanged; local broad suites, rebuilding and real-book operations were not repeated. The corrected exact source still requires mandatory CI before tagging.

## Image-layout and JPEG work, 2026-10-29 (earlier source)

The two supplied screenshots were inspected privately; they are not included in this repository or the anonymous fixture. The first shows a colourful portrait cover on the left, a wide black area on the right, horizontal chrome above and below, and a right-edge navigation control. The second shows a white page on a black surround with a left-edge button overlapping page content. The independently drawn `reader-image-review` fixture reproduces those spatial relationships using simple coloured shapes and fictional panels; its geometry was visually compared with both screenshots. It does not reproduce their artwork, words, exact aspect ratios, real reader DOM, all layouts, or the actual books. It is not evidence of current Kindle or real-book operation. No existing login or real book was operated for this work.

The current source adds `jpeg-decoder` 0.3.2 from crates.io (https://github.com/image-rs/jpeg-decoder, MIT OR Apache-2.0, default `rayon` feature disabled) and `jpeg-encoder` 0.6.1 from crates.io (https://github.com/vstroebel/jpeg-encoder, (MIT OR Apache-2.0) AND IJG). Exact versions and checksums are locked in `poc/controller/Cargo.lock`; the isolated existing Rust toolchain/cache is reused. JPEG capture is lossy and crop/split recompress. Original captured bytes remain unchanged; automatic layout can misclassify, and only the selected eligible navigation control is hidden temporarily. Cropping is manual, not an automatic content-removal algorithm. Existing jobs are read using PNG defaults when the new fields are absent; older app versions may not read jobs written by the new source, so keep a backup before switching versions.

The released v0.1.2 assets and tags are unchanged. Source/fixture results and a locally built Portable candidate must not be described as validation of that published build or of an independent legal/security review.

The user later said they had confirmed the local image improvements; the scope of that confirmation was not specified. This is distinct from the user's earlier clean-Windows and complete real-book report for v0.1.2 and from the automated fixture checks. It does not establish those results for a future hosted build.

The local candidate is `artifacts/releases/build-20261029-015742-32f9e95a/KindleToZip-Portable.exe` (859,993,617 bytes), SHA-256 `988c3e63f7cbfe0c3218c96cbd3fd5808adecc989ac31703a6492b58a3001e1b`, payload SHA-256 `99304e69a8221dd708c77a6ca42a700100694deaaee0733f6a322e1ff59c6577`. Its embedded app version is 0.1.2; it is deployed locally, not published or relabeled as v0.1.3. A future hosted v0.1.3 build is a different executable and requires its own mandatory release gates. Private anonymous-fixture evidence is retained in `artifacts/distribution-tests/run-f1b7d66f52ed/`; its smoke result records PNG and JPEG public selection, approval/start, single-cover handling, manual crop with retained originals, and reopened ZIP/CBZ outputs.

The worker's final native checks all exited 0: `pwsh -NoProfile -File scripts/test-rust.ps1` (about 104.1 s); the declared affected MVP groups (23 reported tests, 117.1 s TAP duration); `npm run dist:build` (about 73.4 s command elapsed, 15.53 s internal build time); and `node scripts/test-distribution.mjs --latest-portable` (about 190.5 s command elapsed, 72.04 s internal smoke time). An earlier smoke attempt failed because another sample's persisted preset was reused. The harness now explicitly selects its sample preset; that failure was followed by a new build and smoke run, not reclassified as a pass. A subsequent JPEG-job reopen assertion changed only the test, and the affected UI checks were rerun. Final binding uses that JPEG regression and `scripts/check-portable-delivery.mjs` to compare the fixed EXE/payload/embedded sources/controller and retained evidence without rebuilding or operating the app again. Full-suite and real-book tests were not repeated.

Date: 2026-10-28. Implementation revision: `24eab0b616935ff676c2a4a25b6f88bb748a846a`.

## Scope and results

Validation used an isolated export of the publication index on the existing Windows development PC. All implementation files matched the published candidate byte-for-byte. npm dependencies were installed with `npm ci --ignore-scripts`; the fixed browser binaries and isolated Rust cache/toolchain were reused. This was not a clean Windows machine, a current Kindle session, or a packaged-executable acceptance test.

| Check | Result |
| --- | --- |
| Rust controller unit tests | 22 passed |
| Rust launcher unit tests | 3 passed |
| Node IPC / local-store tests | 23 passed, about 6.64 seconds |
| `npm test` | **125 passed / 12 failed**, 137 reported tests, about **576.01 seconds** |
| `npm run test:distribution` | 2 passed, about 1.16 seconds TAP duration / 2.29 seconds command elapsed |
| JavaScript and PowerShell source syntax | Passed |
| Workflow static checks (`actionlint` 1.7.12) | Passed |
| Release ZIP/checksum/notice collection | Passed with a synthetic executable only; not a real release build |
| Secret scan (`gitleaks` 8.30.1) | No findings in the public files or the two-commit initial public history |

The 12 reported failures include failed parent containers and their failed child tests. They correspond to **eight top-level tests**, not 12 independently identified product defects. No full-suite retry or selective removal of failing tests was used to obtain a green result.

## Observed failures

| Test area | Observed result |
| --- | --- |
| Twelve-page acquisition / end candidate | Timed out while still `Capturing`; expected stop state was not reached within the test deadline. |
| Black image after resume | Expected `black_image`, observed `advance_uncertain`. |
| Pause during pending page turn | Timed out while still `Capturing`. |
| Stable direct-iframe turn | `page.waitForFunction` exceeded 1,800 ms. |
| Scrolled 2× capture | Expected HTTP 200, received HTTP 400 with `resume_position_required`. |
| Spread preview / approval / export flow | Approval button remained disabled and click timed out after 30 seconds. |
| Public resume from ambiguous next-page control | `ENOENT`: the parent directory `artifacts/indicator-review/` was absent when the test called `mkdtemp`. |
| Japanese / English / Chinese UI flow | The same missing test-fixture parent directory caused `ENOENT`. |

The first six areas are in [MVP workflow tests](../tests/mvp-workflow.test.mjs). The last two are in [portable repair flow tests](../tests/portable-repair-flow.test.mjs). The missing directory is a test-setup problem observed on a fresh source export. The causes of the other failures have not been established; timing or environment effects must not be assumed to explain all of them.

## Publication boundary

The source was intentionally frozen for initial publication. Concurrent local implementation changes were not included, reverted, or claimed as fixes. The follow-up publication changes document validation only; they do not change application behavior or test expectations.

No new portable executable was built, accepted, or published during this task. GitHub-hosted CI and the manual release workflow are separate executions; consult [Actions](https://github.com/zufall-upon/KindleToZip/actions) for their actual results. The manual release workflow must stop when source tests fail, and must not be bypassed to publish an unverified candidate.

The initial build attempt in the active development directory also encountered a locked controller executable. Testing moved to an isolated copy without terminating the running app. An initial junction-based browser test setup was replaced by a plain browser copy before the results above were collected. These harness corrections are not application fixes.

## Final local Portable candidate — 2026-10-28

This later record does not erase the initial failed run above. The accepted local `0.1.0` Portable candidate is **859,432,525 bytes**, SHA-256 **`d0edebae5e3f7609c8e2ad27a36df5ee2830570a0753e61b2055e8910ae9593d`**. Saved native UI evidence records the self-authored sample, public selection of all three languages, distinct-folder ZIP destinations, cancel/keep/reset consent, preserved exports, and retaken output.

The retained-image regression records a safe stop after **67 images**, continuation to **71**, and a separately confirmed continuation to **73**. Saved originals remain intact, duplicate/missing captures are absent in that sample, fresh resume comparison is required, and a same-position/different-pixels case is blocked. This is anonymous fixture evidence, not Amazon authentication or whole-real-book acceptance.

Release preparation reuses these saved results. The existing read-only collector matched **33 packaged source/controller files**, the original build, deployed EXE, and retained evidence copy, including the payload hash. It completed in **2.78 seconds** command elapsed without rebuilding or launching the app. The evidence paths remain local/private; the source collector is `scripts/check-resume-delivery.mjs`.

The final source is frozen separately for the [release workflow](releasing.md). A GitHub Actions rebuild has its own hash and required checks; local evidence is not a substitute for that workflow or a claim that a different executable was tested. At that local-candidate stage, clean-Windows acceptance and complete current real-book capture were unverified; the later user report is recorded below.

## Release admission follow-up — 2026-10-28

Source CI [40662182897](https://github.com/zufall-upon/KindleToZip/actions/runs/40662182897) tested `c69ed730b88931ef5b129bf0d5b4cfd194db5d0d`. Rust/IPC passed; the public source UI run reported **129 passed / 10 failed / 139 tests** in **670.96 seconds**, including failed parents and subtests. Deployment was skipped. No tag, draft, or executable release was created from that failure.

The corrections are limited to test admission; the application and accepted local EXE are unchanged:

- Wait for export operation ownership to be released, not merely a newly appended export record, before testing overwrite refusal.
- Give the complete 12-image acquisition/resume a bounded 60-second wait; the original 25-second whole-fixture wait also failed locally. Give the first real iframe turn its own test wait instead of inheriting the reader's 1.8-second single-action timeout. Production timeouts and assertions are unchanged.
- Test each capture scale in an independent job. Align the split-page fixture to its next unsaved position before resuming. The same-position/different-pixels guard stays intact; it must not be bypassed to make these image-format tests pass.
- Discover the known filename edit IDs in both upgraded and classic owned Windows save dialogs, rejecting missing/ambiguous matches rather than choosing an arbitrary edit. A forced classic-dialog regression reproduced edit ID `1148` locally. Its cancel/selection tests plus the existing public-UI native save/export regression passed **4/4 in 16.43 seconds**. Selecting a destination alone still creates no archive.

The six affected workflow groups passed **17/17 reported tests in 106.03 seconds**, including overwrite refusal, 12-image end detection/resume, cancellation and same-position collision blocking, stable/moving iframe controls, both scrolled capture scales, and split-page ZIP/CBZ output. Together with the native-dialog checks, the bounded local regression result is **21/21**, without repeating unchanged Rust, broad UI, packaged-app, real-book, or cleanup checks.

These local affected checks do not make the failed hosted run successful. The correction commit still requires its own successful mandatory source CI before tagging and the separate hosted packaged-release gates before publication.

The next source CI, [40665370837](https://github.com/zufall-upon/KindleToZip/actions/runs/40665370837) at `b06c40757a89c89b60be7229597ce5d1b0ca9c45`, passed every previously failing MVP workflow group, retained-image resume, and the public three-language flow. Its UI total was **138 passed / 4 failed / 142 reported tests in 717.12 seconds**. The remaining failures were native-dialog test admission: the hosted Windows shell omitted the known `.zip` extension in the filename edit, and the first classic-dialog driver exceeded its 25-second outer watchdog. The selected absolute path still needs the exact requested extension; only the shell's displayed initial filename accepts the two exact forms. The outer watchdog is now 45 seconds to cover the driver's bounded 15-second appearance, 8-second readiness, and 8-second exit waits plus host startup. Phase timings are recorded rather than attributing the unmeasured delay to a specific stage. Native-only revalidation passed **4/4 in 16.13 seconds**; unchanged MVP and packaged checks were reused, not repeated locally. The failed hosted run remains a failure.

Source CI [40667599324](https://github.com/zufall-upon/KindleToZip/actions/runs/40667599324) at `e95563fa168cd94515bb41cbc4c6eaab0ad60190` reported **139 passed / 3 failed / 142 tests in 701.54 seconds**. Only native-dialog groups failed: the first classic dialog exposed no UIAutomation edit, and a later public selection did not update the expected destination. Other source regressions passed again; deployment remained skipped. Further diagnosis therefore uses the separate native-only hosted workflow instead of another broad trial. It records owned-window control structure and the dialog's actual selected value, and does not bypass or satisfy mandatory release CI.

The isolated hosted diagnosis established that the first classic dialog already had its filename `Edit` HWND while the root UIAutomation provider exposed no edit or supported value pattern. In the upgraded dialog, UIAutomation could read back a changed edit while the dialog returned the original selected name. The test driver now resolves only unique known controls inside the owned dialog, uses bounded native-control text messages and the edit's normal change notification when available, and retains UIAutomation for supported controls. It does not send global keyboard/mouse input or use the clipboard. The application and accepted local EXE remain unchanged.

Native-only hosted run [40671260959](https://github.com/zufall-upon/KindleToZip/actions/runs/40671260959) at `7cf48c4557a5d76f20147b3915843dd4bc6d3561` passed **5/5 reported tests in 16.53 seconds** (41 seconds job elapsed). It covers first-use classic cancellation, classic selection, upgraded cancellation, and upgraded selection, including exact returned Unicode paths and no archive creation by selection alone. The affected public-UI cancel/select/export/recovery regression then passed locally in **13.79 seconds**, including its exact API-selected destination assertion. Intermediate diagnostic-only revisions were not tagged or treated as passing mandatory source CI. The next frozen revision still needs the full mandatory source checks before tagging.

## v0.1.0 source acceptance and draft-build failure

Source CI [40671553460](https://github.com/zufall-upon/KindleToZip/actions/runs/40671553460) passed at `feb653da27b6c8b0b6046ba6eb33ae205be0a03a`: Rust controller **22**, launcher **3**, Node IPC/store **24**, public source UI **142/142** (628.25 seconds), and deployment **2/2**. The annotated `v0.1.0` tag preserves this exact revision.

The first draft workflow, [40673248850](https://github.com/zufall-upon/KindleToZip/actions/runs/40673248850), passed its tag, Rust/IPC, source UI, and deployment gates, but stopped before producing an executable because `chromium-1248` was missing. Its `npm.ps1` invocation discarded `--headed`; a no-download argument probe reproduced an empty argument list via npm and the correct argument via direct Node execution. No packaged test, draft, or public executable resulted. This failure is not reclassified as source or packaged acceptance.

The user authorized **v0.1.1** rather than moving or replacing `v0.1.0`. Both Windows workflows and the three source setup guides now invoke `node scripts/install-browser.mjs --headed` directly. Application/package-lock and launcher versions are aligned at `0.1.1`; controller component version remains unchanged. A focused static regression guards the exact headed command and version consistency. Earlier local `0.1.0` evidence remains historical; the new hosted package has its own mandatory gates and hashes.

## v0.1.1 source acceptance and final deployment failure

Source CI [40676271113](https://github.com/zufall-upon/KindleToZip/actions/runs/40676271113) passed all required steps at `7123ca80fa1e40b5821b0cc126759fa5d8d9d56c`; `v0.1.1` retains that revision. Draft run [40678023106](https://github.com/zufall-upon/KindleToZip/actions/runs/40678023106) passed its source/deployment gates, installed the headed browser, compiled both release components, and assembled the EXE. It then stopped because the fresh runner had no ignored `_testenv` destination. Packaged tests and draft creation did not run, and no executable from that attempt was retained or accepted for publication.

The user authorized **v0.1.2**, preserving both existing tags. The builder now initializes only its fixed workspace `_testenv` destination before calling the unchanged validating deployment helper. Application/package-lock and launcher versions are aligned at `0.1.2`. The tag-free preflight exercises fresh-checkout build, packaged public selection/export, the shared release archive/notice collector, and cross-runner checksums before any new tag is created. It is not a substitute for exact-commit mandatory source CI or the tagged release workflow's required gates.

The first tag-free run, [40682154124](https://github.com/zufall-upon/KindleToZip/actions/runs/40682154124) at `99b9c76511689802ef062291932f18421ff5d1ae`, completed fresh-checkout build and deployment in the intended isolated runner. Packaged admission then rejected its test's obsolete `export.zip` expectation: the actual public UI correctly proposed the selected anonymous book title. Related bundled smoke expectations now check the exact book-owned destination in both jobs and explicitly choose **keep images** in the current public reset confirmation after cancellation. No application behavior or safety assertion was relaxed. Archive collection/transfer remained untested in that failed run, and no `v0.1.2` tag was created.

<a id="v012-public-experimental-release--2026-10-28"></a>

## v0.1.2 public release — 2026-10-28

**Published:** [KindleToZip v0.1.2 — Windows x64 Portable](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.1.2), **2026-10-28 12:33:30 UTC**, initially as a prerelease. The user subsequently requested the repository TOP-right **Releases** listing and explicitly authorized normal Release + **Latest**. On **2026-10-29**, after confirming clean-Windows operation and complete real-book capture, the user requested removal of the experimental label. The current release title is **v0.1.2**. The tag, executable, ZIP, and checksums are unchanged. The annotated tag points to **`e3e3977588d75fffb72dae9f402288ca69f8bfe0`**. Earlier `v0.1.0` and `v0.1.1` tags remain untouched and have no executable release assets.

| Final gate | Result |
| --- | --- |
| [Tag-free package preflight 40682903449](https://github.com/zufall-upon/KindleToZip/actions/runs/40682903449) | Passed fresh-checkout build/deployment, packaged public regressions, shared archive/notice collection, and Windows-to-Linux checksum verification |
| [Mandatory exact-commit source CI 40683644665](https://github.com/zufall-upon/KindleToZip/actions/runs/40683644665) | Rust controller 22; launcher 3; IPC/store 24; public source UI **142/142**; deployment **3/3**; no failures |
| [Tagged release workflow 40685376544](https://github.com/zufall-upon/KindleToZip/actions/runs/40685376544) | All source, build, packaged public selection/export, transferred checksum, attestation and draft steps passed |
| Actual release EXE packaged regression | **66.53 seconds**, exit 0: preview/selection and separate approval/start, book-owned ZIP destinations, two-book/profile reuse and retained exports, crop/order/split output, ZIP/CBZ reopening, whole-folder move/reuse, exclusive data lock, private paths and write-denial handling |
| Downloaded draft admission | ZIP and inner EXE hashes/size matched checksums and build metadata; 16 allowlisted entries, trilingual Portable guide and license text, component notices, exact source/tag/run; ZIP and EXE Sigstore verification matched the source commit, release workflow and GitHub-hosted runner |
| Public verification | Anonymous API returned HTTP 200; initial publication was `draft=false`, `prerelease=true`. After the user's sidebar request, the current state is `prerelease=false` + Latest, with all three asset IDs/digests unchanged. The public ZIP and companion assets matched the verified draft; GitHub rendered the trilingual notes and asset links. The actual Releases component was verified in the desktop right-hand pane; the current requested title is v0.1.2 with the Latest badge |
| User-reported manual validation — 2026-10-29 | The user confirmed clean-Windows operation and complete real-book capture. This is a user report, separate from the self-authored hosted fixtures, not an independently reproduced automated result or a guarantee for all environments/books |

The `[skip ci]` candidate was not treated as accepted source: after tag-free packaging succeeded, the full existing `ci.yml` was explicitly dispatched on the same unchanged commit and passed before tagging. The final `release.yml` retained and passed all of its existing mandatory checks. The preflight EXE is a different build and its hash was not substituted for the release EXE.

| Public file | Bytes | SHA-256 |
| --- | ---: | --- |
| [`KindleToZip-Portable-v0.1.2-win-x64.zip`](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.2/KindleToZip-Portable-v0.1.2-win-x64.zip) | 380,783,281 | `12f0dcf720b212688087bbf99175dc13d5aa823247f225447beafc99b7d0af36` |
| `KindleToZip-Portable.exe` inside that ZIP | 859,389,970 | `ee4ab0423a20979da329e69a071aa43bf4d80b7fcd3d42bf0641f935963077bc` |

The release also provides [`SHA256SUMS.txt`](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.2/SHA256SUMS.txt) and [`KindleToZip-build.sigstore.json`](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.2/KindleToZip-build.sigstore.json). Metadata records Node **22.14.0**, Playwright **1.64.1**, Chromium revision **1248**, app/launcher **0.1.2**, and the unchanged controller component **0.1.0**.

All packaged reader content was self-authored. The public ZIP contains no used `runtime/`, `data/`, `temp/`, login profiles, captured book pages, or private validation records. The agent did not reopen or operate local actual-book state for release preparation; the user's subsequent manual confirmation is recorded above. Every region/layout, independent security review, legal clearance, and complete third-party redistribution review remain **unverified**, not successful. The historical local 67 → 71 → 73 image record is not byte-specific acceptance of this new hosted EXE.

The 2026-10-29 label change updates the public release metadata and current online guides only. The already-published ZIP, its embedded source-tagged README, the EXE, checksums, provenance, and version tags remain unchanged; the embedded README retains its original publication-time status text. No rebuild, new app/book operation, broad test rerun, or replacement asset is required for this documentation change.

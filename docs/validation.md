# Initial source validation

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

The final source is frozen separately for the [release workflow](releasing.md). A GitHub Actions rebuild has its own hash and required checks; local evidence is not a substitute for that workflow or a claim that a different executable was tested. Clean-Windows acceptance and complete current real-book capture remain unverified.

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

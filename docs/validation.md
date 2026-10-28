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

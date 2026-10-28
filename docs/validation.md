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

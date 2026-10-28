# README and screenshot review

This is a documentation-only review, not an application acceptance test or an independent security/legal audit. Source behavior, authentication, storage, build workflows, and GPL-3.0-only are outside the change scope. Nothing was staged, committed, or pushed during the review; publication is a separate, user-authorized step.

## User-facing structure

- `README.md` is English, `README.ja.md` is Japanese, and `README.zh-CN.md` is Simplified Chinese.
- Every README begins with the same language navigation and follows the same hero, three stages, screenshot, features, getting started/FAQ, privacy, limitations, support, and license/developer-documentation order.
- Each has eight feature bullets and five matching FAQ questions. Three localized source guides carry the same setup commands and operating/privacy caveats.
- Detailed security, validation, release, legal, and IPC documents remain linked, with their languages identified. Existing public document paths are retained.

## Facts that must remain visible

- Experimental source availability, not a verified ready-to-use release.
- No public release or Portable executable in the GitHub releases response checked on 2026-10-28.
- Optional financial support; the Sponsors URL redirected to the author's profile on that date. The link is provided without claiming contributions are accepted.
- Initial source-test results of 125 passes / 12 failures, including parent/subtest failures, about 576 seconds; the original validation report is preserved.
- Login state saved by default, temporary-profile cleanup limits, sensitive local data, and normal reader/browser/setup traffic.
- No DRM bypass does not establish legal permission, all-layout compatibility, whole-book capture, or legal clearance.

## Screenshot provenance and privacy

The author-supplied image is 1642 × 927 pixels. The published PNG is an exact **1082 × 844** crop at **x=0, y=82**, retaining the application heading, language selector, reader-tab selector, and all three main controls.

The browser tabs/address bar, adjacent Amazon promotional page and book covers, and desktop/weather area are outside the crop. The retained local connection address is loopback-only and contains no authentication token. No password, cookie, account identifier, book title, or book body is visible. The caption identifies a Japanese, sign-in-not-yet-verified screen; it is not evidence of a completed capture.

There is no redraw, compositing, invented screenshot, or external image host. The crop is re-encoded without source metadata. `.gitignore` permits only `docs/images/kindletozip-workflow.png`, not arbitrary screenshots or runtime data.

- Original SHA-256: `d879e798fcb65c8170ef670a9c06e3ed0eba142927d19b486d654b6835cf87d4`
- Crop SHA-256: `28c76dad6b3f9605b7015a9f0aa12dad0f19a3059242870f2ed89753b4f7aebe`

## Review status

The documentation-only automated check completed with **8 passed / 0 failed** in **10.27 seconds** command elapsed on 2026-10-28. Checks covered:

- Eight matching section headings, three stages, eight features, five FAQs, shared status/risk facts, and identical source setup commands across languages.
- **125 local links across 14 public Markdown documents**, with no missing targets or links to private artifacts.
- An exact pixel-by-pixel crop comparison, absence of source metadata, and the narrow image/document `.gitignore` exceptions.
- Current rendering of all 14 documents through the **GitHub Markdown API in GFM mode**.
- Headless browser display of all three READMEs at **1280 × 960** and **390 × 844**. All had a loaded screenshot, correct heading order, working language navigation and source-guide destinations, and no horizontal document overflow. The source entry link was visible in the first screen in every case.
- Unchanged hashes for the application, existing parallel source/test work, build configuration, license, and retained historical validation/legal documents. Nothing was staged or committed at that review checkpoint.

The crop and the six README desktop/phone top-of-page screenshots were also visually inspected. Preview pages use a locally stored GitHub-style stylesheet; this is not a claim that GitHub's entire website chrome was reproduced. No login, real reader, or app capture flow was launched for the documentation review.

The follow-up edit to this report is checked again for local links, rendering freshness, and preservation. Its text does not change the READMEs or the app, and the unchanged six browser cases are not rerun solely for this report update.

Local review helpers and rendered evidence are kept under ignored `artifacts/readme-review/`. They are not added to the app's build or test configuration. The unchanged broad application test suite is not rerun for this documentation-only change, and its recorded failures are not waived.

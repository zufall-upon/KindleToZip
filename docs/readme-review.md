# README and screenshot review

The original review below is retained as a historical checkpoint. The later **Visual-page follow-up** section records the subsequent README and image changes; statements about no app flow or no compositing in the original review describe that earlier checkpoint only.

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

## Visual-page follow-up — 2026-10-28

### Presentation and scope

- The three READMEs now share a benefit-first hero, three-stage walkthrough, one compact screenshot overview, five feature groups, source setup, visible risk notes, four FAQs, optional support, and documentation/license links.
- Compared with `9f95a73`, text length is reduced by **25.2% in English, 20.6% in Japanese, and 20.3% in Simplified Chinese**. Equivalent language navigation, destinations, release status, historical failures, default login retention, legal uncertainty, and GPL-3.0-only remain visible.
- A trilingual gallery keeps the three full screenshots and the original author-supplied Japanese screenshot. The original image and its provenance above are unchanged.
- Changes are limited to public documentation, the four reviewed new PNGs, and exact `.gitignore` exceptions. Parallel application, fixture, script, and test changes in the main working directory are not part of this publication. No executable release is built or published by this page update.

### New screenshot evidence

The application UI and capture/export code came from an isolated export of published commit **`9f95a73bf8a72c35ebd507180aee707364469b6d`**, with fresh npm dependencies and an isolated debug controller build. Only the local fixture's self-authored artwork was customized into two independent pages so that spread splitting does not cut a number or sentence. This does not change the main working directory's application or fixtures.

All **33 application, browser-adapter, and controller source files** in that copy were compared with the published commit, allowing only the Git archive's CRLF/LF conversion; there were no code differences in those files.

The public controls were used to prepare a job, open the local sample, select its reader tab and output mode, preview, explicitly approve, separately start, stop after three captures, explicitly keep images, reorder them to **2 → 1 → 3**, and export ZIP. The final screenshot run took **22.40 seconds**. The UI reported saved/read-back verified and six images; every exported PNG was independently decoded again at **600 × 960**.

- ZIP bytes: **594,983**. SHA-256: `034313dcf5c35b4813b998bacb6d496a875354469e30114a926e4d44917f9ffc`.
- Each full screenshot is **1280 × 1100**. Only the export destination input and its repeated path in the result text are masked. Messages, state, counts, and sample pixels are not replaced.
- The **1600 × 1100** overview is explicitly labeled a **combined montage**, not a single app screen. It contains resized crops from preview `(88, 0, 1104, 725)`, review `(88, 0, 1104, 740)`, and export `(88, 460, 600, 77)`, expressed as x, y, width, height. Headings and surrounding layout are editorial labels, not app controls.
- Images are re-encoded with only PNG `IHDR`, `IDAT`, and `IEND` chunks. No Amazon page, credentials, usual browser profile, real book, browser address bar, or desktop was used in these new screenshots.

| Published image | SHA-256 |
| --- | --- |
| `kindletozip-preview.png` | `bba12ee412c1164f95a09d88149a4dceff8eff7d60cec12384e8b34628b528f1` |
| `kindletozip-review.png` | `59a369212c5cbd50f783ffefd0fc09e9f4c5ef3c81abadcbb4763374ea05dade` |
| `kindletozip-export.png` | `aac6ced619e25cf263838088ca3b9899b656268debebba997e8fe02e05af7061` |
| `kindletozip-overview.png` | `1008a77b3b2de35c715851f6be0ab8b916c789bd75e7ffff6fc9e012ab436816` |

This is **one self-authored sample flow**, not real-Kindle, clean-Windows, packaged-app, complete-book, or release acceptance. It does not fix, invalidate, or replace the historical 125-pass / 12-fail report. Initial capture-helper mistakes (a positional selector choosing a disabled button and a click changing scroll position) were corrected in the helper only; they are not application fixes.

### Editorial and rendering checks

The logged-in ChatGPT conversation was used for direct editorial rounds: first the published page, then the actual three-language draft and overview, then the revised overview and full gallery assets. Its suggestions are editorial advice, not independent app, security, or legal validation. Applied feedback includes shorter equivalent READMEs, natural two-page sample content, larger actual export-result text, an explicit montage label, and a less ambiguous English feature heading.

Local documentation checks cover language/feature/FAQ parity, truthful status/risk references, **138 local links across 15 documents**, gallery anchors, exact image evidence and metadata, all six exported PNGs, narrow ignore rules, and exclusion of non-documentation files from staging. The new privacy scanner initially matched the ordinary word “frozen” and an existing generic IPC example path; those were scanner false positives, not public-data changes or application defects.

Changed Markdown is rendered through the GitHub Markdown API. All three READMEs are displayed at **1280 × 960** and **390 × 844**, including image loading, first-screen source links, no horizontal overflow, working language/source navigation, and the full-size gallery. The standalone preview normalizes the API's `user-content-` ID prefix for native hash navigation; the actual GitHub anchor behavior is a separate publication check. Preview styling is local GitHub-style CSS, not GitHub's entire website chrome.

New helpers and evidence remain under ignored `artifacts/github-page-polish/`. The broad app suite is not rerun for this documentation-only update. No tests are removed or waived to represent the application as passing.

The final documentation run completed with **7 passed / 0 failed in 5.95 seconds** command elapsed. The three-language layouts and full-size gallery were visually inspected. Subsequent edits to this record receive targeted link/render/staging checks rather than repeating unchanged browser cases. The final editorial round requested the exact image allowlist and an updated historical-review boundary; both are included in this change.

## Author-recorded animation — 2026-10-28

The author subsequently supplied `c.mp4`: **1920 × 1080**, **19.392 seconds**, **2,564,418 bytes**, SHA-256 `481fdaa48ae5bf41fbb3b5c888f1f8156f96587b369cdf73a609001ad6869f63`. It shows Japanese UI and self-authored sample content. Its source/build revision is **unverified** and must not be attributed to the isolated `9f95a73` screenshot run above.

The original recording is neither uploaded to ChatGPT nor published. A local, isolated Microsoft Edge decoder extracts reviewed PNG frames. Browser chrome, black margins, native save-dialog scenes, later reset operations, and wallpaper are omitted. The retained application crop is `(410, 106, 1180, 910)`. Local paths are covered with opaque masks at source rectangles `(448, 183, 1088, 46)` and `(450, 544, 1100, 31)` when the app UI is shown. An editorial footer identifies the sample, Japanese UI, editing, path masks, and absence of audio. UI messages and counts are not redrawn.

Only **37 safe PNGs and their timing manifest**, packaged into two ZIPs, are sent to the existing logged-in ChatGPT conversation. ChatGPT actually generates the GIF, which is downloaded and independently checked locally; this is not merely a suggested conversion command. One pair of identical frames is combined. The first frame holds for one second and the last for 2.5 seconds; other delays alternate 120/130 ms to represent the requested 8 fps within GIF's 10 ms timing units.

- Published asset: `docs/images/kindletozip-demo.gif`.
- **800 × 672**, **36 frames**, **7.870 seconds**, **559,666 bytes**, infinite loop, no audio.
- SHA-256: `837c414fc2f2694c4ba08e8742969aa31e6ff8c4154310e7aafbf84cbb12e94c`.
- Every GIF frame is independently decompressed and composited, then compared against the reviewed PNGs in source order. The sampled mean absolute RGB error remains below **3 / 255** after palette reduction. The opaque path-mask regions are checked in every applicable decoded frame, and the final saved/read-back-verified screen still reports 12 images.

All three READMEs keep the static overview and add an initially collapsed, localized `details`/`summary` control for the GIF. Captions identify edited, silent Japanese-UI sample footage and its limits. The gallery separates this recording from the older verified-source stills and links to non-animated alternatives. `.gitignore` permits this exact GIF only, not arbitrary media. No application, dependency, build, authentication, or storage configuration changes are included; helpers and intermediate media remain ignored under `artifacts/readme-animation/`, and the supplied original stays outside the repository.

The animation documentation check completed with **6 passed / 0 failed in 7.33 seconds** command elapsed: full GIF decoding/compositing, frame order and masks, localized captions/destinations, **154 local links and anchors across 15 documents**, preservation of existing assets/license/risk documents, exact allowlisting, and fresh GitHub Markdown rendering. Browser cases cover all three languages at **1280 × 960** and **390 × 844**, initially collapsed GIFs, opening/closing the control, loaded animation, no horizontal overflow, visible source links, and navigation to the recording and still-image alternatives. The layouts and decoded final frame were also visually inspected. This does not rerun or waive the broad application suite.

### Subsequent English top-of-page placement

At the author's request, the English README now shows the same GIF directly in its opening section, without a collapsed control, and links to the larger gallery version. It was initially displayed at 400 px and then adjusted to **340 px wide** so the new badges and the full GIF still fit the first phone-size README screen. The Japanese and Simplified Chinese placements are unchanged. The all-collapsed layout described above is the earlier animation-publication checkpoint. The GIF bytes, editing, masks, source status, and app code are unchanged.

### Product and activity badges

All three READMEs add matching GPL-3.0-only, Windows x64, three-language UI, experimental status, source-check workflow, GitHub stars, and last-commit badges. The workflow badge reports the real latest `main` run of `ci.yml`; it is not a hard-coded passing badge or a claim that the current release was accepted. Activity counts and timestamps are live repository metadata, not completeness or quality guarantees. No download, release-ready, or security-audit badge is added. Badges use Shields.io images and link to their relevant license, guide, gallery, validation report, workflow, or repository page. The English GIF remains directly visible above the activity badges.

### Optional Ko-fi support

The author requested `ko_fi: zufallupon` in `.github/FUNDING.yml`; the existing `github: zufall-upon` entry is retained. All three READMEs add matching optional-support text and a Ko-fi badge linking to `https://ko-fi.com/zufallupon`, for eight badges in total. The public Ko-fi page identifies the creator as `zufall-upon`. No payment is made or tested, no paid feature is introduced, and the separate GitHub Sponsors availability caveat remains explicitly scoped to GitHub Sponsors.

The focused badge/support check completed with **3 passed / 0 failed in 3.33 seconds** command elapsed. All eight badge endpoints returned valid SVGs; the source-check badge's failing state matched the observed completed public workflow run. Fresh GitHub Markdown rendering and all three languages at desktop/phone sizes were checked, including badge wrapping, optional-support links, no horizontal overflow, and the full English GIF remaining in the first README screen. Layout previews use the just-fetched badge SVGs, not invented status images. Existing GIF bytes and other application behavior are unchanged.

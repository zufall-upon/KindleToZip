# Store adapters and Kindle regions (v0.1.6)

## Current boundary

Kindle remains the **only supported store**. BOOK☆WALKER, ebookjapan and コミックシーモア are future candidates, in that order, not implemented integrations. No corresponding public store selector, login, network probe or acquisition is added. The user's attached comparison is planning input, not independently verified service dates, permissions or terms.

`app/stores/index.mjs` constructs a fixed adapter for each dedicated reader. Its public factory rejects unknown stores. The internal self-authored sample adapter is not another supported service. `app/stores/kindle.mjs` owns:

- explicit regional entrypoints and exact-origin target classification;
- library/reading-tab distinction and Kindle-specific preset/chrome semantics;
- visible book/position interpretation (`identify`), retaining the established origin + visible-title identity hash;
- one page-turn dispatch (`turnPage`), with no adapter-level retry;
- preview-only chrome recovery and store-specific marker validation.

`app/reader.mjs` retains shared visible-area geometry, generic visible DOM selection, authentication/overlay rejection, stable target checks, screenshots, capture quality, bound-node/geometry checks, cancellation, turn-dispatch journaling and post-turn confirmation. Adapters cannot authorize a click without these checks. The existing `Application`/Rust store pipeline continues to own original images, review, automatic/manual crop, per-image splitting/order and ZIP/CBZ output. No job schema or stored-image identity migration is introduced. Authentication, URLs and book contents are not added to the tab list.

This is an extension seam, not a universal reader implementation. A later adapter must establish its own visible identity/position contract, reading-tab detection, supported layouts and navigation semantics; it must not assume Kindle's selectors work elsewhere. Shared generic DOM heuristics may also need explicit store-specific constraints then.

## Explicit Kindle regions

| Selection (independent of UI language) | Entrypoint and permitted reading origin | Official observation on 2026-10-29 |
| --- | --- | --- |
| Japan (`jp`, initial default) | `https://read.amazon.co.jp/` | [Official landing page](https://read.amazon.co.jp/landing) says “Read on read.amazon.co.jp”; official root is indexed as Kindle Cloud Reader / Amazon sign-in. |
| United States (`us`) | `https://read.amazon.com/` | [Official landing page](https://read.amazon.com/landing) says “Read on read.amazon.com” and “Kindle Cloud Reader is now known as Kindle for Web.” |
| United Kingdom (`uk`) | `https://read.amazon.co.uk/` | [Official landing page](https://read.amazon.co.uk/landing) says “Read on read.amazon.co.uk”; [Amazon UK help](https://www.amazon.co.uk/gp/help/customer/display.html?nodeId=GCQEMKHLBENNKWU2) describes Kindle for Web. |

These official pages were observed via current search-index excerpts. Direct unauthenticated HTTP fetches of all three roots returned **503** in this environment; no account was used to bypass that response. This establishes official destination identities, **not successful current regional book capture**. Unknown regions are omitted rather than inferred from a TLD or UI language. Chinese UI does not imply support for a China Kindle service.

The same immutable adapter policy governs launch, candidate tabs, explicit selection, picker and all reads before/after screenshot or page turn. Only the selected HTTPS origin is eligible; userinfo, non-default ports, trailing-dot hosts, suffix lookalikes, all other regions and arbitrary Amazon subdomains are rejected. Explicit HTTPS port 443 is the same canonical origin. Library pages can appear in the list but cannot become a captured reader. Authentication pages, absent/ambiguous visible markers and changed book/target require attention; they are never capture approval.

This is a **target rule**, not a browser-wide request allowlist. The official browser retains its normal authentication/rendering/CDN requests as before. Authentication hosts are not reading targets. There is no hidden API or authentication bypass.

Select the region before opening the dedicated browser. The selection is per application run (initially Japan), not inferred from UI language, saved cookies or job history. To change it, safely stop and close that browser, choose another region, select the target tab, preview and approve again, then start separately. The backend also refuses an open-browser region change. Navigating to another regional origin during acquisition invalidates the target rather than following it. Existing captures remain available for review/export.

## Future integration work (not performed now)

For **each** of BOOK☆WALKER, ebookjapan and コミックシーモア:

1. Reassess that service's current terms, automated operation conditions, reproduction/copying rights and distribution restrictions. An app architecture or lack of DRM circumvention is not permission.
2. Obtain explicitly authorized, non-private test material and an approved test method. Do not transplant the user's book screenshots into public fixtures.
3. Verify official entrypoints and visible reader/tab, book and position identities; define a conservative adapter and safe-stop behavior for authentication, target changes, ambiguity and failed turns.
4. Exercise background capture, shared review/crop/split, archive image bytes/order and packaged public selection using those permitted samples before advertising support.

No legal audit, service compatibility, credentials, live login or book acquisition for these candidates is claimed. The existing automatic-crop work is retained; future-store plans do not imply implemented support. v0.1.6 was separately authorized and released through the standard routine; published v0.1.4, its assets and all earlier tags remain unchanged.

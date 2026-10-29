# Public builds and release verification

## What is automated

- `ci.yml` tests the published source on Windows for pushes to `main` and pull requests. It does not publish executable assets.
- `release.yml` is **manual only** and only runs from this repository's `main` branch. It requires an existing version tag pointing to the exact workflow commit. It does not create a tag or silently build a different revision.
- The build job has read-only repository permissions. It installs pinned dependencies, tests Rust and the public source UI, builds the portable package, and runs the packaged public selection/export regression with self-authored fixtures.
- A separate job verifies checksums, creates GitHub artifact attestations, and prepares a **draft** release. Only that job has release-writing and attestation permissions. Third-party actions are pinned to commit SHAs.
- The archive contains the executable, project license and README, build metadata, and collected third-party notices. Collection is not a legal determination that every redistribution obligation has been met.

There is no claim of bit-for-bit reproducible builds, independent security review, or legal clearance. The successful hosted release run below establishes the recorded fixture and package checks. The user's later confirmation of clean-Windows operation and complete real-book capture is recorded separately, not attributed to the hosted tests.

## Current public release

[v0.1.6 for Windows x64](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.1.6) was published on **2026-10-29** from `50bde1f1561eb40b19022097b6ca5f61fc3cda59`, after Draft verification, exact-source CI **40847394795** and tagged release **40857160980**. It is a normal Release + **Latest**, titled **v0.1.6**. Public anonymous downloads matched the verified Draft; ZIP/EXE provenance, allowlisted contents and notices passed. The actual TOP-right Releases pane was checked. This adds explicit automatic-margin comparison/application and language-independent Japan/US/UK selection; other stores remain future plans. [The v0.1.6 record](validation.md#v016-public-release--2026-10-29) separates the user's unspecified local confirmation, saved local evidence, hosted fixture checks and byte-specific public verification. No all-region/all-book/clean-Windows/legal/independent-security success is inferred. The hosted EXE was deployed to `_testenv` only after backing up the retained local candidate, without touching user data or forcibly stopping an application.

### Previous public release v0.1.4 (preserved)

[v0.1.4 for Windows x64](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.1.4) was published on **2026-10-29** from `b9cd7164813a6850c7bcf7671673aa8bea46d5c2`, after Draft verification, exact-source CI **40818426954** and tagged release **40819770601**. It is a normal Release + **Latest**, titled **v0.1.4**, verified in the actual TOP-right Releases pane. Public anonymous downloads matched the Draft hashes; ZIP/EXE provenance and notices were checked. See [the v0.1.4 record](validation.md#v014-public-release--2026-10-29). The v0.1.3 tag remains after its notice-collection failure and is not moved; no executable release was created for it. The local user-confirmed candidate and the hosted EXE are different builds. The user's earlier clean-Windows/whole-book report applies to v0.1.2, not this new hosted EXE.

### Previous public release (preserved)

[v0.1.2 for Windows x64](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.1.2) was published on **2026-10-28** from `e3e3977588d75fffb72dae9f402288ca69f8bfe0`. Its exact source CI, tagged package gates, checksums, and GitHub build provenance passed. The public ZIP was downloaded without authentication and matched the verified draft. At the user's explicit request, it is a normal GitHub Release marked **Latest** in the TOP-right **Releases** pane, titled **v0.1.2**. On **2026-10-29**, the user confirmed clean-Windows operation and complete real-book capture and requested removal of the experimental label. This metadata/documentation change does not replace the tag or assets. See [the final public validation record](validation.md#v012-public-release--2026-10-28) and the [Portable quick start](portable.md). The earlier `v0.1.0` / `v0.1.1` tags have no executable release assets and are not replaced.

## Maintainer routine: freeze, draft, verify, publish

Treat a release request as a bounded handoff, not a new improvement project. Group the related final fixes, reuse passed checks for the unchanged candidate, and stop adding tests or features once the required evidence and public deliverable agree.

### 1. Freeze the accepted local candidate

- Record version, executable SHA-256, build report, saved packaged-UI evidence, and the exact source files included in the EXE. Inspect the Git diff and staging list; do not blindly commit unrelated work.
- Reuse existing native test results. A read-only hash/source/evidence comparison is not another app run. Do not rebuild, repeat broad tests, restart the reader, re-open real books, or repeat cleanup merely to obtain a fresh-looking timestamp.
- If code or the executable differs, refresh only the affected evidence. Never relabel an older result as a pass for different bytes.
- Exclude profiles, runtime/data/temp folders, captured pages, private records, and original recordings. Do not delete them or forcibly stop an app as part of release preparation.

For the accepted 2026-10-28 retained-image-resume candidate, the existing read-only collector is:

```powershell
node scripts/check-resume-delivery.mjs artifacts/releases/build-20261028-080646-046e7c08/KindleToZip-Portable.json artifacts/indicator-review/p1028171110
```

Those paths describe this local historical evidence, not files a fresh clone should contain or a command to replay every release. Keep a new release's own report/evidence paths in its local handoff record.

### 2. Commit the release source and version tag

- Preserve author and committer `zufall-upon`. Commit the reviewed final source, required tests/helpers, and release documentation; keep unrelated local work out of staging.
- The tag must match `package.json` (`v0.1.6` for `0.1.5`). Record the complete source commit. An existing tag or release is not overwritten or deleted to make a retry work. Earlier `v0.1.0`, `v0.1.1` and `v0.1.3` tags are retained after failed preparation; none has a published executable.
- Push the source first and require successful source CI for that exact commit before creating its annotated tag. Never call a failing or unrelated run green.

```powershell
$tag = 'v0.1.6'
$source = (git rev-parse HEAD).Trim()
git push origin HEAD:main
gh run list --workflow ci.yml --commit $source --limit 1
gh run watch <source-ci-run-id> --exit-status
# Only after the exact source CI succeeds:
git tag -a $tag $source -m "KindleToZip $tag"
git push origin $tag
```

After a hosted packaging blocker, validate the packaging path **before creating another tag** with the manual **Tag-free package preflight** workflow (`package-preflight.yml`). It starts without `_testenv`, builds the package, runs the packaged public selection/export regression, collects notices through the same `scripts/package-release.ps1` used by the release workflow, and verifies transferred ZIP/EXE checksums on Linux. It creates no tag, attestation, draft, or public release and does not repeat the unchanged source UI/Rust/deployment suites as diagnostics.

For this bounded repair, push the candidate with `[skip ci]` only to avoid launching a broad diagnostic trial. After package preflight succeeds, explicitly dispatch the existing `ci.yml` on the **same unchanged commit**, verify its exact `headSha` and all required steps, and only then tag it. The manual source CI is mandatory; a skipped push run or a passing preflight is never source acceptance. The final tagged release workflow still runs every existing mandatory gate.

### 3. Run the existing mandatory release workflow once

In Actions, select **Draft Windows release**, choose `main`, and enter the existing tag. Or use an authenticated GitHub CLI:

```powershell
gh workflow run release.yml --ref main -f "tag=$tag"
gh run list --workflow release.yml --commit $source --limit 1
gh run watch <run-id> --exit-status
```

The hosted workflow builds a **new** executable and runs its mandatory Rust, source UI, deployment, and packaged selection/export gates. These gates are not removed to reuse local evidence, and its executable hash need not equal the locally accepted build. Do not manually repeat already-passed local suites alongside it. On a failure, inspect that step and fix the smallest actual blocker; do not dispatch repeated full runs without a cause.

The ZIP uses the trilingual [Portable guide](portable.md) as its root `README.md`, rather than the source-setup overview. No development environment is required to use the bundled executable.

If a hosted failure is isolated to native save-dialog automation, use the manual **Native save dialog diagnostics** workflow (`native-dialog-diagnostics.yml`) to inspect that symptom without repeating the broad suites. It runs only owned Windows dialogs with anonymous paths, without dependencies, a reader, or credentials. Its success is diagnostic evidence only: it cannot replace successful `ci.yml` for the final release commit or any `release.yml` gate. Intermediate diagnostic-only commits are not release candidates.

### 4. Verify the draft's actual assets

- Require successful source CI for the frozen commit and a successful release workflow. Match the tag, workflow commit, build metadata, provenance, checksum list, ZIP, and EXE. The draft is not proof of success by itself.
- Read back the actual transferred archive and verify its hashes and attestation. Check the allowlisted contents, license/notices, and absence of private user data. Reuse the workflow's packaged public selection/export result; do not re-run unchanged acceptance without a specific gap.
- Keep clean-Windows, current Kindle layout, whole-book acquisition, legal clearance, and third-party redistribution review distinct from fixture success. Record any unverified item honestly. A stable-ready claim requires its applicable acceptance; an explicitly authorized experimental public prerelease must state the remaining limits instead of marking them passed.

### 5. Publish only the authorized scope

The workflow creates a **draft**, never a public release automatically. Publish only when the user explicitly requests general availability. GitHub cannot mark prereleases as Latest. For `v0.1.2`, the user explicitly chose a normal Release + Latest for the actual repository Releases sidebar, then requested removal of the experimental label after reporting successful clean-Windows and complete real-book checks. Keep the title **v0.1.2**, the normal Release + Latest classification, and the remaining compatibility/privacy/legal notices; do not silently restore the old label or substitute a README/About link for the requested widget.

Subsequent standard-routine requests carry that normal Release + Latest policy forward to **v0.1.4** and **v0.1.6**, titled by their version. Keep v0.1.2's historical assets/metadata unchanged and record the distinct scope of the new local confirmation rather than attributing the old manual checks to the new EXE.

```powershell
gh release edit $tag --draft=false --prerelease=false --latest=true --title "$tag" --notes-file <reviewed-release-notes.md>
```

Review [security disclosures](security-and-trust.md), [legal questions](legal-notes-ja.md), and the bundled third-party notices/source obligations when preparing the notes. Do not claim an independent audit or legal clearance. Existing releases/assets are never silently replaced.

### 6. Update the public entry points and stop

- Check the public release URL and download names, then verify a public asset against its published checksum. Retain version, source commit, run URLs, asset hashes, and publication result in the handoff record.
- After publication succeeds, update English/Japanese/Simplified Chinese availability text and Portable/source entry links. Keep the historical initial validation report and distinguish it from current CI/results.
- Keep project release instructions in this document and the local `AGENTS.md` work memo. In an interrupted run, inspect the existing tag, run, and release first; do not start over, create another candidate, or overwrite a completed release.

GitHub Actions artifacts are uploaded to GitHub and are not private storage, even when a release is a draft. The release workflow is not run as part of initial source publication.

## Verify a downloaded release

Only use release assets from [zufall-upon/KindleToZip](https://github.com/zufall-upon/KindleToZip/releases). Download the ZIP and `SHA256SUMS.txt` from the same release.

```powershell
Get-FileHash .\KindleToZip-Portable-v0.1.6-win-x64.zip -Algorithm SHA256
gh attestation verify .\KindleToZip-Portable-v0.1.6-win-x64.zip --repo zufall-upon/KindleToZip --signer-workflow zufall-upon/KindleToZip/.github/workflows/release.yml
```

Compare the hash with the matching line in `SHA256SUMS.txt`. The attestation verification must succeed, and its source commit, repository, and workflow must match the release you intend to use. The detached `.sigstore.json` bundle is also attached for inspection and offline-verification workflows; consult the current GitHub CLI documentation before relying on offline verification.

Extract the ZIP into a writable Windows folder and keep its license/notice files. On first launch the executable creates `runtime/`, `data/`, and `temp/` beside itself. These are private user data, not release assets. Provenance authenticates a build origin; it does not make the source harmless or prove contractual/legal compliance.

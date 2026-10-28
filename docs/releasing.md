# Public builds and release verification

## What is automated

- `ci.yml` tests the published source on Windows for pushes to `main` and pull requests. It does not publish executable assets.
- `release.yml` is **manual only** and only runs from this repository's `main` branch. It requires an existing version tag pointing to the exact workflow commit. It does not create a tag or silently build a different revision.
- The build job has read-only repository permissions. It installs pinned dependencies, tests Rust and the public source UI, builds the portable package, and runs the packaged public selection/export regression with self-authored fixtures.
- A separate job verifies checksums, creates GitHub artifact attestations, and prepares a **draft** release. Only that job has release-writing and attestation permissions. Third-party actions are pinned to commit SHAs.
- The archive contains the executable, project license and README, build metadata, and collected third-party notices. Collection is not a legal determination that every redistribution obligation has been met.

There is no claim of bit-for-bit reproducible builds, independent security review, clean-Windows acceptance, real-Kindle acceptance, or legal clearance. Until the first successful workflow run, the workflow itself remains unverified on GitHub-hosted runners.

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
- The tag must match `package.json` (`v0.1.0` for `0.1.0`). Record the complete source commit. An existing tag or release is not overwritten or deleted to make a retry work.
- Push the source and its annotated tag. Source CI is associated with that exact commit, not merely the most recent badge value. Never call a failing or unrelated run green.

```powershell
$tag = 'v0.1.0'
$source = (git rev-parse HEAD).Trim()
git tag -a $tag $source -m "KindleToZip $tag"
git push origin HEAD:main
git push origin $tag
```

### 3. Run the existing mandatory release workflow once

In Actions, select **Draft Windows release**, choose `main`, and enter the existing tag. Or use an authenticated GitHub CLI:

```powershell
gh workflow run release.yml --ref main -f "tag=$tag"
gh run list --workflow release.yml --commit $source --limit 1
gh run watch <run-id> --exit-status
```

The hosted workflow builds a **new** executable and runs its mandatory Rust, source UI, deployment, and packaged selection/export gates. These gates are not removed to reuse local evidence, and its executable hash need not equal the locally accepted build. Do not manually repeat already-passed local suites alongside it. On a failure, inspect that step and fix the smallest actual blocker; do not dispatch repeated full runs without a cause.

The ZIP uses the trilingual [Portable guide](portable.md) as its root `README.md`, rather than the source-setup overview. No development environment is required to use the bundled executable.

### 4. Verify the draft's actual assets

- Require successful source CI for the frozen commit and a successful release workflow. Match the tag, workflow commit, build metadata, provenance, checksum list, ZIP, and EXE. The draft is not proof of success by itself.
- Read back the actual transferred archive and verify its hashes and attestation. Check the allowlisted contents, license/notices, and absence of private user data. Reuse the workflow's packaged public selection/export result; do not re-run unchanged acceptance without a specific gap.
- Keep clean-Windows, current Kindle layout, whole-book acquisition, legal clearance, and third-party redistribution review distinct from fixture success. Record any unverified item honestly. A stable-ready claim requires its applicable acceptance; an explicitly authorized experimental public prerelease must state the remaining limits instead of marking them passed.

### 5. Publish only the authorized scope

The workflow creates a **draft**, never a public release automatically. Publish only when the user explicitly requests general availability. The first public `v0.1.0` is an experimental prerelease, not a stable/clean-Windows or complete-book certification.

```powershell
gh release edit $tag --draft=false --prerelease --latest=false --notes-file <reviewed-release-notes.md>
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
Get-FileHash .\KindleToZip-Portable-v0.1.0-win-x64.zip -Algorithm SHA256
gh attestation verify .\KindleToZip-Portable-v0.1.0-win-x64.zip --repo zufall-upon/KindleToZip --signer-workflow zufall-upon/KindleToZip/.github/workflows/release.yml
```

Compare the hash with the matching line in `SHA256SUMS.txt`. The attestation verification must succeed, and its source commit, repository, and workflow must match the release you intend to use. The detached `.sigstore.json` bundle is also attached for inspection and offline-verification workflows; consult the current GitHub CLI documentation before relying on offline verification.

Extract the ZIP into a writable Windows folder and keep its license/notice files. On first launch the executable creates `runtime/`, `data/`, and `temp/` beside itself. These are private user data, not release assets. Provenance authenticates a build origin; it does not make the source harmless or prove contractual/legal compliance.

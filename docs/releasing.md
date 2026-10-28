# Public builds and release verification

## What is automated

- `ci.yml` tests the published source on Windows for pushes to `main` and pull requests. It does not publish executable assets.
- `release.yml` is **manual only** and only runs from this repository's `main` branch. It requires an existing version tag pointing to the exact workflow commit. It does not create a tag or silently build a different revision.
- The build job has read-only repository permissions. It installs pinned dependencies, tests Rust and the public source UI, builds the portable package, and runs the packaged public selection/export regression with self-authored fixtures.
- A separate job verifies checksums, creates GitHub artifact attestations, and prepares a **draft** release. Only that job has release-writing and attestation permissions. Third-party actions are pinned to commit SHAs.
- The archive contains the executable, project license and README, build metadata, and collected third-party notices. Collection is not a legal determination that every redistribution obligation has been met.

There is no claim of bit-for-bit reproducible builds, independent security review, clean-Windows acceptance, real-Kindle acceptance, or legal clearance. Until the first successful workflow run, the workflow itself remains unverified on GitHub-hosted runners.

## Maintainer procedure

1. Review [security and network disclosures](security-and-trust.md), [legal questions](legal-notes-ja.md), third-party license/notice/corresponding-source obligations, and the exact source revision. Do not put authentication state or real book content into CI.
2. After source CI succeeds, create and push a version tag such as `v0.1.0` for the current `main` commit. The tag version must match `package.json`.
3. In Actions, select **Draft Windows release**, select `main`, and enter that tag. Use no Amazon credentials or repository secrets; the workflow uses the short-lived GitHub token only.
4. Check the complete build and packaged-test logs, checksums, provenance, build metadata, and bundled license notices. Check the package on a clean Windows PC. A fixture test is not acceptance of every Kindle layout.
5. Review the draft's known limitations and outstanding legal questions before deciding whether to make it public. The workflow never publishes the draft automatically. Rerunning against an existing release fails instead of replacing its assets.

GitHub Actions artifacts are uploaded to GitHub and are not private storage, even when a release is a draft. The release workflow is not run as part of initial source publication.

## Verify a downloaded release

Only use release assets from [zufall-upon/KindleToZip](https://github.com/zufall-upon/KindleToZip/releases). Download the ZIP and `SHA256SUMS.txt` from the same release.

```powershell
Get-FileHash .\KindleToZip-Portable-v0.1.0-win-x64.zip -Algorithm SHA256
gh attestation verify .\KindleToZip-Portable-v0.1.0-win-x64.zip --repo zufall-upon/KindleToZip --signer-workflow zufall-upon/KindleToZip/.github/workflows/release.yml
```

Compare the hash with the matching line in `SHA256SUMS.txt`. The attestation verification must succeed, and its source commit, repository, and workflow must match the release you intend to use. The detached `.sigstore.json` bundle is also attached for inspection and offline-verification workflows; consult the current GitHub CLI documentation before relying on offline verification.

Extract the ZIP into a writable Windows folder and keep its license/notice files. On first launch the executable creates `runtime/`, `data/`, and `temp/` beside itself. These are private user data, not release assets. Provenance authenticates a build origin; it does not make the source harmless or prove contractual/legal compliance.

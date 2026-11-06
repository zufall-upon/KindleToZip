# Documentation

## Start here

- Product overview: [English](../README.md) · [日本語](../README.ja.md) · [简体中文](../README.zh-CN.md)
- Run from source: [English](getting-started.md) · [日本語](getting-started.ja.md) · [简体中文](getting-started.zh-CN.md)
- [Portable quick start / Portable版の使い方 / Portable 使用指南](portable.md) — current instructions; the release ZIP retains the guide frozen at its source tag
- [Actual app screenshots / 実画面 / 实际界面](screenshots.md) — preview, image review, ZIP export, and the original Japanese UI

[v0.2.3 — Windows x64 and Ubuntu x64 Portable](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.2.3) is publicly available as a normal Release + Latest. Both platforms' mandatory source/package gates, actual metadata/checksums/provenance, anonymous downloads and the Releases sidebar were verified. Start with the [Windows Portable guide](portable.md) or [Ubuntu guide](ubuntu-portable.ja.md); source guides remain for development. The 161-image Ubuntu development result and historical clean-Windows report remain separate from these new packages' fixture checks in the [validation record](validation.md).

## Details and implementation records

- [Development and testing](development.md) — English; fixed tool versions, test commands, and portable build steps
- [Authentication, network traffic, and trust](security-and-trust.md) — English; cookies, profiles, external communication, and reporting boundaries
- [Validation history and release evidence](validation.md) — English; historical failures, later passing checks, exact public hashes, and remaining limits
- [Public builds and release verification](releasing.md) — English; manual draft releases, SHA-256, and artifact attestations
- [Legal questions and review limits](legal-notes-ja.md) — Japanese; unresolved Amazon terms and copyright questions
- [Rust JSONL IPC contract](09-mvp-ipc-ja.md) — Japanese; local storage, recovery, and archive protocol
- [README and screenshot review](readme-review.md) — English; documentation parity, screenshot privacy, and rendering checks

Detailed technical documents retain their stated languages. The three product READMEs and three source setup guides provide equivalent user-facing information in their respective languages. No document is a substitute for an independent security audit or legal advice.

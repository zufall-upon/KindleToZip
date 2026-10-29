[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# KindleToZip

[![ライセンス：GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-2563eb?style=flat-square)](LICENSE) [![対象環境：Windows x64](https://img.shields.io/badge/Windows-x64-0078d4?style=flat-square)](docs/getting-started.ja.md) [![UI：英語・日本語・簡体字中国語](https://img.shields.io/badge/UI-EN%20%7C%20JA%20%7C%20ZH--CN-8b5cf6?style=flat-square)](docs/screenshots.md)

**取得して、整えて、アーカイブ。**

WindowsでKindle Webの表示画面をPNG／JPEG画像として取得。点検・見開き分割・並べ替えをして、順序付きの **ZIP / CBZ** に保存できます。

**スクショ取得はバックグラウンドで。待ち時間も、ほかの作業に。**

**完全無料・オープンソース · Windows x64 · 独自アカウント登録不要 · 有料DLCなし**

> **Windows x64用Portable v0.1.6を公開しています。**
> 必須のソース検査・配布版の自作試料検査は成功済みです。利用者は今回のローカルcrop・地域選択候補を確認済みですが、確認範囲の詳細は不明です。従来のクリーンWindows・全冊取得報告はv0.1.2に対するもので、このホスト版EXEの結果ではありません。

**[Portable ZIPをダウンロード](https://github.com/zufall-upon/KindleToZip/releases/download/v0.1.6/KindleToZip-Portable-v0.1.6-win-x64.zip)** · [Portable版の使い方](docs/portable.md) · [ソースから試す](docs/getting-started.ja.md)

[![公開状況：リリース済み](https://img.shields.io/badge/status-released-16a34a?style=flat-square)](docs/validation.md) [![mainブランチの最新ソース検査](https://img.shields.io/github/actions/workflow/status/zufall-upon/KindleToZip/ci.yml?branch=main&style=flat-square&label=source%20checks)](https://github.com/zufall-upon/KindleToZip/actions/workflows/ci.yml) [![GitHubスター数](https://img.shields.io/github/stars/zufall-upon/KindleToZip?style=flat-square&label=stars)](https://github.com/zufall-upon/KindleToZip/stargazers) [![リポジトリの最終コミット](https://img.shields.io/github/last-commit/zufall-upon/KindleToZip?style=flat-square)](https://github.com/zufall-upon/KindleToZip/commits/main/)

## 作ったきっかけ

以前使っていた方法でKindleの本をZIP化できなくなったことが、開発のきっかけです。そこで、電子書籍ファイルを復号するのではなく、Kindle Webに表示されたページをスクリーンショットで取得するツールを作りました。

取得中は専用の読書ウィンドウを前面に出し続ける必要がなく、別のアプリで作業できます。待ち時間をほかの作業に使い、取得後に画像を確認・整理してアーカイブへ保存する、という使い方を目指しています。

## 読書画面からアーカイブまで

1. **開く。** 専用ブラウザのKindle公式画面でログインし、1冊を開いて読書タブを選びます。
2. **取得する。** 領域を選んでプレビューを点検。承認した後、別の操作で取得を開始します。
3. **点検して保存。** 停止後に画像を確認し、分割・順序・クロップを調整してZIP / CBZへ出力します。

**バックグラウンド取得の条件：** 専用の読書ウィンドウは開いたまま最小化せず、PCをスリープ・画面ロックしないでください。最小化・ロック・スリープ中の継続は保証しません。取得前のプレビュー・承認と、取得後の範囲・ページ順の点検は必要です。

[![KindleToZipの実画面：分割プレビュー、3枚の並べ替え後の点検、6画像のZIP保存・再読検証成功](docs/images/kindletozip-overview.png)](docs/screenshots.md)

*自作サンプルを使った英語UIの実画面です。切り出しを組み合わせた画像で、モックアップではありません。ローカル保存先はマスク済み。この成功は実書籍の取得や配布版の動作保証ではありません。*

**原寸で見る：** [プレビュー](docs/screenshots.md#preview) · [点検・見開き分割](docs/screenshots.md#review) · [ZIP保存](docs/screenshots.md#export) · [日本語UI](docs/screenshots.md#japanese-ui)

<details>
<summary>短い操作GIFを見る（日本語UI・約8秒）</summary>

![作者撮影の自作サンプル動画：日本語UIで画像を点検してZIPを保存](docs/images/kindletozip-demo.gif)

*無音の編集済みサンプル動画です。保存ダイアログを省略し、ローカルパスをマスクしています。実書籍や配布版の動作検証ではありません。[録画の説明・動かない画像で見る](docs/screenshots.md#animation)。*

</details>

## 撮った画像を、使いやすく

以下はPortable版とソースに含まれる機能です。後述の検証範囲・制約があります。

- **取得前に確認。** 専用ブラウザのプロファイル、領域指定、プレビュー、明示承認と、それとは別の開始操作。
- **分割・並べ替え。** 左右ページへの見開き分割、読み方向の選択、取得画像の順序調整。
- **原本を残して編集。** 採用・除外、非破壊クロップに対応。停止後も確定保存された画像を再取得せず点検できます。
- **順序付きのアーカイブ。** 採用したPNG／JPEGをZIP / CBZへ保存。既存ファイルは上書きしません。
- **3言語から選択。** 日本語・英語・簡体字中国語のUI。

**v0.1.4の追加機能：** 取得形式にPNGまたはJPEGを選び、JPEG画質を1〜100で指定できます。JPEGは取得時に非可逆圧縮され、クロップ・分割でも再圧縮されます。画像点検では各画像を1枚／左右2枚に修正し、読み順も選べます。余白は手動クロップし、原本へ戻せます。自動判定は誤ることがあり、必ず目視で確認してください。選択済みの小さな次へボタンが領域に重なる場合、撮影中だけ非表示にする対策はありますが、すべての写り込みを取り除ける保証はありません。

**v0.1.6の追加機能：** 点検画面で画像を選び「選択画像の余白を検出」を押すと、連続した白・黒の端余白の候補を原本と比較できます。候補の表示や取消だけでは保存状態は変わりません。本文・枠・ページ番号を確認したうえで明示的に適用し、必要なら手動クロップや「全原寸へ戻す」を使えます。内容を認識する機能ではなく、安全な候補が見つからない場合もあります。JPEGの適用時は取得時の画質で再圧縮され、原本は保持されます。

v0.1.6では、専用ブラウザを開く前に **「Kindle利用地域」から日本・米国・英国** を選べます。表示言語とは独立し、起動ごとの初期値は日本です。地域を変えるときは専用ブラウザを閉じ、対象タブの選択・プレビュー・承認をやり直します。地域ごとの実アカウント・実書籍は未検証です。ストア固有部分と共通画像処理の[拡張基盤・将来計画](docs/store-adapters.md)も追加していますが、BOOK☆WALKER・ebookjapan・コミックシーモアは**未対応**です。規約・複製条件と許可試料での確認は各社対応時に別途行います。これらの機能は下記のv0.1.6 Portable ZIPに含まれます。

## 使い始める

**Portable版：** [v0.1.6のリリースZIP](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.1.6)を取得し、`SHA256SUMS.txt` と照合してZIP全体を書き込み可能なフォルダへ展開し、`KindleToZip-Portable.exe` を起動します。Node.js・専用ブラウザは同梱済みで、開発環境は不要です。[3言語のPortableガイド](docs/portable.md)を参照してください。

**ソースから：** **Windows x64・Git・Node.js 22以降・PowerShell 7** が必要です。[入門ガイド](docs/getting-started.ja.md)で専用のRust環境とブラウザを導入し、`npm start` で起動します。まずはAmazonへのログインも実書籍も不要な自作サンプルから試せます。

## 利用前に知っておきたいこと

- **品質：** v0.1.6は正確なソースcommitの必須CIとタグ付きリリースの全ゲートを通過し、公開ソースUI・配備・配布版の公開選択／出力回帰検査も成功しています。過去の失敗は履歴として残しています。利用者のローカル改善確認と、従来のv0.1.2のクリーンWindows・実書籍全冊報告は、このホスト版EXEの自動試料検査とは別です。[検証履歴とリリース記録](docs/validation.md)（英語）を参照してください。
- **ログインと保存データ：** ログインは公式画面だけで行います。**ログイン状態は既定で保存します。** 保存をOFFにすると別の一時プロファイルを使い、通常終了で削除しますが、異常終了では残る場合があります。プロファイル・Cookie・書籍情報・取得画像は共有しないでください。[プライバシーと保存先](docs/security-and-trust.md)（英語）に詳細があります。
- **通信と信頼：** アプリ独自の認証サーバー・テレメトリ・自動更新確認はありません。公式読書・認証サービス、ブラウザ、導入時の通信は発生します。ソース公開は**安全性の保証ではありません**。[通信先と信頼境界](docs/security-and-trust.md)（英語）を参照してください。
- **動作範囲：** v0.1.6では表示言語とは別に日本・米国・英国のKindle入口を選べますが、各地域の実書籍、全レイアウト、ZIP64、すべてのCBZビューアは未検証です。利用者側で確認したクリーンWindows・実書籍の動作は、全環境・全書籍を保証するものではありません。標準・2倍の描画密度には **画像ごとに16メガピクセル・32 MiB** の上限があり、元の表示にない細部は復元できません。
- **規約と権利：** DRMを解除しなくても、**適法・規約適合とは限りません**。Amazonの利用規約はロボットなどのデータ収集ツールを利用許可に含めておらず、自動取得やツール配布には契約・著作権上の未解決の問題があります。権限のあるコンテンツだけを扱い、許可なく取得ページを再配布しないでください。[法的な注意事項](docs/legal-notes-ja.md)をお読みください。

KindleToZipは **Amazon非公式・非提携** で、Amazonの承認・支援を受けた製品ではありません。AmazonおよびKindleはAmazon.com, Inc.または関連会社の商標です。Amazonや法律の専門家による確認済みとはしていません。

## よくある質問

**無料ですか？ 別のアカウント登録は必要ですか？**

KindleToZipは無料・オープンソースです。独自登録、有料の枚数制限、透かし、有料の機能解除はありません。Amazonアカウントや、対象コンテンツの購入・契約は別途必要な場合があります。

**DRMを解除しますか？ Windows版Kindleアプリでも使えますか？**

いいえ。Web読書画面のスクリーンショットを取得する方式です。書籍ファイルの復号、DRM・撮影制限の回避、デスクトップ版の操作は行いません。

**1冊すべてを正しい順番で保存できますか？**

保証していません。取得範囲・順序・見開き分割・停止位置は本人の点検が必要です。ZIPの検証成功だけでは全ページ取得を意味せず、分割も意味的なページ認識ではありません。

**アプリの言語は変えられますか？**

言語メニューで日本語・英語・簡体字中国語を選べます。現在のソースCIでは公開言語切り替え導線の検査も成功しています。[検証履歴](docs/validation.md)では、過去の失敗とソース検査・配布版検査の範囲を区別しています。

## 開発を支援する

役に立ったら、[Ko-fiでコーヒー1杯分の支援](https://ko-fi.com/zufallupon)をしていただけるとうれしいです。**支援は完全に任意**で、機能の利用条件にはなりません。

[![Ko-fiで開発を応援する](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/zufallupon)

感想や[不具合報告](https://github.com/zufall-upon/KindleToZip/issues)も歓迎します。[GitHub Sponsors](https://github.com/sponsors/zufall-upon)への導線も残していますが、作者プロフィールへ転送される場合があり、**GitHub Sponsorsでの支援受付**はまだ確認できていません。

## 文書・ライセンス

[文書一覧](docs/README.md) · [開発・ビルド](docs/development.md)（英語） · [リリース検証](docs/releasing.md)（英語） · [画像と文書のレビュー](docs/readme-review.md)（英語）

[GitHub Actions](https://github.com/zufall-upon/KindleToZip/actions)にはソース検査と、別途手動起動するDraft Release用ワークフローがあります。存在するだけでリリース合格・独立監査・ビット単位の再現性を証明するものではありません。

Copyright (C) 2026 **[zufall-upon](https://github.com/zufall-upon)**。**GNU GPL v3.0のみ**（`GPL-3.0-only`）。[LICENSE](LICENSE)を参照してください。無保証で提供し、依存物にはそれぞれのライセンスが適用されます。GPLv3は書籍や取得ページの利用権を付与しません。

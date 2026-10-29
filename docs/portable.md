# KindleToZip Portable

English · 日本語 · 简体中文

Windows x64 Portable application. A source-tagged snapshot of this guide is included as `README.md` in the release ZIP; an existing ZIP is not replaced for documentation updates. Use only assets from [the official repository's Releases page](https://github.com/zufall-upon/KindleToZip/releases).

## English

1. Download the Windows x64 ZIP and `SHA256SUMS.txt` from the same release. Follow the [checksum and provenance instructions](https://github.com/zufall-upon/KindleToZip/blob/main/docs/releasing.md).
2. Extract the **entire ZIP** into a writable local folder. Keep `LICENSE`, `build-metadata.json`, and `third-party-notices/` with the executable.
3. Double-click `KindleToZip-Portable.exe`. Node.js, the controller, and the dedicated browser are bundled; a source-development setup is not required.
4. Choose English, Japanese, or Simplified Chinese in the language menu. First try the self-authored sample available from the app's auxiliary controls, without an Amazon login or real book.
5. For the official reader, sign in yourself on the official page, select its reader tab, check the preview, approve it, and **start in a separate action**. After stopping, review images and save ZIP / CBZ. To resume with retained images, compare the last saved image and current position, preview and approve again, then explicitly start.

Capture can run in the background while you do other work, but keep the dedicated reader window open and not minimized; operation while the screen is locked or the PC sleeps is not guaranteed. In v0.1.3, PNG or lossy JPEG capture, JPEG quality, individual page layout, and manual crop are selectable; review the results because automatic layout detection can be wrong.

The EXE creates `runtime/`, `data/`, and `temp/` beside itself. **Login state is retained by default.** These folders can contain cookies, settings, and captured content; do not upload them or redistribute an already-used installation folder. Distribute the original release ZIP instead. Close the app normally before moving or updating its folder; do not forcibly terminate it or replace a running EXE.

The user reported clean-Windows operation and complete real-book capture for v0.1.2 on 2026-10-29, separately from automated fixture checks. The user later said they had confirmed the local image improvements, without specifying the scope of that check. The current entry point targets Japan's Kindle web reader; other regions and every layout are unverified. No DRM bypass, Amazon endorsement, or legal clearance is claimed. Use only content you are authorized to capture. See [privacy](https://github.com/zufall-upon/KindleToZip/blob/main/docs/security-and-trust.md), [validation scope](https://github.com/zufall-upon/KindleToZip/blob/main/docs/validation.md), and [legal notes](https://github.com/zufall-upon/KindleToZip/blob/main/docs/legal-notes-ja.md).

## 日本語

1. 同じリリースからWindows x64用ZIPと `SHA256SUMS.txt` を取得し、[ハッシュとビルド証明の手順](https://github.com/zufall-upon/KindleToZip/blob/main/docs/releasing.md)に沿って確認します。
2. 書き込み可能なローカルフォルダへ **ZIP全体を展開**します。`LICENSE`・`build-metadata.json`・`third-party-notices/` は実行ファイルと一緒に残します。
3. `KindleToZip-Portable.exe` をダブルクリックします。Node.js・コントローラー・専用ブラウザは同梱済みで、ソース実行用の開発環境は不要です。
4. 言語メニューで日本語・英語・簡体字中国語を選べます。最初は補助操作から、Amazonへのログインや実書籍が不要な自作サンプルを試してください。
5. 公式読書画面では本人がログインし、読書タブを選択してプレビューを点検・承認した後、**別の操作で開始**します。停止後は画像を点検し、ZIP / CBZへ保存します。画像を残して再開する場合も、最後の保存画像と現在位置を照合し、再プレビュー・再承認後に明示開始します。

バックグラウンドで取得し、待ち時間に別の作業ができます。ただし専用読書ウィンドウは開いたまま最小化せず、画面ロック中やスリープ中の継続は保証されません。v0.1.3ではPNGまたは非可逆JPEGの取得、JPEG画質、画像ごとのページ構成、手動クロップを選べます。自動判定は誤ることがあるため点検してください。

EXEの横に `runtime/`・`data/`・`temp/` を作成します。**ログイン状態は既定で保存します。** Cookie・設定・取得内容を含む場合があるため、使用済みフォルダを公開・再配布しないでください。共有する場合は元のリリースZIPを使ってください。移動・更新前には通常終了し、強制終了や起動中のEXEの置換は避けてください。

v0.1.2のクリーンなWindowsでの動作と実書籍全冊の取得は、2026-10-29に利用者側で確認済みとの報告を受けています。自動の試料検査とは別の記録です。その後、利用者はローカルの画像改善を「確認した」と述べましたが、確認範囲の詳細は示されていません。現在の入口は日本向けKindle Webで、他地域・全レイアウトは未検証です。DRM回避・Amazonの承認・法的な確認済みを主張しません。権限のある内容だけを扱ってください。[プライバシー](https://github.com/zufall-upon/KindleToZip/blob/main/docs/security-and-trust.md)・[検証の範囲](https://github.com/zufall-upon/KindleToZip/blob/main/docs/validation.md)・[法的な注意事項](https://github.com/zufall-upon/KindleToZip/blob/main/docs/legal-notes-ja.md)も参照してください。

## 简体中文

1. 从同一发布版本下载 Windows x64 ZIP 和 `SHA256SUMS.txt`，按[校验和与构建来源说明](https://github.com/zufall-upon/KindleToZip/blob/main/docs/releasing.md)验证。
2. 将 **整个 ZIP 解压**到可写的本地文件夹。保留可执行文件旁的 `LICENSE`、`build-metadata.json` 和 `third-party-notices/`。
3. 双击 `KindleToZip-Portable.exe`。已包含 Node.js、控制器和专用浏览器，无需配置源代码开发环境。
4. 在语言菜单选择日语、英语或简体中文。建议先从辅助操作打开自制样本，无需 Amazon 登录或真实书籍。
5. 使用官方阅读器时，请自行登录官方页面、选择阅读标签页、检查并确认预览，再通过 **单独操作开始**。停止后检查图像并保存 ZIP / CBZ。保留图像继续时，也须比较最后保存的图像与当前位置，重新预览并确认，再明确开始。

获取可在后台进行，等待时可以做其他工作；但专用阅读窗口须保持打开且不最小化，不保证锁屏或睡眠期间继续运行。v0.1.3 可选择 PNG 或有损 JPEG 获取、JPEG 画质、逐图页面布局和手动裁剪；自动判断可能出错，请检查结果。

EXE 旁会创建 `runtime/`、`data/`、`temp/`。**默认保留登录状态。** 这些目录可能包含 Cookie、设置与截图，请勿上传或再分发使用过的安装目录；分享时请使用原始发布 ZIP。移动或更新前正常关闭应用，不要强制终止进程或替换运行中的 EXE。

用户于 2026-10-29 报告已确认 v0.1.2 在干净 Windows 环境下运行并完整获取真实书籍，此报告与自动样本检查分开记录。之后用户表示已确认本地图像改进，但未说明该次确认的详细范围。当前入口面向日本地区的 Kindle 网页阅读器，其他地区及所有布局均未验证。不声称绕过 DRM、获得 Amazon 认可或法律许可。仅处理有权获取的内容。请参阅[隐私说明](https://github.com/zufall-upon/KindleToZip/blob/main/docs/security-and-trust.md)、[验证范围](https://github.com/zufall-upon/KindleToZip/blob/main/docs/validation.md)及[法律注意事项](https://github.com/zufall-upon/KindleToZip/blob/main/docs/legal-notes-ja.md)。

Copyright (C) 2026 zufall-upon. GNU GPL v3.0 only (`GPL-3.0-only`); see the included `LICENSE`. Provided without warranty. Dependencies retain their own licenses. The software license grants no rights to books or captured pages.

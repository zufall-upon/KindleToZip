# Ubuntu x64 Portable

Node.js、保存コントローラー、操作画面用Chromiumを同梱したLinux版です。
実Kindle用のブラウザには、別途インストールされたCanonical Chromium SnapとWaylandを使用します。

## 必要な環境

- Ubuntu x86_64のWaylandデスクトップ。開発時の実本確認はUbuntu 26.04で実施。
- Chromium Snap、通常のsandbox、デスクトップの鍵管理サービス。
- 空き容量は展開分約1GBに加えて取得原本・出力ZIP分が必要です。
- 短い、書き込み可能なホーム内の非隠しフォルダー（例：`~/KTZ`）。

Snap起動ファイルと権限構成を検査します。検証した構成と違う場合は
`snap_changed` 等で停止します。すべてのSnapリビジョンやUbuntu版には対応していません。
`--no-sandbox` や鍵管理無効化で回避せず、対応状況を確認してください。

## 展開・起動

[v0.2.1リリース](https://github.com/zufall-upon/KindleToZip/releases/tag/v0.2.1)の `KindleToZip-Portable-v0.2.1-linux-x64.tar.gz` と `SHA256SUMS-linux.txt`
を同じフォルダーへ保存し、照合します。

```sh
sha256sum --check SHA256SUMS-linux.txt
tar -xzf KindleToZip-Portable-v0.2.1-linux-x64.tar.gz -C "$HOME"
cd "$HOME/KindleToZip"
./start-linux-bundle.sh --login
```

公式画面で本人がログインし、ログイン用ウィンドウを正常に閉じます。
以後は `./start-linux-bundle.sh` で操作画面を開きます。
ログイン済みであれば同じ保存セッションを利用できます。

1. 新しい作業を用意し、取得元と保存専用セッションを選びます。
2. 専用Readerで本人が本・開始位置を決め、操作画面で読書タブを選びます。
3. プレビューの本・領域・方向を確認し、自動取得または最大画面数を承認します。
4. 別の開始操作で取得します。停止後に範囲・順序を点検してZIP/CBZへ保存します。

取得中は最小化・画面ロック・スリープを避けてください。通常取得は1回最大2時間、
原本合計2GiB、保存先の空き256MiBを停止境界とします。
終端候補での停止や処理工程100%だけでは、全冊の取得を保証しません。

## 保存・復帰

`data/` と `temp/` は本体の隣に作られます。ログイン、原本、作業記録は非公開で扱ってください。
既存の出力は上書きせず、点検のクロップ・分割でも原本を保持します。
保存時は原本照合から再読検証まで進捗と経過時間を表示します。

中断後は「保存済みの画像を確認」で表示された作業フォルダーを指定します。
取得再開には、最後の原本と現在位置の一致、送りが未送信であること、
再プレビュー・承認・別の開始操作が必要です。送り不明なら再送しません。
終了不明のlockを手動で削除したり、使用中のprofileをコピーしないでください。

## 検査と確認範囲

```sh
./start-linux-bundle.sh --headless-self-check  # 同梱ブラウザの匿名取得・crop・ZIP照合
./start-linux-bundle.sh --self-check           # Wayland/Snapを使う匿名取得・保存
```

2026-11-05、開発PCの配置版で、本人指定の1冊・161画像の点検、ZIP内の全画像の
内容・順序照合、進捗100%と正常終了まで確認しました。途中停止からの復帰・修正を含みます。
v0.2.1は両OSの正式リリース検査・実asset/metadata/checksum/provenance照合・匿名download確認後に同時公開しました。
この配布物の匿名試料検査と、開発配置での実本161画像の結果は別の記録です。
headless検査はWayland/SnapやAmazon認証の確認ではありません。

Windows版は同じリリースのWindows x64 ZIPと[Portableガイド](portable.md)を参照してください。

# Rustローカル処理・JSONL IPC

## 対象と起動

`poc/controller/` の `ktz-g02-controller.exe` は状態ガードとローカルジョブ処理を提供する長寿命JSONL子プロセスです。Node UIは標準入力へJSONを1行ずつ送り、標準出力から同じ要求IDの応答を1行ずつ読みます。標準出力に診断を出しません。標準エラーは呼出側で保存しないでください。

開発用の隔離ツールチェーンでビルドします。

```powershell
pwsh -NoProfile -File scripts/test-rust.ps1
```

生成物は `artifacts/rust-target/debug/ktz-g02-controller.exe` です。Nodeからは実行ファイルを直接起動し、`stdin`・`stdout`をパイプ接続します。バージョン1要求の形は次のとおりです。

```json
{"version":1,"id":1,"command":{"kind":"create_job","base_dir":"C:\\Users\\me\\Documents\\KindleToZip"}}
```

```json
{"version":1,"id":1,"ok":true,"payload":{"snapshot":{"manifest":{"schema_version":1,"state":"ready"}}}}
```

失敗応答は`{"version":1,"id":1,"ok":false,"code":"job_busy"}`形式です。`id`は同一プロセスで単調増加させ、未知フィールド、未知コマンド、重複ID、未知版、不正JSONは拒否されます。最大フレーム長は改行を含め65,536バイトです。フレーム超過・壊れたJSON・版またはID不一致は、そのプロセスの処理を停止します。

## コマンド

`kind`は以下の列挙値です。payloadプロパティは`command`オブジェクト内に置きます。

| `kind` | payload | 意味 |
| --- | --- | --- |
| `create_job` | `base_dir` | 利用者が選んだ既存のローカル保存先の下に新規ジョブを作成。作成済みジョブを置換しない。 |
| `open_job` | `path` | 版とmanifestを検証してジョブを開く。ジョブ排他を取得し、中断状態を自動再開しない。 |
| `job_info` | なし | manifest、孤立ファイル、不整合、再開確認要否を返す。 |
| `job_progress` | なし | 再デコードせずメモリ上のmanifestを返す。UIの周期表示専用で、完全性検証の代わりにはしない。 |
| `lock_data_directory` | `path` | アプリ専用データ領域をWindows利用者ACLとOS排他で保護し、プロセス終了まで保持する。 |
| `close_job` | なし | ジョブを閉じて排他を解放。撮影中なら中断状態に保存する。 |
| `capture_start` / `capture_pause` / `capture_stop` | なし | 明示開始、一時停止、取得の停止。停止は確定画像を消さない。 |
| `resume_confirm` | `last_capture_id`, `target_confirmed` | 保存済み最終IDと対象確認を照合して`ready`へ戻す。成功後も`capture_start`が別途必要。 |
| `capture_begin` | なし | 撮影中に次IDを先に永続化し、Rustがpendingファイルを排他的作成する。 |
| `capture_chunk` | `capture_id`, `data_base64` | PNGを最大34,000デコードバイトずつ送信。Rustがpendingへ追記する。 |
| `capture_commit` / `capture_abort` | なし | PNG検証後に原本を排他的確定する／未確定pendingを明示破棄する。 |
| `set_review_order` | `capture_ids` | 選択画像と出力順を指定。省いた画像は除外記録に移すだけで原本を削除しない。 |
| `crop_image` | `capture_id`, `x`, `y`, `width`, `height` | PNG原本から新しい非破壊クロップを生成し、再検証して版付き保存する。 |
| `confirm_range` | `confirmed` | 取得範囲の確認を出力検証とは別に保存する。未確認のままでも出力できる。 |
| `export` | `destination`, `format` (`zip`または`cbz`) | 採用順のPNGのみをZIPへ格納し、内容・寸法・CRC・SHA-256を再読照合してから競合しない方法で公開する。 |
| `create_session_directory` | `path` | 新規のセッション用ディレクトリにWindows利用者ACLを適用する。既存ディレクトリは開かない。 |
| `transition`, `state`, `snapshot`, `window_for_process`, `window_above`, `observe_start`, `observe_stop` | 既存の各payload | 既存状態ガード・読取専用観測API。 |
| `close` | なし | JSONL子プロセスを閉じる。 |

PNGは最大32MiB・16メガピクセルです。RustがチャンクCRC、実デコード、寸法、SHA-256を検査します。壊れた・全黒・表示ピクセルのない画像は確定しません。白紙候補と完全重複候補はラベル付けして残します。画像確定前にページ送りをするAPIはありません。取得入力の準備、ブラウザ操作、対象一致・ログイン状態・終端の判断はこのIPCの責務外であり、Kindle接続や取得を実行しません。

## 保存・復帰・出力上の不変条件

- ジョブは`manifest.json`、`originals/`、`pending/`、`rendered/`を持ちます。manifestはschema版1で、未知の将来版、未知フィールド、内部画像パスの不一致を拒否します。
- 原本IDは作成前にmanifestへ予約し、再利用しません。manifest更新は同じディレクトリ内の一時ファイルと置換で行います。画像とmanifestの間で異常終了した場合、孤立物・不整合を表示し、自動採用・削除しません。
- Windowsのジョブ排他は`.job.lock`に対する排他バイトロックで、プロセス終了時にOSが解放します。リンク／リパースポイントのジョブ構成要素を拒否します。出力は同一ディレクトリの新規一時ZIPを検証し、hard-linkによる名前公開で既存物の置換を拒否します。
- ジョブと新規セッションディレクトリは、Windowsの現在利用者へACLを絞ります。ACL適用に失敗した場合は作成成功を返しません。これは同一利用者の別プロセス、管理者、マルウェアに対する秘密保持を保証しません。
- 取得範囲の確認`range_confirmed`とアーカイブの整合性検証は別記録です。ZIP/CBZの成功を全範囲取得済みとは扱いません。
- 現状は1プロセスにつき1ジョブ、PNG形式、ZIPのStored方式のみです。ZIP64、ネットワーク／同期先の保証は未対応・未確認です。このIPCは一般ネット送信を行いません。Playwright・ローカルUIの起動と検証は[開発手順](development.md)を参照してください。
- 停止・一時停止はNode側でまず世代を無効化し、新しい撮影・送りを禁止します。Rustへ確定要求を渡す前なら未確定データを明示破棄します。Rustで開始済みの確定処理は分割取消できず、その1枚の永続化完了を待ってから停止応答します。確定済みデータの取り消し・削除は行いません。
- 送りのクリック可能待ちは入力を送らないtrialで行い、待機後に取消・対象・位置・同じボタン・遮蔽を再確認します。座標取得前後でボタンと直下iframeの矩形が変わる場合も送信しません。実入力は対象Page内へ自動待機・再試行なしで1回だけ送ります。既に送信した押下／解放の組は完了を待ち、次の送りは送りません。待機中の一時停止／停止・別本・ログアウトでは遅延クリックしません。

## 検証

`pwsh -NoProfile -File scripts/test-rust.ps1`は、隔離Cargo環境でlocked/offlineのRust単体試験とビルドを行い、既存`tests/rust-ipc.test.mjs`に加えて`tests/local-store.test.mjs`の実行回帰を行います。後者は自作メモリPNGのみを使い、保存・復帰・順序・クロップ・CBZ内容と寸法・上書き拒否・黒画像拒否を確認します。実Kindle、認証情報、ネットワーク取得は使用しません。

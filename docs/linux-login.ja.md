# Ubuntuの専用ログイン

Ubuntu Portableのフォルダー内で `./start-linux-bundle.sh --login` を実行します。
本人が公式画面でログイン・追加認証し、ウィンドウを正常に閉じてから通常のアプリを開きます。

この入口は取得を開始しません。保存先は本体隣接の `data/application/saved-…` です。
普段の個人ブラウザのprofileは使わず、保存専用セッションを作成・再利用します。
`data`・profile・Cookieを公開や不具合報告に添付しないでください。

通常sandbox・鍵管理サービス・対応Chromium Snap・Waylandが必要です。
認証要求やセッション失効は本人が公式画面で確認してください。
使用中／終了不明のlockは自動解除せず、別profileへの切替や移行で迂回しません。

起動・保存・検査の手順は[Ubuntu Portableガイド](ubuntu-portable.ja.md)を参照してください。

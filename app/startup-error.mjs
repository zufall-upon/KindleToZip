// Diagnostics only: never repair permissions, relocate data or fetch dependencies.
export function linuxStartupMessage(error, stage) {
  const codes = new Set();
  for (let current = error; current && !codes.has(current); current = current.cause) {
    codes.add(current); codes.add(current.code);
  }
  if (codes.has('controller_not_found')) return '実行可能なRust controllerが見つかりません。既存ビルドとKTZ_CONTROLLER_PATHを確認してください。自動ビルド・取得は行っていません。';
  if (codes.has('job_busy')) return '保存領域は別の起動が使用中です。もう一方を通常終了してから再試行してください。ロックや保存データは削除していません。';
  if (['unsafe_temp_directory', 'directory_permissions_invalid', 'file_permissions_invalid', 'directory_invalid', 'file_invalid', 'unsafe_session_preferences', 'unsafe_presets'].some(code => codes.has(code))) {
    return '専用領域の権限・所有者・種類が安全条件を満たしません。保存領域とKTZ_TEMP_DIRを点検してください。権限変更・削除・別領域への切替は行っていません。';
  }
  if (stage === 'temporary') return '専用一時領域を用意できません。既存の親フォルダと権限を確認してください。短いprivateディレクトリをKTZ_TEMP_DIRへ明示指定できます。自動切替は行っていません。';
  if (stage === 'control') return '操作画面用Chromiumの起動または読込みに失敗しました。既存ブラウザ・画面環境・一時領域を確認してください。長いTMPDIRが疑われる場合は短いprivateディレクトリをKTZ_TEMP_DIRへ明示指定できます。原因や文字数の閾値は断定せず、自動取得・切替は行っていません。';
  if (codes.has('data_directory_unavailable')) return '保存領域へアクセスできません。マウントと権限を確認してください。データの削除・自動修復は行っていません。';
  return '起動できません。既存controller・ブラウザと保存領域を確認してください。原因は特定できていません。自動修復・取得は行っていません。';
}

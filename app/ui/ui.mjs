import { installLanguageSelector, translate, canonicalText, currentLanguage } from './i18n.mjs';
const $ = id => document.getElementById(id);
// This is the loopback UI key, never a Kindle cookie/session. Keep it only in
// this tab's same-origin storage so an ordinary reload does not lose access.
const fragmentKey = location.hash.slice(1);
const token = /^[a-f0-9]{64}$/.test(fragmentKey) ? fragmentKey : sessionStorage.getItem('ktzLocalUiKey') ?? '';
if (token) sessionStorage.setItem('ktzLocalUiKey', token);
history.replaceState(null, '', '/');
document.title = `KindleToZip — 手順ガイド [${location.port}]`;
$('connection').textContent = `接続先：${location.origin}`;
let state;
let autoCropCandidate = null;
let cropSelectionRevision = 0;
function clearAutoCrop(message = '') {
  autoCropCandidate = null;
  $('autoCropFigure').hidden = true;
  $('autoCropActions').hidden = true;
  $('autoCropStatus').textContent = message;
  $('autoCropBounds').textContent = '';
  const canvas = $('autoCropPreview'); canvas.width = 1; canvas.height = 1;
}
let lastImages = '';
let imageUrls = [];
let previewPageUrls = [];
let rendering = Promise.resolve();
let imageRenderRevision = 0;
let workflowSignature = null;
let frameMappings = {};
const mappingLabels = { reader: '読書領域', next: '次へボタン', identity: '本の識別表示', position: '位置表示' };
const failureLabels = { hidden: '非表示になっています', not_found: '画面から見つかりません', not_unique: '複数の候補があります', auth_password: '主画面に可視のパスワード欄', auth_modal: '主画面に可視のmodal', reader_password: '読書フレーム内に可視のパスワード欄', reader_modal: '読書フレーム内に可視のmodal', blocked_hit: '別の要素が手前にあります' };
Object.assign(failureLabels, { viewport_unknown: '表示サイズを確認できません', empty_visible_bounds: '可視範囲が空です', frame_depth_unsupported: 'フレーム構造を確認できません', label_empty: '表示項目の文字列が空です', label_too_long: '表示項目が大きすぎます。項目そのものを指定してください', area_too_small: '読書領域が小さすぎます', outside_view: '読書領域が表示外です' });
failureLabels.candidate_stale = '選んだ領域が変わりました';
failureLabels.invalid_selector = '詳細指定の構文が不正です';
failureLabels.library_selected = 'ライブラリ側のタブが対象です';
let pickingField = null;
failureLabels.kindle_chrome_structure_changed = 'タイトルの親枠と位置・次へ・描画面が同じ読書領域にありません。対応画面を確認し、必要な場合だけ微調整してください';
let pickerStage = null;
let connected = false;
let pendingActions = 0;
let interactionGeneration = 0;
let localCancelableCount = 0;
let cancellingInspection = false;
const pendingByGeneration = new Map();
const superseded = () => Object.assign(new Error('操作は取り消されました。'), { code: 'ui_superseded' });
function requireCurrent(generation) { if (generation !== interactionGeneration) throw superseded(); }
function supersedeInteraction() {
  interactionGeneration += 1;
  stateRequestGeneration += 1;
  configurationRevision += 1;
  pendingActions = 0;
  localCancelableCount = 0;
  rendering = Promise.resolve();
  imageRenderRevision += 1;
  lastImages = '';
  imageLoading = false;
  expectedProgressKey = null;
  operationProgress = { done: operationProgress.done, total: operationProgress.total, unit: operationProgress.unit, detail: '旧操作を取り消しました。遅延応答は表示しません' };
  operationOutcome = 'cancelled';
  clearPreview();
}
let stateRequestGeneration = 0;
let displayedPreview = false;
let configurationDirty = true;
let configurationRevision = 0;
let lastBrowserId;
let lastMappingRevision;
let lastTabRevision;
let backendMappings = {};
let activeStage = 'setup';
let captureIntent = false;
let previousFlow;
let previousState;
let lastFailureKey;
let lastSettingsKey;
let settingsApplying = false;
let presetKey;
let presetEditorKey;
let presetConfigurationKey;
let exportJobPath;
let exportContentKey;
let rangeConfirmationDirty = false;
let destinationDirty = false;
let destinationRevision = 0;
let imageLoading = false;
let operationOutcome = 'idle';
let operationLabel = '待機中';
let operationProgress = { done: 0, total: 1, unit: '処理工程', detail: '操作待ち' };
let imageProgress = null;
let expectedProgressKey = null;
let progressRequest = false;
function localProgress(done, total, unit, detail) {
  operationProgress = { done, total, unit, detail }; updateOperationStatus();
}
async function pollProgress() {
  if (progressRequest || !(pendingActions || state?.busy)) return;
  progressRequest = true;
  const generation = interactionGeneration, key = expectedProgressKey;
  try {
    const response = await fetch('/api/progress', { headers, cache: 'no-store' });
    if (!response.ok) return;
    const progress = await response.json();
    if (generation !== interactionGeneration || key !== expectedProgressKey || !progress
      || progress.key !== key || !(pendingActions || state?.busy)) return;
    if (progress.status === 'pending' || !pendingActions && progress.action === 'start') {
      operationProgress = progress;
      if (!pendingActions && progress.status !== 'pending') operationOutcome = progress.status;
      updateOperationStatus();
    }
  } catch { /* The ordinary connection check owns connection errors. */ }
  finally { progressRequest = false; }
}
const operationLabels = { create: '作業を用意', recover: '中断データを開く', openBrowser: '専用ブラウザを準備', closeBrowser: '専用ブラウザを終了',
  preview: '表示を検査・プレビュー', quickPreview: '自動検査・プレビュー', approve: '承認を確認', start: '取り込みを開始',
  review: '確定画像を点検', crop: '画像をクロップ', export: 'ZIP / CBZを保存・再読検証', chooseDestination: '保存先ダイアログの選択待ち',
  prepareReset: '現在の取得画像を確認', cancelReset: '画像を残して確認を閉じる', resetImages: '確認済みの取得画像をリセット',
  finishBook: '安全停止・本の作業を終了', cancelBack: '取消・安全停止', pause: '安全に一時停止', stop: '安全停止' };
function updateOperationStatus() {
   const busy = pendingActions > 0 || state?.busy;
   const preparingImages = imageLoading && activeStage === 'review';
   const pending = busy || preparingImages;
   const progress = !busy && preparingImages ? imageProgress : operationProgress;
   const outcome = !busy && preparingImages ? 'pending' : !pendingActions && operationProgress.action === 'start' ? operationProgress.status : pending ? 'pending' : operationOutcome;
  $('operationStatus').dataset.status = outcome ?? 'idle';
  $('operationStatus').setAttribute('aria-busy', String(pending));
  $('operationLabel').textContent = busy ? (pendingActions ? operationLabel : operationLabels[state?.activeOperation] ?? (state?.state === 'Capturing' ? '画像を取り込み中' : '安全処理の完了待ち'))
    : preparingImages ? '確定画像を点検表示へ読み込み中' : operationOutcome === 'idle' ? '待機中' : `${{ success: '完了', failure: '失敗', cancelled: '取消' }[operationOutcome]}：${operationLabel}`;
   const known = Number.isFinite(progress?.total) && progress.total > 0;
   const percent = known ? Math.floor(100 * progress.done / progress.total) : 0;
   $('operationPercent').textContent = known ? `${percent}%` : '割合未確定';
  $('operationFill').style.width = `${percent}%`;
   if (known) $('operationBar').setAttribute('aria-valuenow', String(percent));
   else $('operationBar').removeAttribute('aria-valuenow');
   $('operationBar').setAttribute('aria-valuetext', `${known ? `${percent}%` : '割合未確定'}・${progress?.unit ?? '処理工程'}`);
   $('operationDetail').textContent = progress ? `${progress.unit} ${known ? `${progress.done}/${progress.total}・残り${progress.total - progress.done}` : `総量未確定・処理済み${progress.done}・残り不明`}：${progress.detail}` : '操作待ち';
}
async function paintOperation() {
  // Let the initial visual state reach a frame before starting async work.
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
}
const pickIds = { reader: 'pickReader', next: 'pickNext', identity: 'pickIdentity', position: 'pickPosition' };
const remedies = {
  invalid_selector: '詳細指定の該当CSSを修正して保存してください。自動検査方式のプリセットへ切り替えることもできます。',
  label_empty: '番号や書名の文字そのものを選び直してください。数値入力欄も指定できます。空白・アイコンは使えません。',
  label_too_long: '広すぎる範囲です。書名または位置番号の文字だけを選び直してください。',
  hidden: '現在見える要素を選び直してください。読書領域はページ画像の内側を選びます。',
  not_found: '専用ブラウザで本を開き、画面に表示されている項目を確認してください。必要なら詳細指定から選びます。',
  not_unique: '複数の候補があります。画面の表示を整理するか、詳細指定から対象を選んでください。',
  blocked_hit: '別の要素が画面上で重なっています。表示を整えて選び直すか、選んだ要素が変わっていないことを確認して1段広い範囲を明示選択してください。',
  candidate_stale: '対象画面または選んだ要素が変わりました。読書領域をもう一度選んでください。',
  candidate_target_changed: '対象タブが変わりました。現在の読書タブを選び直してください。',
  candidate_navigation_changed: '読書画面が移動しました。画面が落ち着いてから領域を選び直してください。',
  candidate_frame_detached: '読書フレームが置き換わりました。領域を選び直してください。',
  candidate_tabs_changed: '専用タブの構成が変わりました。対象タブを選び直してください。',
  candidate_element_missing: '選んだ画面要素がなくなりました。領域を選び直してください。',
  candidate_element_hidden: '選んだ画面要素が非表示になりました。領域を選び直してください。',
  candidate_element_replaced: '選んだ画面要素が置き換わりました。新しい要素を選び直してください。',
  candidate_parent_missing: '1段広い親領域がなくなりました。領域を選び直してください。',
  candidate_parent_not_unique: '1段広い親領域を一意に確認できません。領域を選び直してください。',
  candidate_parent_hidden: '1段広い親領域が非表示になりました。領域を選び直してください。',
  candidate_parent_replaced: '1段広い親領域が置き換わりました。領域を選び直してください。',
  candidate_parent_not_rendered: 'この範囲には安全に選べる表示枠がありません。読書領域を別の見える位置から選び直してください。',
};
function stage(name) {
  if (activeStage !== name && !pendingActions && !state?.busy) {
    expectedProgressKey = null;
    operationOutcome = 'idle';
    operationProgress = { done: 0, total: null, unit: '現在ステップ', detail: '操作待ち' };
    updateOperationStatus();
  }
  activeStage = name;
  for (const panel of document.querySelectorAll('section[data-stage]')) panel.hidden = panel.dataset.stage !== name;
  for (const button of document.querySelectorAll('[data-stage-target]')) {
    if (button.dataset.stageTarget === name) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
}
function maybeScrollWorkflow() {
  const signature = [
    $('state')?.textContent, $('reason')?.textContent, $('nextAction')?.textContent, $('message')?.textContent,
  ].join('\n');
  if (signature === workflowSignature) return;
  const hadPrevious = workflowSignature !== null;
  workflowSignature = signature;
  if (!hadPrevious) return;
  const focusedInput = document.activeElement?.matches?.('input, textarea, select, [contenteditable="true"]');
  if (focusedInput) return;
  requestAnimationFrame(() => {
    if (document.activeElement?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    const context = document.querySelector('.workflow-context');
    if (context) context.scrollTo({ top: context.scrollHeight, behavior: 'smooth' });
  });
}
for (const button of document.querySelectorAll('[data-stage-target]')) button.addEventListener('click', () => {
  captureIntent = button.dataset.stageTarget === 'capture';
  stage(button.dataset.stageTarget); mappingStatus();
});
stage(activeStage);
function clearPreview() {
  displayedPreview = false;
  configurationDirty = true;
  $('previewConfirmed').checked = false;
  $('resumeConfirmed').checked = false;
  if ($('previewImage').dataset.objectUrl) URL.revokeObjectURL($('previewImage').dataset.objectUrl);
  delete $('previewImage').dataset.objectUrl;
  $('previewImage').removeAttribute('src');
  $('previewImage').hidden = true;
  $('previewPlaceholder').hidden = false;
  $('previewInfo').textContent = '';
  previewPageUrls.forEach(URL.revokeObjectURL); previewPageUrls = [];
  $('previewPages').replaceChildren();
}
function changedMapping() { configurationRevision += 1; clearPreview(); mappingStatus(); }
function destinationAlreadyRegistered() {
  const destination = $('destination').value.trim();
  if (!destination || !state?.job) return false;
  if ($('exportResult').textContent && $('exportResult').dataset.destination === destination) return true;
  const normalize = value => state.pathCaseSensitive ? value.replace(/\/+$/, '') : value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  // A filename-only legacy record does not identify its output directory.
  // Unknown destinations still go through the store's no-overwrite check.
  return state.job.manifest.exports.some(item => item.destination && normalize(destination) === normalize(item.destination));
}
function needsResumeConfirmation() {
  return Boolean(state?.job && (state.job.manifest.images.length || state.job.manifest.state !== 'ready'));
}
function mappingStatus() {
  const fields = Object.keys(mappingLabels);
  const complete = fields.filter(field => $(field).value.trim());
  const selectedField = state?.pickingField ?? pickingField;
  const busy = pendingActions > 0 || state?.busy;
  $('kindleRegion').disabled = !connected || state?.browserOpen || state?.readerReleasePending || busy;
  $('chooseDestination').disabled = busy || !state?.job || state?.saveDialogAvailable === false || Boolean(state?.storageUncertain);
  $('destinationDialogHelp').textContent = state?.saveDialogAvailable === false
    ? 'この環境では保存先ダイアログを利用できません。保存先を手入力してください。'
    : 'ダイアログで選ぶだけでは保存・取得を開始しません。手入力も利用できます。';
  updateOperationStatus();
  if (busy) $('reason').textContent = '';
  else $('reason').textContent = state?.reason ? errorDescription(state.reason) : '';
  const canChooseTab = connected && state?.browserOpen && !busy && !state?.readerReleasePending && state?.state !== 'Capturing';
  const canPick = canChooseTab && Boolean(state?.selectedReaderTab) && state?.readerTabConfirmed === true && $('readerTab').value === state.selectedReaderTab;
  $('readerTab').disabled = !canChooseTab;
  $('selectReaderTab').disabled = !canChooseTab || !$('readerTab').value;
  $('captureScale').disabled = !canPick || busy;
  $('imageFormat').disabled = !canPick || busy;
  $('jpegQuality').disabled = !canPick || busy || $('imageFormat').value !== 'jpeg';
  $('pageOutputMode').disabled = !canPick || busy;
  $('readingDirection').disabled = !canPick || busy || $('pageOutputMode').value !== 'split_spread';
  $('quickPreview').disabled = !canPick || busy;
  $('export').disabled = busy || Boolean(state?.storageUncertain) || !state?.job || !state.job.manifest.selected_capture_ids.length || state.job.issues.length > 0;
  $('exportHelp').textContent = state?.storageUncertain ? errors.storage_reopen_required
    : destinationAlreadyRegistered() ? 'この保存先には既に検証済みの出力があります。別名を指定すると、既存ファイルを保ったまま保存できます。'
    : busy ? '処理中です。取り込み中なら一時停止してから保存してください。'
    : state?.readerReleasePending ? 'ブラウザの終了を確認できません。確定原本があれば点検とZIPを利用できます。次の本には進めません。'
    : !state?.job ? '先に新しい作業か中断データを開いてください。'
    : state.job.issues.length ? '保存済み画像の不整合があります。「画像を点検」で詳細を確認してください。原本は変更していません。'
    : !state.job.manifest.selected_capture_ids.length ? '採用画像がありません。「画像を点検」で保存する画像を採用してください。'
    : `採用画像${state.job.manifest.selected_capture_ids.length}枚を保存できます。保存先を確かめて「決定・次へ」で${$('format').value.toUpperCase()}を保存してください。`;
  for (const id of ['preset', 'savePreset', 'addPreset', 'addKindlePreset', 'presetName', 'presetMode']) $(id).disabled = busy || state?.state === 'Capturing';
  for (const field of fields) $(`${field}Status`).textContent = selectedField === field
    ? pickerStage === 'click_received' || pickerStage === 'selected' ? 'クリック受付済み・結果の反映中' : '専用ブラウザでのクリック待ち'
    : $(field).value.trim() ? '指定済み' : '未指定';
  const issue = state?.selectionFailure;
  if (issue && mappingLabels[issue.field]) $(`${issue.field}Status`).textContent = `要選び直し：${remedies[issue.cause] ?? '指定を完了していません。'}`;
  for (const id of Object.values(pickIds)) $(id).disabled = !canPick;
  $('expandReader').disabled = !canPick || state?.readerCandidateAvailable !== true;
  $('pickAll').disabled = !canPick;
  $('cancelPick').hidden = !selectedField;
  $('mappingStatus').textContent = complete.length === fields.length
    ? '4 / 4項目 指定済み（有効性はプレビューで検査）。まだ取得は開始しません。'
    : `${complete.length} / 4項目 指定済み。未指定：${fields.filter(field => !$(field).value.trim()).map(field => mappingLabels[field]).join('・')}。`;
  $('preview').disabled = complete.length !== fields.length || !canPick;
  $('parentReader').disabled = complete.length !== fields.length || !canPick;
  const help = !connected ? 'アプリとの接続が切れています。「接続を確認し直す」を押してください。アプリを再起動した場合は、新しく開いた操作画面を使ってください。'
    : !state?.job ? '「決定・次へ」で新しい1冊の作業を用意してください。'
    : state?.readerReleasePending ? 'ブラウザの終了を確認できません。新しい検査・取得はできません。'
    : !state.browserOpen ? '「決定・次へ」で専用ブラウザを開いてください。'
    : state.state === 'Capturing' ? '取得中です。「キャンセル・前へ」で安全停止して点検へ戻れます。'
    : selectedField ? `専用ブラウザで「${mappingLabels[selectedField]}」をクリックしてください。Escか「指定を取り消す」で中止できます。`
    : busy ? '処理中です。完了すると指定ボタンを使えます。'
    : state?.readerCandidateAvailable ? '読書領域のクリック位置が遮られました。「選んだ領域を1段広げて選ぶ」で最寄りの表示枠を検査してください。表示枠のない中間要素は飛ばします。'
    : !state.selectedReaderTab || !state.readerTabConfirmed || $('readerTab').value !== state.selectedReaderTab ? '対象の専用タブを選び「決定・次へ」で確定してください。本棚を閉じる必要はありません。'
    : state.displayInspection?.status === 'failed' ? `${errorDescription(state.displayInspection.code)}${state.displayInspection.detail?.field ? ` 対象：${mappingLabels[state.displayInspection.detail.field] ?? '表示'}。` : ''}`
    : issue ? `${mappingLabels[issue.field] ?? '指定'}を確認できません。${remedies[issue.cause] ?? '該当項目を選び直してください。'}`
    : complete.length === fields.length ? '「決定・次へ」でプレビューします。詳細指定を開いた場合は指定した4項目を検査します。自動判別へ戻す必要はありません。'
    : '「決定・次へ」でプレビューします。自動判定できない場合は詳細指定へ案内します。';
  $('captureHelp').textContent = help;
  $('preview').title = $('preview').disabled ? help : '指定した4項目の有効性を検査してプレビューします';
  $('quickPreview').title = $('quickPreview').disabled ? help : '表示中の項目を自動判別して検査します';
  $('state').textContent = !connected ? 'アプリ接続切れ'
    : state?.state === 'Capturing' ? states.Capturing
    : busy ? '処理中・検査結果待ち'
    : validStateLabel();
  $('reconnect').hidden = connected;
  const validPreview = connected && displayedPreview && !configurationDirty && state?.previewReady;
  $('approval').disabled = !validPreview || busy;
  const needsResume = needsResumeConfirmation();
  $('resumeLabel').hidden = !needsResume;
  $('resumeCapture').disabled = !connected || busy || !state?.job?.manifest.images.length;
  $('resumeComparison').hidden = !validPreview || !state?.resumePlan;
  const resumeBlocked = state?.resumePlan?.mode === 'blocked';
  $('approve').disabled = !validPreview || busy || Boolean(state?.storageUncertain) || resumeBlocked || !$('previewConfirmed').checked || (needsResume && !$('resumeConfirmed').checked);
  $('start').disabled = !validPreview || busy || Boolean(state?.storageUncertain) || !state?.previewApproved || state?.state !== 'Ready' || !$('previewConfirmed').checked;
  updateWorkflowControls({ busy, validPreview, canPick, completeCount: complete.length, selectedField });
  maybeScrollWorkflow();
}

function updateWorkflowControls({ busy = pendingActions > 0 || state?.busy, validPreview, canPick, completeCount = 0, selectedField } = {}) {
  const decision = $('decisionButton');
  const back = $('cancelBackButton');
  const finish = $('finishBookButton');
  const connectedNow = connected && Boolean(token);
  const hasJob = Boolean(state?.job);
  const images = state?.job?.manifest?.images?.length ?? 0;
  const selectedImages = state?.job?.manifest?.selected_capture_ids?.length ?? 0;
  const capturing = state?.state === 'Capturing';
  const cancelableOperation = ['preview', 'quickPreview', 'pick', 'pickAll', 'expandReader', 'selectReaderTab', 'chooseDestination'].includes(state?.activeOperation);
  const needsResume = needsResumeConfirmation();
  const alreadyExportedHere = destinationAlreadyRegistered();
  const confirmed = $('previewConfirmed').checked;
  const resumeConfirmed = $('resumeConfirmed').checked;
  const tabPending = !state?.readerTabConfirmed || $('readerTab').value !== state?.selectedReaderTab;
  const inspectImages = hasJob && images && (!state.browserOpen
    || !captureIntent && ['Review', 'Paused', 'NeedsAttention'].includes(state.state));
  let enabled = connectedNow && !busy && !state?.endingBook && !state?.recoveryRequired && !state?.storageUncertain;
  let reason = '';
  let action = !hasJob ? 'create' : activeStage === 'export' ? 'export'
    : activeStage === 'review' || inspectImages ? 'inspect'
    : !state.browserOpen ? 'openBrowser' : ['setup', 'browser'].includes(activeStage) ? 'captureStage'
    : tabPending ? 'selectReaderTab' : validPreview ? state.previewApproved && state.state === 'Ready' ? 'start' : 'approve' : 'preview';
  if (!connectedNow) reason = 'アプリへ接続し直してください。';
  else if (state?.storageUncertain) reason = errors.storage_reopen_required;
  else if (state?.endingBook) reason = '現在の本を安全に終了しています。';
  else if (state?.recoveryRequired) reason = '安全停止の完了を確認できません。取得・保存せず「終了・最初から」を再試行してください。';
  else if (busy) reason = '処理が終わるまでお待ちください。中断可能な確認中は「キャンセル・前へ」を使えます。';
  else if (state?.readerReleasePending && !['inspect', 'export'].includes(action)) {
    enabled = false; reason = 'ブラウザ資源の終了が未確認です。確定原本があれば点検・ZIP保存できますが、新しい検査・取得はできません。';
  }
  else if (action === 'openBrowser' && state?.kindleSupported === false) { enabled = false; reason = errors.linux_kindle_unsupported; }
  else if (action === 'export' && alreadyExportedHere) {
    enabled = false; reason = 'この保存先へのZIP保存は完了しています。別名を指定するか「終了・最初から」で次の本へ進んでください。';
  }
  else if (action === 'export' && (!selectedImages || state.job.issues.length)) {
    enabled = false; reason = canonicalText($('exportHelp'));
  }
  else if (action === 'selectReaderTab' && !$('readerTab').value) {
    enabled = false; reason = '対象の専用タブを選んでから進んでください。';
  } else if (capturing) {
    enabled = false; reason = '取り込み中です。停止後に点検できます。';
  } else if (['approve', 'start'].includes(action)) {
    if (state?.resumePlan?.mode === 'blocked') {
      enabled = false; reason = errors.resume_position_required;
    } else if (!confirmed || needsResume && !resumeConfirmed) {
      enabled = false;
      reason = needsResume && !resumeConfirmed ? '最後の確定画像と現在位置を照合したチェックが必要です。' : 'プレビューを本人が確認し、チェックを入れてください。';
    }
  } else if (action === 'inspect') {
    /* the next action moves between image inspection and ZIP save */
  } else if (action === 'preview' && !canPick) {
    enabled = false; reason = canonicalText($('captureHelp'));
  } else if (completeCount === 4 && selectedField) {
    enabled = false; reason = '画面要素の選択が完了するまでお待ちください。';
  }
  decision.disabled = !enabled;
  decision.dataset.action = action;
  decision.title = enabled ? '現在の状態に合わせて次の安全な操作を行います。' : reason;
  const guidance = {
    create: '「決定・次へ」で新しい1冊の作業を用意します。',
    openBrowser: '「決定・次へ」で専用Kindleを開き、本人がログインして1冊を開いてください。',
    captureStage: '本人が本を開いたら「決定・次へ」で対象タブ・プリセットの確認へ進みます。',
    selectReaderTab: '対象の専用タブを選び、「決定・次へ」で確定してください。以前の承認は使いません。',
    preview: canonicalText($('captureHelp')),
    approve: '本・領域・次へ方向・位置を目視確認し、チェックを入れて「決定・次へ」で承認してください。取得はまだ始まりません。',
    start: '承認済みです。本人が次の「決定・次へ」で取り込み開始を明示します。',
    inspect: state?.reason === 'black_image' ? errors.black_image : state?.readerReleasePending
      ? 'ブラウザの終了を確認できません。確定原本の点検後、「決定・次へ」でZIP保存できます。次の本には進めません。'
      : activeStage === 'review' && state?.job?.manifest.state === 'review'
      ? '画像の順序・採用・クロップを点検後、「決定・次へ」でZIP保存へ進みます。'
      : state?.lastFailure ? failureSummary(state.lastFailure)
        : '「決定・次へ」で確定画像を点検します。再開する場合は補助の画面選択から取り込みへ戻れます。',
    export: canonicalText($('exportHelp')),
  };
  $('nextAction').textContent = !enabled ? reason : guidance[action];

  const cancellationAvailable = capturing || Boolean(state?.pickingField) || cancelableOperation || localCancelableCount > 0;
  const backDisabled = !connectedNow || state?.endingBook || state?.recoveryRequired
    || busy && !cancellationAvailable || !hasJob && activeStage === 'setup';
  back.disabled = backDisabled;
  back.title = backDisabled
    ? state?.recoveryRequired ? '安全な終了を再試行してください。' : busy ? 'この処理は安全に中断できません。完了を待ってください。' : '戻る作業がありません。'
    : '確認中は結果を破棄して戻り、取得中は安全停止して点検へ戻ります。';
  finish.disabled = !connectedNow || !hasJob || Boolean(state?.endingBook) || Boolean(state?.storageUncertain);
  finish.title = !hasJob ? '現在は本の作業がありません。'
    : state?.endingBook ? '安全な停止・書込確定・資源解放を待っています。'
      : '画像・ZIP・設定・保存指定のprofileは保持します。一時profileだけは通常終了時に削除します。';
  $('reconnect').hidden = connectedNow;
}
function validStateLabel() {
  if (['Review', 'Paused', 'NeedsAttention', 'ResumeCheck'].includes(state?.state)) return states[state.state];
  if (displayedPreview && !configurationDirty && state?.previewReady) return states[state.state] ?? state.state;
   if (state?.displayInspection?.status === 'failed') return state.job?.manifest.images.length
     ? '今回の表示検査に失敗（保存済み画像は保持・ZIP保存可能）'
     : state.displayInspection.code === 'auth_or_overlay_detected' ? '認証・重なりの検査で停止（取得なし）' : 'プレビュー検査失敗（取得なし）';
  if (['Preview', 'Ready'].includes(state?.state)) return '指定変更・表示検査待ち（プレビュー・承認は無効）';
  if (state?.state !== 'AuthPending' || !state?.browserOpen) return states[state?.state] ?? state?.state ?? '';
  if (!state.selectedReaderTab || !state.readerTabConfirmed) return '対象タブ選択待ち（ログイン状態は未検査）';
  if (state.selectionFailure) return `${mappingLabels[state.selectionFailure.field] ?? '表示'}の検査失敗・再指定待ち`;
  return '対象タブ選択済み・表示検査待ち（認証は未検査）';
}
const headers = { Authorization: `Bearer ${token}` };
const states = { Idle: '待機', AuthPending: '手動ログイン・1冊選択待ち', ResumeCheck: '中断復帰：目視照合待ち', Preview: 'プレビュー確認待ち', Ready: '承認済み・明示開始待ち', Capturing: '取得中', Paused: '一時停止', NeedsAttention: '安全停止・確認が必要', Review: '画像点検' };
const errors = { end_candidate: '終端候補で停止。取得範囲を目視確認してください。', image_review_required: '白紙・重複候補を保持して停止。画像点検してください。', advance_uncertain: 'ページ送りが不明。自動再試行していません。', reader_configuration_required: '可視UIのCSS指定が必要です。', preview_confirmation_required: 'プレビューを確認し、チェックを入れてください。', resume_confirmation_required: '最後の確定画像と現在位置の目視照合が必要です。', explicit_start_required: 'プレビュー承認後に開始してください。', output_exists: '出力先に既存ファイルがあります。別名を指定してください。', operation_busy: '処理中です。一時停止・停止は使用できます。', job_busy: '別のプロセスがこの領域を使用中です。' };
Object.assign(errors, {
  linux_kindle_unsupported: 'Linuxでは実Kindleの起動・取得は未対応です。補助操作から自作試料を開いてください。',
  storage_durability_uncertain: '保存操作は適用済みの可能性があり、永続性を確認できません。取得・保存を停止しています。アプリを再起動し、保存領域を点検してください。',
  storage_reopen_required: '保存状態の確認が必要です。取得・保存は停止しています。アプリを再起動し、保存領域を点検してください。再起動だけで整合性が保証されるわけではありません。',
  output_path_changed: '出力先の経路が変化したため処理を停止しました。出力の成功と扱わず、自動で再出力・削除しません。再起動後に出力先と保存領域を点検してください。',
  output_published_durability_uncertain: '出力が公開済みの可能性がありますが、永続性は未確認です。自動で再出力・削除しません。再起動後に出力先と保存領域を点検してください。',
  output_published_manifest_update_failed: '出力済みですが保存履歴の記録に失敗しました。自動で再出力・削除しません。再起動後に出力先と保存領域を点検してください。',
  output_published_manifest_durability_uncertain: '出力済みですが保存履歴の永続性は未確認です。自動で再出力・削除しません。再起動後に出力先と保存領域を点検してください。',
  resume_position_required: '再開位置を確認できません。最後の確定画像の直後へ手動調整し、再プレビューしてください。',
  save_dialog_failed: '保存先ダイアログを開くか選択結果を受け取る処理に失敗しました。元の保存先は変更していません。手入力も利用できます。',
  save_dialog_unavailable: 'この環境では保存先ダイアログを利用できません。保存先を手入力してください。',
  book_identity_changed: '保存済み画像と現在の本の識別表示が異なります。この作業に別冊を追加せず、次の本は新しい作業で開いてください。',
  capture_in_progress: '取り込み・未確定画像の処理中です。「一時停止」してから保存してください。',
  empty_selection: '採用画像がありません。「画像を点検」で保存する画像を採用してください。',
  job_inconsistent: '保存済み画像に不整合があります。「画像を点検」で詳細を確認してください。原本と既存ZIPは変更していません。',
  reader_ui_unknown: '指定はありますが、現在の表示を検査できませんでした。取得は始めていません。以下の対象と理由を確認してください。',
  invalid_presets: 'プリセットを保存できません。名前と詳細指定の4項目を確認し、保存してください。既存定義は変更していません。',
  unsafe_presets: 'プリセット記録が安全な通常ファイルではありません。データは変更していません。保存領域を点検してください。',
  preset_changed: 'プリセットを変更したため、以前のプレビューと承認は無効です。新しい表示検査へ進んでください。',
  browser_target_changed: '対象の表示が変わりました。前のプレビューと承認は無効です。',
  reader_auto_ambiguous: '画面から必要な項目を一意に確認できませんでした。取得は始めていません。候補を減らすか、「自動判定できない場合（詳細指定）」から表示中の項目を選んでください。',
  capture_scale_unavailable: '画面密度をブラウザへ適用できませんでした。対象タブを選び直し、標準（1倍）でプレビューしてください。',
  capture_failed: '表示領域を画像にできませんでした。画面を表示したまま、もう一度プレビューしてください。',
  black_image: '読書領域の画像がほぼ黒いため、安全のため停止しました。この黒い画像は保存していません。次に、専用ブラウザでページ画像が実際に見えているか確認してください。表示が黒いままなら取得せず停止してください。',
  capture_resolution_exceeds_limit: '画像が16メガピクセルまたは32MiBの上限を超えます。画面密度を1倍にするか、表示範囲を狭めてください。',
  capture_dimensions_mismatch: 'プレビューと取得の画素寸法が一致しません。取得を停止しました。もう一度プレビューしてください。',
  spread_width_too_small: '左右分割には幅2px以上が必要です。クロップ幅を2px以上にしてやり直すか、「全原寸へ戻す」を押してください。',
  invalid_capture_settings: '取り込み設定を確認してください。',
  select_saved_session: '保存済みの専用領域が複数あります。「2 本を開く」の専用セッションから使う領域を選んでください。新しい領域も明示選択できます。',
  invalid_session_preferences: '専用領域の選択記録を読めません。データは削除していません。アプリの保存領域を点検してください。',
  unsafe_session_preferences: '専用領域の選択記録が安全な通常ファイルではありません。データは削除していません。',
  auth_or_overlay_detected: 'ログイン画面や別の表示が読書領域を覆っています。取得は始めていません。公式画面を確認し、表示を整えて再プレビューしてください。',
  reader_candidate_unavailable: '広げる候補がありません。読書領域を選び直してください。',
  reader_candidate_stale: '選んだ領域または対象画面が変わりました。領域を選び直してください。',
  reader_candidate_parent_not_rendered: '安全に選べる親の表示枠がありません。読書領域を別の見える位置から選び直してください。',
  window_not_available: '専用ブラウザの表示を確認できません。最小化を解除して読書画面を表示し、もう一度プレビューしてください。',
  display_or_position_unknown: '本・位置・読書領域の表示を確認できません。詳細指定から表示中の項目を選び直してください。',
  safe_stop_timeout: '安全停止の完了を期限内に確認できませんでした。新しい取り込み・保存を止めています。もう一度「終了・最初から」を押してください。',
  safe_stop_incomplete: '前の処理が資源を解放したか確認できません。新しい取り込み・保存はできません。安全な終了を再試行してください。',
  cancel_timeout: '取消処理の完了を確認できませんでした。状態を保全して停止しています。',
  safe_stop_failed: '安全な終了に失敗しました。画像と設定は保持しています。',
  reader_close_failed: 'ブラウザの終了を確認できません。書込停止済みで確定原本があれば点検・ZIP保存できます。次の本には進めません。',
  reader_release_incomplete: 'ブラウザ資源の解放を確認できません。確定原本があれば点検・ZIP保存できます。新しい作業には進めません。',
});
const failureStages = {
  capture: '画像取得', capture_begin: '保存準備', capture_upload: '画像転送',
  target_recheck_before_commit: '確定前の対象照合', capture_commit: '原本確定',
  image_review: '確定画像の点検', advance_preflight: '送り前の対象照合',
  advance_dispatch: 'ページ送りの送信', advance_confirmation: '送り後の位置・表示確認',
  advance_confirmed: '送り後の安定確認',
};
function errorDescription(code, acquisition = false) {
  const description = errors[code] ?? code ?? '処理に失敗しました。';
  // These common errors also occur after capture. Keep the initial-preview
  // guidance only when no originals exist and this is not an acquisition error.
  return acquisition || state?.job?.manifest.images.length
    ? description.replace('取得は始めていません。', '') : description;
}
function failureSummary(failure) {
  if (!failure) return '';
  if (state?.storageUncertain) return errorDescription(state.storageUncertain.code, true);
  const sent = { not_sent: '送信なし', sent: '送信済み', unknown: '送信結果不明（再送していません）' }[failure.advanceDispatch] ?? '送信状態不明';
  const field = failure.detail?.field ? ` / 対象：${mappingLabels[failure.detail.field] ?? '表示'}` : '';
  const cause = failure.detail?.cause ? ` / 理由：${failure.detail.cause}` : '';
  const code = failure.code ? ` / ${errorDescription(failure.code, true)}` : '';
  return `確定${failure.committedImages ?? 0}枚は保持。失敗段階：${failureStages[failure.stage] ?? failure.stage}${field}${cause}${code}。次への送り：${sent}。原本を点検・ZIP保存できます。再開時は最後の原本と現在位置を照合し、再プレビュー・再承認・別操作の明示開始が必要です。`;
}

function renderJobImages(s, generation) {
  if (s.state === 'Capturing') return;
  const manifest = s.job?.manifest;
  const key = JSON.stringify([s.job?.job_path, manifest?.state, manifest?.images, manifest?.selected_capture_ids]);
  if (key === lastImages) return;
  lastImages = key;
  const revision = ++imageRenderRevision;
  imageUrls.forEach(URL.revokeObjectURL); imageUrls = [];
  $('images').replaceChildren();
  $('order').value = manifest?.selected_capture_ids.join(',') ?? '';
  $('imageLoadStatus').textContent = manifest?.images?.length ? '確定画像を点検表示へ読み込んでいます。読み込み中も点検・ZIP・終了操作は待たせません。' : '';
  imageLoading = Boolean(manifest?.images?.length); updateOperationStatus();
  if (!manifest) return;
  const selected = manifest.selected_capture_ids;
  const ordered = [...selected.map(id => manifest.images.find(image => image.capture_id === id)),
    ...manifest.images.filter(image => !selected.includes(image.capture_id))];
  imageProgress = { done: 0, total: ordered.reduce((n, item) => n + (item.split ? 2 : 1), 0), unit: '点検画像の表示枚数', detail: '保存済み画像の読み込み・描画待ち（ZIP保存とは別処理）' };
  updateOperationStatus();
  const decoded = async img => {
    await img.decode();
    if (!isCurrent()) return;
    imageProgress.done += 1; updateOperationStatus();
  };
  const isCurrent = () => revision === imageRenderRevision && generation === interactionGeneration;
  void (async () => {
    for (const item of ordered) {
      let thumbnail;
      if (item.split) {
        thumbnail = document.createElement('div'); thumbnail.className = 'split-thumbnails';
        const first = item.split.first_page, sides = [first, first === 'right' ? 'left' : 'right'];
        for (const side of sides) {
          const img = document.createElement('img'); img.alt = `画像${item.capture_id} ${side === 'right' ? '右' : '左'}ページ`;
          const response = await api(`/api/image/${item.capture_id}?page=${side}`);
          const blob = await response.blob();
          if (!isCurrent()) return;
          const objectUrl = URL.createObjectURL(blob); imageUrls.push(objectUrl); img.src = objectUrl;
          thumbnail.append(img);
          await decoded(img);
        }
      } else {
        thumbnail = document.createElement('img'); thumbnail.alt = `画像${item.capture_id}`;
        const response = await api(`/api/image/${item.capture_id}`);
        const blob = await response.blob();
        if (!isCurrent()) return;
        const objectUrl = URL.createObjectURL(blob); imageUrls.push(objectUrl); thumbnail.src = objectUrl;
        await decoded(thumbnail);
      }
      if (!isCurrent()) return;
      const label = document.createElement('p');
      const outputSize = item.crop ? `${item.crop.width}×${item.crop.height}` : `${item.width}×${item.height}`;
      const outputUnit = item.split ? `右左順 ${item.split.first_page === 'right' ? '右→左' : '左→右'}・${item.split.left.width}×${item.split.left.height} + ${item.split.right.width}×${item.split.right.height}` : '1枚';
      label.textContent = `ID ${item.capture_id} / 元${item.image_format === 'jpeg' ? 'JPEG' : 'PNG'} ${item.width}×${item.height} px / 出力 ${outputUnit} / ${item.capture_scale}倍 / ${selected.includes(item.capture_id) ? '採用' : '除外（原本保持）'}`;
      const flag = document.createElement('p'); flag.textContent = [item.blank_candidate && '白紙候補', item.duplicate_candidate && '重複候補', item.crop && 'クロップあり'].filter(Boolean).join(' / ');
      const inspect = document.createElement('button'); inspect.textContent = '原本を点検・クロップ';
      inspect.onclick = () => run(async () => {
        const revision = ++cropSelectionRevision; clearAutoCrop();
        $('cropId').value = item.capture_id; $('cropX').value = 0; $('cropY').value = 0;
        $('cropWidth').value = item.width; $('cropHeight').value = item.height;
        await png(`/api/image/${item.capture_id}?original=1`, $('inspectImage'), interactionGeneration, undefined,
          () => revision === cropSelectionRevision && Number($('cropId').value) === item.capture_id);
        $('inspectCaption').textContent = '原本'; $('inspectImage').alt = '選択した原本';
      }, false, '原本を点検表示');
      const position = selected.indexOf(item.capture_id);
      const card = document.createElement('article');
      card.dataset.split = String(Boolean(item.split)); card.dataset.captureId = item.capture_id;
      card.append(thumbnail, label, flag, inspect);
      const layout = document.createElement('select');
      layout.setAttribute('aria-label', 'この画像の保存単位');
      for (const [value, text] of [['single', '1枚のまま'], ['right', '2枚：右→左'], ['left', '2枚：左→右']]) layout.add(new Option(text, value));
      layout.value = item.split ? item.split.first_page : 'single';
      layout.disabled = manifest.state !== 'review';
      layout.addEventListener('change', async () => {
        const choice = layout.value;
        layout.disabled = true;
        await run(() => command('setPageLayout', { id: item.capture_id,
          mode: choice === 'single' ? 'single_image' : 'split_spread', firstPage: choice === 'single' ? 'right' : choice }));
        const latest = state?.job?.manifest.images.find(image => image.capture_id === item.capture_id);
        layout.value = latest?.split ? latest.split.first_page : 'single';
        layout.disabled = state?.job?.manifest.state !== 'review';
      });
      card.append(layout);
      for (const [text, delta] of [['前へ', -1], ['後へ', 1]]) {
        const move = document.createElement('button'); move.textContent = text;
        move.disabled = position < 0 || position + delta < 0 || position + delta >= selected.length;
        move.onclick = () => run(async () => {
          const ids = [...state.job.manifest.selected_capture_ids]; const index = ids.indexOf(item.capture_id);
          if (index < 0 || index + delta < 0 || index + delta >= ids.length) return;
          [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
          await command('review', { ids });
        }); card.append(move);
      }
      const toggle = document.createElement('button'); toggle.textContent = position < 0 ? '採用する' : '除外する';
      toggle.onclick = () => run(() => command('review', { ids: position < 0 ? [...state.job.manifest.selected_capture_ids, item.capture_id] : state.job.manifest.selected_capture_ids.filter(id => id !== item.capture_id) }));
      card.append(toggle); $('images').append(card);
    }
     if (isCurrent()) { $('imageLoadStatus').textContent = ''; if (!pendingActions && !state?.busy && activeStage === 'review') { operationProgress = { ...imageProgress, detail: '点検画像の表示完了' }; operationOutcome = 'success'; operationLabel = '確定画像を点検表示'; } }
  })().catch(error => {
    if (!isCurrent() || error.code === 'ui_superseded') return;
    $('imageLoadStatus').textContent = '一部の点検画像を画面表示できませんでした。保存済み原本は変更していません。画像表示の失敗はZIP再読検証とは別です。';
    $('message').textContent = error.message;
     if (!pendingActions && !state?.busy && activeStage === 'review') { operationProgress = { ...imageProgress, detail: '画像表示に失敗。原本は保持しています' }; operationOutcome = 'failure'; operationLabel = '確定画像を点検表示'; }
    maybeScrollWorkflow();
  }).finally(() => { if (isCurrent()) { imageLoading = false; updateOperationStatus(); } });
}
errors.authorization_required = '操作画面の接続キーが一致しません。Kindleの認証とは別です。アプリが新しく開いた操作画面を使ってください。';
errors.auto_crop_stale = '画像またはクロップが変わりました。候補を再検出してください。';
errors.select_reader_tab = '対象の専用タブを選び「このタブを対象にする」を押してから、指定をやり直してください。本棚を閉じる必要はありません。';
errors.invalid_reader_tab = '選んだタブは閉じたか、対象のKindle画面ではなくなりました。現在の一覧から選び直してください。';
errors.invalid_kindle_region = '一覧にあるKindle利用地域を選んでください。';
errors.kindle_region_changed = '利用地域が変わりました。対象タブを選び、再プレビュー・承認してください。';
errors.reader_library_selected = '対象は読書画面ではなくライブラリです。本が別の専用タブで開いている場合は、そのタブを対象にしてください。4項目の再指定は不要です。別の本への自動切替・取得は行っていません。';
async function api(url, options = {}) {
  const generation = interactionGeneration;
  let response;
  try { response = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, cache: 'no-store' }); }
  catch {
    requireCurrent(generation);
    connected = false; clearPreview(); mappingStatus();
    throw new Error('アプリに接続できません。再起動後は新しく開いた操作画面を使ってください。');
  }
  requireCurrent(generation);
  connected = true;
  if (!response.ok) {
    const data = await response.json();
    requireCurrent(generation);
    if (data.code === 'authorization_required') { connected = false; clearPreview(); mappingStatus(); }
    const label = mappingLabels[data.detail?.field];
    const detail = label && failureLabels[data.detail?.cause] ? `（${label}：${failureLabels[data.detail.cause]} / ${data.detail.cause}）` : '';
    const stage = ['auto_visibility_wait', 'preview_visibility_wait', 'reader_target_check'].includes(data.stage) ? ` [${data.stage}]` : '';
    const observation = ['not_preset', 'auth_visible', 'markers_not_unique', 'no_handles', 'region_hidden', 'not_shared', 'next_direction', 'no_surface', 'hit_blocked', 'dispatched'].includes(data.recoveryObservation) ? ` [recovery:${data.recoveryObservation}]` : '';
    const error = new Error((errors[data.code] ? errorDescription(data.code) : `処理できませんでした：${data.code}`) + detail + stage + observation + (remedies[data.detail?.cause] ? `\n${remedies[data.detail.cause]}` : ''));
    error.code = data.code; error.detail = data.detail;
    throw error;
  }
  return response;
}
function requirePreview(revision, configRevision) {
  if (!state?.previewReady || state.operationRevision !== revision
    || configRevision !== undefined && configRevision !== configurationRevision) throw superseded();
}
async function png(url, image, generation = interactionGeneration, previewRevision, validSelection) {
   expectedProgressKey = null;
   const preview = previewRevision !== undefined;
   const showing = detail => {
     if (preview && operationProgress.total) {
       operationProgress = { ...operationProgress, done: operationProgress.total - 1, detail };
       updateOperationStatus();
     } else localProgress(0, 1, '表示対象画像', detail);
   };
   showing('画像の応答・復号待ち');
  const data = await (await api(url)).blob();
  requireCurrent(generation); if (validSelection && !validSelection()) throw superseded();
   showing('画像受信完了。画素の復号待ち');
  if (previewRevision !== undefined) requirePreview(previewRevision);
  if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
  image.dataset.objectUrl = URL.createObjectURL(data);
  image.src = image.dataset.objectUrl;
  await image.decode();
  requireCurrent(generation); if (validSelection && !validSelection()) { image.hidden = true; throw superseded(); }
  if (previewRevision !== undefined) requirePreview(previewRevision);
  image.hidden = false;
   showing('画素の復号完了。画面への反映待ち');
}
async function renderPreviewOutput(configRevision) {
  const generation = interactionGeneration;
  const revision = state.operationRevision;
  const source = $('previewImage');
  await source.decode();
  requireCurrent(generation);
  requirePreview(revision, configRevision);
  const resume = state.resumePlan;
  if (resume) {
    await png(`/api/image/${resume.lastCaptureId}?original=1`, $('resumeImage'), generation, revision);
    requirePreview(revision, configRevision);
    $('resumeStatus').textContent = `確定画像 #${resume.lastCaptureId}：${resume.lastPosition ?? '位置記録なし'} ／ 現在：${resume.currentPosition}。`;
    $('resumeStatus').append(document.createTextNode(resume.mode === 'advance'
      ? '最後の確定位置と一致・送り未送信。画像を目視照合してください。明示開始後、重複保存せず1回送って続けます。'
      : resume.mode === 'capture' ? '明示開始後、現在の未取得位置から保存します。送りの再送はしません。'
      : 'この位置では再開できません。送り済み・不明、または画像と位置の照合不一致です。最後の確定画像の直後へ手動調整し、再プレビューしてください。'));
  }
  const width = source.naturalWidth, height = source.naturalHeight;
  const info = state?.previewInfo;
  const css = info?.cssDimensions ?? [0, 0];
  const singlePage = info?.layout === 'single_page';
  const split = info?.pageOutputMode === 'split_spread' && !singlePage;
  $('previewInfo').textContent = `表示範囲 ${Math.round(css[0])}×${Math.round(css[1])} CSS px → 元${info?.imageFormat === 'jpeg' ? 'JPEG' : 'PNG'} ${width}×${height} px（画面密度 ${info?.deviceScaleFactor ?? 1}倍）${split ? `。分割境界 x=${Math.floor(width / 2)} px、出力は ${info?.readingDirection === 'left_to_right' ? '左→右' : '右→左'}。` : '。出力は表示範囲の1枚です。'}`;
  // Decode and inspect only in this local tab; never serialize pixels or labels.
  const probe = document.createElement('canvas'); probe.width = 32; probe.height = 32;
  const probeContext = probe.getContext('2d');
  probeContext.drawImage(source, width / 4, height / 4, width / 2, height / 2, 0, 0, 32, 32);
  const pixels = probeContext.getImageData(0, 0, 32, 32).data;
  let minimum = 255, maximum = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const light = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
    minimum = Math.min(minimum, light); maximum = Math.max(maximum, light);
  }
  $('previewInfo').textContent += ` 中央画素：${maximum - minimum > 12 ? '非単色' : '単色（要確認）'}・${maximum > 16 ? '黒一色ではない' : 'ほぼ黒（要確認）'}。`;
  if (['identity', 'position', 'next'].includes(info?.recovery?.initialHiddenField)
    && info?.recovery?.observation === 'dispatched') $('previewInfo').textContent += ` 初期非表示からのDOM復帰：${info.recovery.initialHiddenField}。`;
  if (singlePage && info?.pageOutputMode === 'split_spread') $('previewInfo').textContent += ' 単ページの有効領域を検出したため、表紙・単ページは分割せず1枚で保持します。';
  previewPageUrls.forEach(URL.revokeObjectURL); previewPageUrls = [];
  const container = $('previewPages'); container.replaceChildren();
  if (!split) return;
  const boundary = Math.floor(width / 2);
  if (boundary < 1 || width - boundary < 1) throw new Error('分割できる幅がありません。1枚保存に戻してください。');
  const sides = info.readingDirection === 'left_to_right'
    ? [['left', 0, boundary], ['right', boundary, width - boundary]]
    : [['right', boundary, width - boundary], ['left', 0, boundary]];
  for (const [index, [side, x, pageWidth]] of sides.entries()) {
    const canvas = document.createElement('canvas'); canvas.width = pageWidth; canvas.height = height;
    canvas.getContext('2d').drawImage(source, x, 0, pageWidth, height, 0, 0, pageWidth, height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    requireCurrent(generation);
    requirePreview(revision, configRevision);
    if (!blob) throw new Error('分割プレビューを作れませんでした。1枚保存に戻してください。');
    const url = URL.createObjectURL(blob); previewPageUrls.push(url);
    const figure = document.createElement('figure');
    const image = document.createElement('img'); image.src = url; image.alt = `${side === 'right' ? '右' : '左'}ページの保存プレビュー`;
    const caption = document.createElement('figcaption');
    caption.textContent = `${index + 1}枚目：${side === 'right' ? '右ページ' : '左ページ'} ${pageWidth}×${height} px`;
    figure.append(image, caption); container.append(figure);
  }
  const odd = width % 2 === 1;
  if (odd) $('previewInfo').textContent = canonicalText($('previewInfo')) + ` 元画像は奇数幅のため、中央の境界は x=${boundary} px（右側を1 px広く）です。`;
}
async function command(action, input = {}) {
   const progressKey = crypto.randomUUID();
   expectedProgressKey = progressKey;
    localProgress(0, null, '現在の処理', '総量の確認・処理要求の応答待ち');
   if (pendingActions) { operationLabel = operationLabels[action] ?? operationLabel; updateOperationStatus(); }
   const generation = interactionGeneration;
   const revision = configurationRevision;
  // A poll begun before/during this operation must not erase its new preview
  // with an older snapshot after the PNG has already been decoded.
  stateRequestGeneration += 1;
  if (['start', 'review', 'crop', 'resetCrop', 'applyAutoCrop', 'create', 'recover', 'closeJob', 'finishBook'].includes(action)) $('exportResult').textContent = '';
  try {
      const response = await api('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input: { ...input, progressKey, language: currentLanguage() } }) });
      const result = await response.json();
      requireCurrent(generation);
       if (action !== 'start') {
         expectedProgressKey = null;
         if (result.operationProgress?.key === progressKey) operationProgress = result.operationProgress;
       }
     if (['preview', 'quickPreview', 'approve', 'start'].includes(action) && revision !== configurationRevision) throw superseded();
     await render(result, generation);
     requireCurrent(generation);
    return result;
  } finally { stateRequestGeneration += 1; }
}
async function run(callback, cancelable = false, label = '操作を反映') {
    const generation = interactionGeneration;
    const stageBefore = activeStage;
    pendingByGeneration.set(generation, (pendingByGeneration.get(generation) ?? 0) + 1);
    if (cancelable) localCancelableCount += 1;
     operationLabel = label; operationOutcome = 'idle';
     expectedProgressKey = null;
      operationProgress = { done: 0, total: null, unit: '現在の処理', detail: '総量の確認・処理開始待ち' };
    pendingActions = pendingByGeneration.get(generation); mappingStatus();
    $('message').textContent = '処理中…';
    try {
      await paintOperation();
      requireCurrent(generation);
      const result = await callback();
      if (generation === interactionGeneration) {
        $('message').textContent = typeof result === 'string' ? result : result?.message ?? (result?.cancelled ? '保存先の選択を取り消しました。保存先は変更していません。' : '操作を反映しました。');
         operationOutcome = result?.cancelled || operationLabel === operationLabels.cancelBack ? 'cancelled' : 'success';
           if (operationOutcome === 'success' && activeStage !== stageBefore && !operationProgress.action) {
             // Navigation alone has not completed any work in the new step.
             operationOutcome = 'idle';
             operationProgress = { done: 0, total: null, unit: '現在ステップ', detail: '操作待ち' };
           } else if (operationOutcome === 'success' && !state?.busy) operationProgress = { ...operationProgress, total: operationProgress.total ?? 1, done: operationProgress.total ?? 1, detail: '処理完了' };
        maybeScrollWorkflow();
      }
    }
    catch (e) {
      if (generation === interactionGeneration) {
        operationOutcome = ['ui_superseded', 'picker_cancelled', 'cancelled'].includes(e.code) ? 'cancelled' : 'failure';
        $('message').textContent = e.code === 'ui_superseded' ? '設定が変わったため、以前の検査結果は破棄しました。新しい条件でプレビューしてください。'
          : e.code === 'picker_cancelled' ? '指定を取り消しました。完了した項目は保持しています。' : e.message;
        maybeScrollWorkflow();
        if (e.code !== 'ui_superseded') await poll();
      }
    }
    finally {
      const remaining = pendingByGeneration.get(generation) - 1;
      if (remaining) pendingByGeneration.set(generation, remaining); else pendingByGeneration.delete(generation);
      if (generation === interactionGeneration) {
        if (cancelable) localCancelableCount -= 1;
        pendingActions = remaining; mappingStatus();
      }
    }
}
function click(id, callback) { $(id).addEventListener('click', () => {
  const cancelable = ['quickPreview', 'preview', 'pickAll', 'expandReader', ...Object.values(pickIds)].includes(id)
    || id === 'decisionButton' && $('decisionButton').dataset.action === 'preview';
  if (id === 'cancelBackButton') cancellingInspection = localCancelableCount > 0;
  if (['cancelBackButton', 'finishBookButton', 'cancelPick'].includes(id)) supersedeInteraction();
  const label = id === 'decisionButton' ? operationLabels[$('decisionButton').dataset.action] : canonicalText($(id));
  return run(callback, cancelable || id === 'chooseDestination', label);
}); }
const previousStage = { setup: null, browser: 'setup', capture: 'browser', review: 'capture', export: 'review' };
async function saveCurrentExport() {
  $('exportResult').textContent = '';
  const result = await command('export', { destination: $('destination').value, format: $('format').value,
    rangeConfirmed: $('rangeConfirmed').checked, warningsAccepted: $('warningsAccepted').checked });
   $('exportResult').textContent = `保存・再読検証済み\n保存先：${result.lastExport.destination}\n画像：${result.lastExport.entry_count}枚`;
   $('exportResult').dataset.destination = result.lastExport.destination;
  mappingStatus();
  return 'ZIPを検証して保存しました。保存場所はここに表示しています。';
}
async function advanceFlow() {
  if (!connected) { await poll(); return 'アプリとの接続を確認しました。'; }
  if (state?.recoveryRequired) throw Object.assign(new Error(errors.safe_stop_incomplete), { code: 'safe_stop_incomplete' });
   if (!state?.job) {
    await command('create', { baseDir: $('baseDir').value });
    return '作業を用意しました。本人が次に専用ブラウザを開きます。';
  }
   if (activeStage === 'export') {
    if ($('exportResult').textContent && $('exportResult').dataset.destination === $('destination').value) {
      throw new Error('この保存先への保存は完了しています。別名を指定するか「終了・最初から」で次の本へ進んでください。');
    }
    return saveCurrentExport();
  }
   if (activeStage === 'review' || state.job.manifest.images.length && (!state.browserOpen
     || !captureIntent && ['Review', 'Paused', 'NeedsAttention'].includes(state.state))) {
     if (activeStage !== 'review' || state.job.manifest.state !== 'review') {
       await command('review'); stage('review');
       return '確定画像の点検を表示しました。確認後、もう一度「決定・次へ」を押してください。';
     }
     stage('export'); mappingStatus(); return 'ZIP保存を表示しました。保存先を確認し、もう一度「決定・次へ」を押してください。';
  }
   if (!state.browserOpen) {
    await command('openBrowser', { mode: 'kindle', keep: $('keep').checked, session: $('keep').checked ? $('session').value : 'new' });
    return '専用ブラウザを開きました。本人がログインし、1冊を開いてください。';
   }
   if (['setup', 'browser'].includes(activeStage)) {
     stage('capture'); mappingStatus();
     return '対象タブとプリセットを表示しました。次の「決定・次へ」で確定・検査します。';
   }
  if (state.state === 'Capturing') throw Object.assign(new Error('取り込み中です。「キャンセル・前へ」で安全停止できます。'), { code: 'operation_busy' });
   if (!state.selectedReaderTab || !state.readerTabConfirmed || $('readerTab').value !== state.selectedReaderTab) {
    if (!$('readerTab').value) throw new Error('対象の専用タブを選んでから進んでください。');
    await command('selectReaderTab', { id: $('readerTab').value });
    stage('capture');
    return '対象タブを選びました。Kindleプリセットを選んで次へ進んでください。';
  }
  const validPreview = displayedPreview && !configurationDirty && state.previewReady;
  if (validPreview) {
    if (!state.previewApproved || state.state !== 'Ready') {
      if (!$('previewConfirmed').checked) throw new Error('プレビューで本・範囲・位置を確認し、チェックを入れてください。');
      if (needsResumeConfirmation() && !$('resumeConfirmed').checked) throw new Error('最後の確定画像と現在位置を照合したチェックが必要です。');
      await command('approve', { confirmed: true, resumeConfirmed: $('resumeConfirmed').checked });
      return 'プレビューを承認しました。次の「決定・次へ」は本人の明示開始です。';
    }
    await command('start', { confirmed: true });
    return '本人が取り込み開始を明示しました。安全条件に達すると自動で停止します。';
  }
   stage('capture');
  const complete = ['reader', 'identity', 'position', 'next'].every(field => $(field).value.trim());
  if (complete && $('manualOptions').open) return previewCurrent();
   clearPreview();
   const generation = interactionGeneration;
  const revision = configurationRevision;
  await command('quickPreview', { mode: $('presetMode').value, config: $('presetMode').value === 'selectors'
    ? { ...Object.fromEntries(['frame', 'reader', 'next', 'identity', 'position'].map(k => [k, $(k).value])), frames: frameMappings } : undefined });
  if (revision !== configurationRevision) return '設定が変わったため、プレビューを無効にしました。';
   const previewRevision = state.operationRevision;
   await png('/api/preview', $('previewImage'), generation, previewRevision);
  if (revision !== configurationRevision) { clearPreview(); return '設定が変わったため、プレビューを無効にしました。'; }
    await renderPreviewOutput(revision);
    requireCurrent(generation);
    requirePreview(previewRevision, revision);
  displayedPreview = true; configurationDirty = false; $('previewPlaceholder').hidden = true;
  mappingStatus();
  return 'プレビューを表示しました。本・範囲・出力ページを確認してください。取得はまだ始まりません。';
}
async function resetChoice() {
  const prepared = await command('prepareReset');
  localProgress(0, null, 'リセットの判断待ち', '現在画像の確認完了。本人の「削除・残す・取消」の選択待ち');
  const dialog = $('resetDialog');
  $('resetScope').textContent = `現在の作業：取得原本 ${prepared.job.manifest.images.length}枚（採用 ${prepared.job.manifest.selected_capture_ids.length}枚・除外 ${prepared.job.manifest.excluded_capture_ids.length}枚）。`;
  const choice = await new Promise(resolve => {
    const finish = value => { dialog.close(); resolve(value); };
    $('resetConfirm').onclick = () => finish('reset');
    $('resetKeep').onclick = () => finish('keep');
    $('resetCancel').onclick = () => finish('cancel');
    dialog.oncancel = event => { event.preventDefault(); finish('cancel'); };
    dialog.showModal();
    $('resetCancel').focus({ preventScroll: true });
  });
  if (choice === 'reset') {
    await command('resetImages', { token: prepared.resetToken, confirmed: true });
    displayedPreview = false; captureIntent = false;
    $('previewConfirmed').checked = false; $('resumeConfirmed').checked = false;
    $('exportResult').textContent = '';
    stage('capture');
  } else await command('cancelReset', { token: prepared.resetToken });
  return choice;
}
async function cancelBackFlow() {
  const stageBefore = activeStage;
  const capturing = state?.state === 'Capturing';
  const selecting = Boolean(state?.pickingField);
  const inspecting = cancellingInspection || ['preview', 'quickPreview', 'pick', 'pickAll', 'expandReader', 'selectReaderTab'].includes(state?.activeOperation);
  cancellingInspection = false;
   await command('cancelBack');
   if (state?.job?.manifest?.images?.length || state?.job?.manifest?.reset_files?.length) {
     const choice = await resetChoice();
      if (choice === 'cancel') return { cancelled: true, message: '戻る操作を取り消しました。画像は保持しています。' };
     if (choice === 'reset') return '取得画像をリセットしました。現在の読書位置を確認し、新しくプレビュー・承認してから明示的に開始してください。';
   }
   if (capturing) { captureIntent = false; stage('review'); return '安全停止が完了しました。確定画像は保持しています。'; }
   if (selecting || inspecting) {
     if (stageBefore === 'capture' && activeStage === stageBefore) stage('browser');
     return '確認中の処理を取り消して前へ戻りました。';
   }
   if (activeStage === stageBefore && previousStage[stageBefore]) { stage(previousStage[stageBefore]); captureIntent = activeStage === 'capture'; }
  return '前の画面へ戻りました。保存済みデータは保持しています。';
}
async function finishBookFlow() {
  const hadImages = Boolean(state?.job?.manifest?.images?.length);
   await command('finishBook');
   captureIntent = false;
  stage('setup');
   return hadImages ? 'この本の作業を閉じました。確定画像・ZIP・設定・保存指定のprofileは保持しました。一時profileは削除しました。次の本を用意できます。'
     : 'この本の作業を閉じました。設定と保存指定のprofileは保持し、一時profileは削除しました。次の本を用意できます。';
}
function ids() { return $('order').value.split(',').filter(v => v.trim()).map(v => Number(v.trim())); }
function render(s, generation = interactionGeneration) {
  const next = rendering.then(() => { requireCurrent(generation); return draw(s, generation); });
  rendering = next.catch(() => {});
  return next;
}
async function draw(s, generation) {
  if (s.operationRevision < (state?.operationRevision ?? -1)) throw superseded();
  state = s;
  if (autoCropCandidate) {
    const manifest = s.job?.manifest;
    const item = manifest?.images.find(image => image.capture_id === autoCropCandidate.capture_id);
    if (manifest?.job_id !== autoCropCandidate.job_id || manifest.next_render_version !== autoCropCandidate.render_version
      || item?.sha256 !== autoCropCandidate.original_sha256 || (item?.crop?.version ?? null) !== autoCropCandidate.crop_version
      || Number($('cropId').value) !== autoCropCandidate.capture_id) {
      clearAutoCrop('画像またはクロップが変わりました。候補を再検出してください。');
    }
  }
  if (!pendingActions && s.operationProgress?.key === expectedProgressKey && s.operationProgress?.action === 'start') {
    operationProgress = s.operationProgress;
    if (!s.busy) operationOutcome = operationProgress.status;
  }
  const jobPath = s.job?.job_path ?? null;
  const m = s.job?.manifest;
  // Save drafts belong to one job, not to a browser or a polling snapshot.
  // A new/recovered job starts at its own ZIP destination; same-job polling
  // must leave the user's chosen name, format and optional confirmation alone.
  if (jobPath !== exportJobPath) {
    destinationDirty = false; destinationRevision += 1;
    exportJobPath = jobPath;
    $('destination').value = s.suggestedDestination ?? '';
    $('format').value = 'zip';
    $('export').textContent = 'ZIPを検証して保存';
    $('warningsAccepted').checked = false;
    rangeConfirmationDirty = false;
    $('exportResult').textContent = '';
  }
  if (!destinationDirty) $('destination').value = (s.suggestedDestination ?? '').replace(/\.(zip|cbz)$/i, `.${$('format').value}`);
  const confirmedRange = m?.range_confirmed === true;
  if (!rangeConfirmationDirty || $('rangeConfirmed').checked === confirmedRange) {
    $('rangeConfirmed').checked = confirmedRange;
    rangeConfirmationDirty = false;
  }
  const contentKey = JSON.stringify([jobPath, m?.images, m?.selected_capture_ids, confirmedRange]);
  if (contentKey !== exportContentKey) {
    exportContentKey = contentKey;
    $('exportResult').textContent = '';
  }
  if (s.presets && JSON.stringify(s.presets) !== presetKey) {
    presetKey = JSON.stringify(s.presets);
    $('preset').replaceChildren(...s.presets.presets.map(p => new Option(p.name, p.id)));
    $('preset').value = s.presets.selected;
    const selected = s.presets.presets.find(p => p.id === s.presets.selected);
    if (presetEditorKey !== JSON.stringify(selected)) {
      presetEditorKey = JSON.stringify(selected);
      $('presetName').value = selected.name; $('presetMode').value = selected.mode;
    }
  }
  connected = true;
  pickerStage = s.pickerStage;
  // Polling a safety stop must not steal the user's chosen save panel.
  // Navigate automatically only when the workspace/browser changes, or when
  // an explicit stop/review enters the review stage.
  const flow = `${Boolean(s.browserOpen)}:${s.job?.job_path ?? ''}`;
  if (flow !== previousFlow) {
    previousFlow = flow;
    stage(!s.job ? 'setup' : s.state === 'Review' ? 'review' : !s.browserOpen && s.job.manifest.images.length ? 'review' : !s.browserOpen ? 'browser' : 'capture');
  } else if (s.state === 'Review' && previousState !== 'Review' && activeStage !== 'export') stage('review');
  previousState = s.state;
  if (s.browserId !== lastBrowserId) {
    lastBrowserId = s.browserId; lastMappingRevision = undefined; lastTabRevision = undefined; backendMappings = {}; frameMappings = {};
    for (const field of Object.keys(mappingLabels)) $(field).value = '';
    $('frame').value = ''; clearPreview();
  }
  if (s.readerTabRevision !== lastTabRevision) {
    lastTabRevision = s.readerTabRevision; lastMappingRevision = undefined; backendMappings = {}; frameMappings = {};
    for (const field of Object.keys(mappingLabels)) $(field).value = '';
    $('frame').value = ''; clearPreview();
  }
  if (s.mappingRevision !== lastMappingRevision) {
    for (const field of Object.keys(mappingLabels)) {
      const value = s.mappings?.[field];
      if (JSON.stringify(value) !== JSON.stringify(backendMappings[field])) {
        $(field).value = value?.selector ?? '';
        if (value) frameMappings[field] = value.frame;
        else delete frameMappings[field];
      }
    }
    backendMappings = s.mappings ?? {}; lastMappingRevision = s.mappingRevision;
  }
  const selectedPreset = s.presets?.presets.find(p => p.id === s.presets.selected);
  const configurationKey = JSON.stringify([selectedPreset, s.browserId, s.readerTabRevision]);
  if (configurationKey !== presetConfigurationKey) {
    presetConfigurationKey = configurationKey;
    if (selectedPreset?.mode === 'selectors') {
      for (const field of ['frame', 'reader', 'identity', 'position', 'next']) $(field).value = selectedPreset.config[field];
      frameMappings = { ...selectedPreset.config.frames };
    }
  }
  if (s.job && s.captureSettings) {
    const settingsKey = JSON.stringify(s.captureSettings);
    if (!settingsApplying && settingsKey !== lastSettingsKey) {
      $('captureScale').value = String(s.captureSettings.capture_scale);
      $('pageOutputMode').value = s.captureSettings.page_output_mode;
      $('readingDirection').value = s.captureSettings.reading_direction;
      $('imageFormat').value = s.captureSettings.image_format ?? 'png';
      $('jpegQuality').value = String(s.captureSettings.jpeg_quality ?? 85);
      lastSettingsKey = settingsKey;
    }
  } else if (!s.job) {
    $('captureScale').value = '2'; $('pageOutputMode').value = 'single_image'; $('readingDirection').value = 'right_to_left';
    $('imageFormat').value = 'png'; $('jpegQuality').value = '85';
    lastSettingsKey = undefined;
  }
  if (!s.previewReady) clearPreview();
  const tabKey = JSON.stringify([s.readerTabs, s.selectedReaderTab]);
  if ($('readerTab').dataset.key !== tabKey) {
    const draft = $('readerTab').value;
    $('readerTab').replaceChildren(new Option('対象タブを選択', ''));
    for (const tab of s.readerTabs ?? []) $('readerTab').append(new Option(tab.label, tab.id));
    $('readerTab').value = s.selectedReaderTab ?? ((s.readerTabs ?? []).some(tab => tab.id === draft) ? draft : '');
    $('readerTab').dataset.key = tabKey;
  }
  $('state').textContent = states[s.state] ?? s.state;
  $('reason').textContent = s.reason ? errorDescription(s.reason) : '';
  const failureKey = JSON.stringify(s.lastFailure ?? null);
  if (failureKey !== lastFailureKey) {
    lastFailureKey = failureKey;
    if (s.lastFailure && !pendingActions && !s.busy) {
      captureIntent = false;
      $('message').textContent = failureSummary(s.lastFailure);
    }
  }
  if (!pendingActions && !s.busy && s.state === 'NeedsAttention' && s.reason === 'black_image') $('message').textContent = errors.black_image;
  $('jobPath').textContent = s.job ? `中断復帰用フォルダ：${s.job.job_path}` : '';
  $('issues').textContent = s.job ? `不整合：${s.job.issues.join(' / ') || 'なし'}\n孤立・未確定ファイル（無断削除しません）：${s.job.orphan_files.join(' / ') || 'なし'}` : '';
  $('pause').disabled = s.state !== 'Capturing';
  $('stop').disabled = !s.job || Boolean(s.storageUncertain);
  $('create').disabled = Boolean(s.job);
  $('recover').disabled = Boolean(s.job);
  $('openKindle').disabled = !s.job || s.browserOpen || s.readerReleasePending || s.kindleSupported === false || Boolean(s.storageUncertain);
  $('kindleUnsupported').hidden = s.kindleSupported !== false;
  $('storageUncertain').hidden = !s.storageUncertain;
  $('storageUncertain').textContent = s.storageUncertain
    ? `${errorDescription(s.storageUncertain.code)}${s.storageUncertain.destination ? `\n保存先：${s.storageUncertain.destination}` : ''}\n${errors.storage_reopen_required}` : '';
  const regionKey = JSON.stringify(s.kindleRegions);
  if ($('kindleRegion').dataset.key !== regionKey) {
    $('kindleRegion').replaceChildren(...(s.kindleRegions ?? []).map(region => new Option(region.label, region.id)));
    $('kindleRegion').dataset.key = regionKey;
  }
  $('kindleRegion').value = s.kindleRegion;
  $('kindleRegion').disabled = s.browserOpen || s.readerReleasePending || s.busy || pendingActions > 0;
  $('kindleStartUrl').textContent = s.kindleRegions?.find(region => region.id === s.kindleRegion)?.startUrl ?? '';
  $('openSample').disabled = !s.job || s.browserOpen || s.readerReleasePending || Boolean(s.storageUncertain);
  $('closeBrowser').disabled = !s.browserOpen;
  mappingStatus();
  const sessionKey = JSON.stringify([s.sessions, s.browserOpen, s.readerReleasePending]);
  if ($('sessions').dataset.key !== sessionKey) {
    $('sessions').dataset.key = sessionKey;
    $('sessions').replaceChildren();
    const selectedSession = $('session').value;
    $('session').replaceChildren(new Option('前回の専用領域を再利用（なければ新規）', ''), new Option('新しい専用領域', 'new'));
    for (const session of s.sessions) {
      $('session').append(new Option(`${session.saved ? '保存済み' : '中断した一時領域'}：${session.id}`, session.id));
      const li = document.createElement('li');
      li.textContent = `${session.saved ? '保存済み' : '一時・残存'}：${session.id} `;
      const button = document.createElement('button');
      button.textContent = 'この専用セッションを削除';
      button.disabled = Boolean(s.browserOpen || s.readerReleasePending);
      button.onclick = async () => {
        if (!confirm(translate('取得を停止して専用ブラウザを閉じた後、この専用セッションだけを削除します。よろしいですか？'))) return;
        await run(() => command('deleteSession', { id: session.id, confirmed: true }), false, '専用セッションを削除');
      };
      li.append(button); $('sessions').append(li);
    }
    if ([...$('session').options].some(option => option.value === selectedSession)) $('session').value = selectedSession;
  }
  $('counts').textContent = m ? `確定 ${m.images.length}枚 / 採用 ${m.selected_capture_ids.length}枚 / 原本 ${m.images.reduce((n, i) => n + i.bytes, 0).toLocaleString()} bytes / 範囲${m.range_confirmed ? '確認済み' : '未確認'} / 出力検証 ${m.exports.length}件` : '';
  // Full-resolution confirmation images are loaded without holding up state
  // controls; the committed store snapshot, not image decoding, gates ZIP.
  renderJobImages(s, generation);
  maybeScrollWorkflow();
}
click('decisionButton', advanceFlow);
click('cancelBackButton', cancelBackFlow);
click('finishBookButton', finishBookFlow);
click('create', () => command('create', { baseDir: $('baseDir').value }));
click('savePreset', () => persistPreset(false));
click('addPreset', () => persistPreset(true));
click('addKindlePreset', async () => {
  await command('addKindlePreset');
  return 'Kindle初期定義を追加しました。既存の編集・選択は変更しません。プリセット一覧から選んでください。';
});
$('preset').addEventListener('change', () => run(async () => {
  changedMapping();
  await command('selectPreset', { id: $('preset').value });
  return 'プリセットを保存・選択しました。「表示を確かめてプレビュー」を押してください。';
}));
for (const id of ['presetName', 'presetMode']) $(id).addEventListener('input', changedMapping);
async function persistPreset(add) {
  changedMapping();
  const mode = $('presetMode').value;
  await command('savePreset', { id: add ? undefined : $('preset').value, name: $('presetName').value, mode,
    config: mode === 'selectors' ? { ...Object.fromEntries(['frame', 'reader', 'identity', 'position', 'next'].map(k => [k, $(k).value])), frames: frameMappings } : null });
  return 'プリセットを保存しました。「表示を確かめてプレビュー」で新しい内容を検査してください。';
}
click('recover', () => command('recover', { path: $('recoverPath').value }));
click('closeJob', () => command('closeJob'));
$('keep').addEventListener('change', () => {
  $('session').disabled = !$('keep').checked;
  if (!$('keep').checked) $('session').value = '';
});
click('openKindle', () => command('openBrowser', { mode: 'kindle', keep: $('keep').checked, session: $('keep').checked ? $('session').value : 'new' }));
$('kindleRegion').addEventListener('change', () => {
  // Capture the user's choice before run() yields for paint. An in-flight
  // polling snapshot can restore the previous DOM value during that yield.
  const id = $('kindleRegion').value;
  return run(async () => {
    changedMapping();
    await command('setKindleRegion', { id });
    return '利用地域が変わりました。対象タブを選び、再プレビュー・承認してください。';
  });
});
click('openSample', () => {
  // Developer fixtures use a temporary profile unless a specific saved/new
  // dedicated profile was deliberately chosen in the advanced session area.
  const session = $('keep').checked ? $('session').value : undefined;
  return command('openBrowser', { mode: 'sample', keep: Boolean(session), session: session || undefined,
    sampleFixture: $('sampleFixture').value || undefined });
});
click('closeBrowser', () => command('closeBrowser'));
$('readerTab').addEventListener('change', () => { supersedeInteraction(); mappingStatus(); });
function applyCaptureSettings(settings) {
  $('captureScale').value = String(settings.capture_scale);
  $('pageOutputMode').value = settings.page_output_mode;
  $('readingDirection').value = settings.reading_direction;
  $('imageFormat').value = settings.image_format ?? 'png';
  $('jpegQuality').value = String(settings.jpeg_quality ?? 85);
  lastSettingsKey = JSON.stringify(settings);
  mappingStatus();
}
async function persistCaptureSettings() {
  const settings = {
    capture_scale: Number($('captureScale').value),
    page_output_mode: $('pageOutputMode').value,
    reading_direction: $('readingDirection').value,
    image_format: $('imageFormat').value,
    jpeg_quality: Number($('jpegQuality').value),
  };
  if (JSON.stringify(settings) === lastSettingsKey) return;
  const generation = interactionGeneration;
  settingsApplying = true;
  try {
    await run(async () => {
      await command('setCaptureSettings', settings);
      return '設定を保存しました。新しいプレビューを確認してください。';
    });
  } finally {
    settingsApplying = false;
    if (generation === interactionGeneration) {
      if (state?.captureSettings) applyCaptureSettings(state.captureSettings);
      else mappingStatus();
    }
  }
}
for (const id of ['captureScale', 'pageOutputMode', 'readingDirection', 'imageFormat', 'jpegQuality']) $(id).addEventListener('change', persistCaptureSettings);
click('selectReaderTab', async () => {
  changedMapping();
  await command('selectReaderTab', { id: $('readerTab').value });
  return '対象タブを選択しました。画面を確認してプレビューへ進めます。';
});
for (const [field, id] of Object.entries(pickIds)) click(id, async () => {
  changedMapping();
  $('message').textContent = '専用ブラウザに切り替え、画面内の案内に沿って指定してください。90秒以内、Escで取消。';
  pickingField = field;
  mappingStatus();
  $(`${field}Status`).textContent = '専用ブラウザでのクリック待ち';
  try {
    const result = await command('pick', { field });
    $(field).value = result.picked.selector;
    frameMappings[field] = result.picked.frame;
    $('previewConfirmed').checked = false;
    return `「${mappingLabels[field]}」を指定しました。ほかの項目はそのままで、プレビューへ進めます。`;
  } finally { pickingField = null; mappingStatus(); }
});
$('frame').addEventListener('input', () => { frameMappings = {}; changedMapping(); });
for (const field of Object.keys(mappingLabels)) $(field).addEventListener('input', () => { delete frameMappings[field]; changedMapping(); });
for (const field of ['previewConfirmed', 'resumeConfirmed']) $(field).addEventListener('change', mappingStatus);
async function previewCurrent() {
  clearPreview();
  const generation = interactionGeneration;
  const revision = configurationRevision;
  await command('preview', { config: { ...Object.fromEntries(['frame', 'reader', 'next', 'identity', 'position'].map(k => [k, $(k).value])), frames: frameMappings } });
  if (revision !== configurationRevision) return;
  const previewRevision = state.operationRevision;
  await png('/api/preview', $('previewImage'), generation, previewRevision);
  if (revision !== configurationRevision) { clearPreview(); return; }
  await renderPreviewOutput(revision);
  requireCurrent(generation);
  requirePreview(previewRevision, revision);
  displayedPreview = true; configurationDirty = false; $('previewPlaceholder').hidden = true;
  mappingStatus();
  return 'プレビューを表示しました。本・範囲・方向を確認してから承認してください。取得はまだ始まりません。';
}
click('pickAll', async () => {
  changedMapping(); pickingField = 'reader'; mappingStatus();
  try { await command('pickAll'); await previewCurrent(); return 'プレビューを表示しました。本・範囲・方向を確認してから承認してください。取得はまだ始まりません。'; }
  finally { pickingField = null; }
});
click('cancelPick', () => command('cancelPick'));
click('expandReader', async () => {
  changedMapping();
  const result = await command('expandReader');
  $('previewConfirmed').checked = false;
  return `読書領域を1段広げて指定しました（${result.picked.frame || 'メイン画面'}）。他の指定は保持しています。範囲を確認するため、明示的にプレビューしてください。`;
});
click('preview', previewCurrent);
click('quickPreview', async () => {
  stage('capture'); captureIntent = true;
  clearPreview();
  const generation = interactionGeneration;
  const revision = configurationRevision;
  await command('quickPreview', { mode: $('presetMode').value, config: $('presetMode').value === 'selectors'
    ? { ...Object.fromEntries(['frame', 'reader', 'next', 'identity', 'position'].map(k => [k, $(k).value])), frames: frameMappings } : undefined });
  if (revision !== configurationRevision) return;
  const previewRevision = state.operationRevision;
  await png('/api/preview', $('previewImage'), generation, previewRevision);
  if (revision !== configurationRevision) { clearPreview(); return; }
  await renderPreviewOutput(revision);
  requireCurrent(generation);
  requirePreview(previewRevision, revision);
  displayedPreview = true; configurationDirty = false; $('previewPlaceholder').hidden = true;
  mappingStatus();
  return 'プレビューを表示しました。本・範囲・出力ページの順と寸法を確認してください。まだ取得は始まりません。';
});
click('parentReader', async () => {
  if (!$('reader').value.trim()) throw new Error('先に読書領域を指定してください。');
  // A user-selected new region, not an automatic override of occlusion checks.
  // Preserve its per-field frame mapping and require a fresh preview approval.
  $('reader').value = `${$('reader').value.trim()} >> xpath=..`;
  changedMapping();
  await previewCurrent();
  return '1段広げた読書枠をプレビューしました。本・範囲・方向を目視確認するまでは開始しないでください。';
});
click('approve', () => command('approve', { confirmed: $('previewConfirmed').checked, resumeConfirmed: $('resumeConfirmed').checked }));
click('resumeCapture', async () => {
  clearPreview(); captureIntent = true; stage('capture'); mappingStatus();
  return '画像を保持して再開準備へ戻りました。再プレビュー・本人確認後、別操作で開始してください。';
});
click('start', () => command('start', { confirmed: true }));
click('pause', () => command('pause'));
click('stop', () => command('stop'));
click('review', () => command('review'));
click('saveOrder', () => command('review', { ids: ids() }));
click('restoreOrder', () => command('review', { ids: state.job.manifest.images.map(i => i.capture_id) }));
for (const id of ['cropId', 'cropX', 'cropY', 'cropWidth', 'cropHeight']) $(id).addEventListener('input', () => {
  cropSelectionRevision += 1; clearAutoCrop();
  if (id === 'cropId') $('inspectImage').hidden = true;
});
click('detectCrop', async () => {
  const id = Number($('cropId').value), revision = ++cropSelectionRevision;
  clearAutoCrop();
  if (!state?.job?.manifest.images.some(image => image.capture_id === id)) throw new Error('画像IDを選択してください。');
  const result = await command('detectCrop', { id });
  if (revision !== cropSelectionRevision || Number($('cropId').value) !== id) return;
  const candidate = result.autoCropCandidate;
  if (!candidate) {
    clearAutoCrop('安全な余白候補が見つかりません。手動クロップを使えます。');
    return '安全な余白候補が見つかりません。手動クロップを使えます。';
  }
  await png(`/api/image/${id}?original=1`, $('inspectImage'), interactionGeneration, undefined,
    () => revision === cropSelectionRevision && Number($('cropId').value) === id);
  if (revision !== cropSelectionRevision || Number($('cropId').value) !== id
    || state?.job?.manifest.job_id !== candidate.job_id || state.job.manifest.next_render_version !== candidate.render_version
    || (state.job.manifest.images.find(image => image.capture_id === id)?.crop?.version ?? null) !== candidate.crop_version) return;
  $('inspectCaption').textContent = '原本'; $('inspectImage').alt = '選択した原本';
  const rect = candidate.rect, canvas = $('autoCropPreview');
  canvas.width = rect.width; canvas.height = rect.height;
  canvas.getContext('2d').drawImage($('inspectImage'), rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  autoCropCandidate = candidate;
  $('autoCropFigure').hidden = false; $('autoCropActions').hidden = false;
  $('autoCropStatus').textContent = '候補は未適用です。原本と比較してから適用してください。';
  $('autoCropBounds').textContent = `x=${rect.x}, y=${rect.y}, ${rect.width}×${rect.height} px`;
  return '候補は未適用です。原本と比較してから適用してください。';
});
click('cancelAutoCrop', () => { cropSelectionRevision += 1; clearAutoCrop('候補を取り消しました。保存状態は変わりません。'); });
click('applyAutoCrop', async () => {
  const candidate = autoCropCandidate;
  if (!candidate || Number($('cropId').value) !== candidate.capture_id) throw new Error('画像またはクロップが変わりました。候補を再検出してください。');
  const revision = ++cropSelectionRevision;
  clearAutoCrop();
  await command('applyAutoCrop', { candidate, confirmed: true });
  await png(`/api/image/${candidate.capture_id}`, $('inspectImage'), interactionGeneration, undefined,
    () => revision === cropSelectionRevision && Number($('cropId').value) === candidate.capture_id);
  $('inspectCaption').textContent = '適用後のクロップ結果'; $('inspectImage').alt = '適用後のクロップ結果';
  return '候補を適用しました。原本は保持しています。';
});
click('crop', async () => {
  const revision = ++cropSelectionRevision; clearAutoCrop();
  const input = Object.fromEntries([['id', 'cropId'], ['x', 'cropX'], ['y', 'cropY'], ['width', 'cropWidth'], ['height', 'cropHeight']].map(([k, id]) => [k, Number($(id).value)]));
  await command('crop', input);
  await png(`/api/image/${input.id}`, $('inspectImage'), interactionGeneration, undefined,
    () => revision === cropSelectionRevision && Number($('cropId').value) === input.id);
  $('inspectCaption').textContent = '適用後のクロップ結果'; $('inspectImage').alt = '適用後のクロップ結果';
});
click('resetCrop', async () => {
  const revision = ++cropSelectionRevision; clearAutoCrop();
  const item = state.job.manifest.images.find(i => i.capture_id === Number($('cropId').value));
  if (!item) throw new Error('画像IDを選択してください。');
  await command('resetCrop', { id: item.capture_id });
  await png(`/api/image/${item.capture_id}`, $('inspectImage'), interactionGeneration, undefined,
    () => revision === cropSelectionRevision && Number($('cropId').value) === item.capture_id);
  $('inspectCaption').textContent = '原本'; $('inspectImage').alt = '選択した原本';
});
click('export', saveCurrentExport);
click('chooseDestination', async () => {
  const job = exportJobPath, revision = destinationRevision;
  const result = await command('chooseDestination', { destination: $('destination').value, format: $('format').value });
  if (job !== exportJobPath || revision !== destinationRevision) throw superseded();
  if (result.chosenDestination === null) return { cancelled: true };
  $('destination').value = result.chosenDestination;
  destinationDirty = true; destinationRevision += 1;
  $('exportResult').textContent = ''; mappingStatus();
  return '保存先を選択しました。まだ保存していません。「決定・次へ」で保存します。';
});
$('destination').addEventListener('input', () => { destinationDirty = true; destinationRevision += 1; $('exportResult').textContent = ''; mappingStatus(); });
$('rangeConfirmed').addEventListener('change', () => {
  rangeConfirmationDirty = true;
  $('exportResult').textContent = '';
});
$('format').addEventListener('change', () => {
  destinationRevision += 1;
  const format = $('format').value;
  $('destination').value = $('destination').value.replace(/\.(zip|cbz)$/i, `.${format}`);
  $('export').textContent = `${format.toUpperCase()}を検証して保存`;
  $('exportResult').textContent = '';
  mappingStatus();
});
click('reconnect', () => poll());
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  const generation = stateRequestGeneration;
  try {
    const snapshot = await (await api('/api/state')).json();
    if (generation === stateRequestGeneration) await render(snapshot);
  }
  catch (e) { $('message').textContent = e.message; }
  finally { polling = false; }
}
installLanguageSelector();
await poll();
setInterval(poll, 1000);
// Poll observations, not elapsed time: never increment a value here.
setInterval(pollProgress, 200);

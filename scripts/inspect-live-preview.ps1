param([Parameter(Mandatory)][int]$ControlProcessId)
$ErrorActionPreference = 'Stop'
$watch = [Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ControlProcessId))
if (!$window) { throw 'control_window_not_found' }
$all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$names = @($all | ForEach-Object { $_.Current.Name })
$text = $names -join "`n"
function Read-LocalText([string]$id) {
  @($all | Where-Object { $_.Current.AutomationId -eq $id } | ForEach-Object {
    $_.Current.Name
    $_.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name }
  }) -join "`n"
}
$message = Read-LocalText 'message'
$info = Read-LocalText 'previewInfo'
if (!$info.Trim()) { $info = @($names | Where-Object { $_ -match '^表示範囲 \d+×\d+ CSS px → 元PNG \d+×\d+ px' }) -join "`n" }
$approval = @($all | Where-Object { $_.Current.AutomationId -eq 'previewConfirmed' })
$decision = @($all | Where-Object { $_.Current.AutomationId -eq 'decisionButton' })
[ordered]@{
  previewDisplayed = $text.Contains('プレビューを表示しました。')
  previewFailed = $text.Contains('プレビュー検査失敗')
  inspecting = $message.Contains('処理中…')
  genericAmbiguous = $message.Contains('一意に確認できませんでした')
  windowUnavailable = $message.Contains('専用ブラウザの表示を確認できません')
  readerUiUnknown = $message.Contains('指定はありますが、現在の表示を検査できませんでした')
  captureFailed = $message.Contains('表示領域を画像にできませんでした')
  targetChanged = $message.Contains('対象の表示が変わりました')
  knownCodes = @([regex]::Matches($message, '\b(?:reader_[a-z_]+|preview_[a-z_]+|capture_[a-z_]+|window_not_available|target_changed|select_reader_tab)\b') | ForEach-Object Value | Select-Object -Unique)
  identityFailure = $message.Contains('本の識別表示：')
  positionFailure = $message.Contains('位置表示：')
  causes = @([regex]::Matches($message, '\b(hidden|not_found|not_unique|invalid_selector|kindle_chrome_structure_changed|blocked_hit)\b') | ForEach-Object Value | Select-Object -Unique)
  stages = @([regex]::Matches($message, '\b(auto_visibility_wait|preview_visibility_wait)\b') | ForEach-Object Value | Select-Object -Unique)
  recoveryObservations = @([regex]::Matches($message, '\[recovery:(not_preset|auth_visible|markers_not_unique|no_handles|region_hidden|not_shared|next_direction|no_surface|hit_blocked|dispatched)\]') | ForEach-Object { $_.Groups[1].Value })
  dimensions = @([regex]::Matches($info, '\d+×\d+') | ForEach-Object Value)
  centralNonUniform = $info.Contains('中央画素：非単色')
  centralNotBlack = $info.Contains('黒一色ではない')
  initialHiddenRecovered = @([regex]::Matches($info, '初期非表示からのDOM復帰：(identity|position|next)') | ForEach-Object { $_.Groups[1].Value })
  previewImageAccessible = @($all | Where-Object { ($_.Current.AutomationId -eq 'previewImage' -or ($_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Image -and $_.Current.Name -eq '保存前の元画像プレビュー')) -and !$_.Current.IsOffscreen }).Count -eq 1
  approvalRequired = $text.Contains('プレビューを本人が確認し、チェックを入れてください。')
  approvalUnchecked = $approval.Count -eq 1 -and $approval[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off
  decisionDisabled = $decision.Count -eq 1 -and !$decision[0].Current.IsEnabled
  elapsedMs = $watch.ElapsedMilliseconds
} | ConvertTo-Json -Compress

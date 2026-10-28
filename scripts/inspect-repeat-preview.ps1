param([Parameter(Mandatory)][int]$ControlProcessId, [ValidateSet('Inspect','Decision','OpenDetails')][string]$Action='Inspect')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$w=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$ControlProcessId))
if (!$w) { throw 'control_window_not_found' }
$all=$w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
if ($Action -eq 'Decision') {
  $decision=@($all | Where-Object { $_.Current.AutomationId -eq 'decisionButton' })
  $text=($all | ForEach-Object { $_.Current.Name }) -join "`n"
  # Only job creation / browser opening / preview, never approval or capture.
  if ($text -notmatch '「決定・次へ」で(新しい1冊の作業を用意|専用(?:ブラウザ|Kindle)を開|プレビューし)') { throw 'safe_guidance_not_observed' }
  if ($decision.Count -ne 1 -or !$decision[0].Current.IsEnabled) { throw 'decision_unavailable' }
  $decision[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
} elseif ($Action -eq 'OpenDetails') {
  $e=@($all | Where-Object { $_.Current.Name -eq '補助・詳細操作' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button })
  if ($e.Count -ne 1) { throw 'details_unavailable' }
  $e[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
} else {
  # Emit only app-owned wording, identifiers and boolean comparisons, not reader
  # content, arbitrary values, URLs, keys or accessibility tree dumps.
  $text=($all | ForEach-Object { $_.Current.Name }) -join "`n"
  [ordered]@{
    ids=@($all | Where-Object { $_.Current.AutomationId -in @('message','decisionButton','nextAction','stageTools','state','reason') } | ForEach-Object { $_.Current.AutomationId })
    createGuidance=$text.Contains('「決定・次へ」で新しい1冊の作業を用意します。')
    browserGuidance=$text.Contains('「決定・次へ」で専用ブラウザを開きます。')
    previewGuidance=$text.Contains('「決定・次へ」でプレビューします。')
    codes=@([regex]::Matches($text,'\b(?:[a-z]+_[a-z_]+)\b') | ForEach-Object Value | Where-Object { $_ -match '^(?:reader_|preview_|job_|store_|session_|unsafe_|target_|browser_|connection_|invalid_|ipc_)' } | Select-Object -Unique)
    fixedGuidance=@($all | Where-Object { $_.Current.Name -match '^「決定・次へ」で|^接続できません|^接続中|^新しい1冊|^専用ブラウザを開|^最初に' } | ForEach-Object { $_.Current.Name })
    decisionEnabled=@($all | Where-Object { $_.Current.AutomationId -eq 'decisionButton' -and $_.Current.IsEnabled }).Count -eq 1
  } | ConvertTo-Json -Compress -Depth 4
}

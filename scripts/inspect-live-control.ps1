param([Parameter(Mandatory)][int]$ControlProcessId, [switch]$ExpectInitialState)
$ErrorActionPreference = 'Stop'
$watch = [System.Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ControlProcessId)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if (!$window) { throw 'control_window_not_found' }
$elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$names = @($elements | ForEach-Object { $_.Current.Name })
$text = $names -join "`n"
if ($ExpectInitialState -and !$text.Contains('「決定・次へ」で新しい1冊の作業を用意します。')) {
  throw 'initial_state_not_observed'
}
# Only fixed application wording is compared. Never return document contents,
# book labels, URLs, connection keys, or arbitrary accessibility values.
[ordered]@{
  controlWindowFound = $true
  jobRequired = $names -contains '「決定・次へ」で新しい1冊の作業を用意してください。'
  browserRequired = $names -contains '「決定・次へ」で専用ブラウザを開いてください。'
  noJobExportHelp = $names -contains '先に新しい作業か中断データを開いてください。'
  fourMappings = $names -contains '4 / 4項目 指定済み（有効性はプレビューで検査）。まだ取得は開始しません。'
  initialCreateGuidance = $text.Contains('「決定・次へ」で新しい1冊の作業を用意します。')
  noCurrentJob = $text.Contains('現在は本の作業がありません。')
  openBrowserGuidance = $text.Contains('「決定・次へ」で専用Kindleを開き、本人がログインして1冊を開いてください。')
  elementCount = $elements.Count
  elapsedMs = $watch.ElapsedMilliseconds
  previewButtons = @($elements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -in @('プレビュー', '自動設定', '自動設定してプレビュー', '自動判別してプレビュー') } | ForEach-Object { @{ enabled = $_.Current.IsEnabled } })
} | ConvertTo-Json -Compress -Depth 4

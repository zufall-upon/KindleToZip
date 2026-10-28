param([Parameter(Mandatory)][int]$ReaderProcessId)
$ErrorActionPreference = 'Stop'
$watch = [Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ReaderProcessId)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if (!$window) { throw 'reader_window_not_found' }
$all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
# Compare locally; never emit accessibility names, book titles, URLs or values.
$names = @($all | ForEach-Object { $_.Current.Name })
$text = $names -join "`n"
[ordered]@{
  readerWindowFound = $true
  elementCount = $all.Count
  documentCount = @($all | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document }).Count
  passwordFields = @($all | Where-Object { $_.Current.IsPassword }).Count
  loginGuidance = $text -match 'サインイン|ログイン|Sign in|sign in'
  libraryGuidance = $text -match 'ライブラリ|Library|library'
  networkError = $text -match 'ERR_[A-Z_]+|このサイトにアクセスできません|This site can.t be reached'
  continueReadingControls = @($names | Where-Object { $_ -match '^(続きを読む|読書を再開|Continue reading|Resume reading)$' }).Count
  readerToolbar = @($names | Where-Object { $_ -in @('Go to', '移動', '目次', 'Table of Contents') }).Count
  elapsedMs = $watch.ElapsedMilliseconds
} | ConvertTo-Json -Compress

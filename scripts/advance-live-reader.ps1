param(
  [Parameter(Mandatory)][int]$ControlProcessId,
  [Parameter(Mandatory)][ValidateSet('CreateJob', 'OpenSavedSession', 'ConfirmTargetTab')][string]$Step
)
$ErrorActionPreference = 'Stop'
$watch = [Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ControlProcessId)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if (!$window) { throw 'control_window_not_found' }
$all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$names = @($all | ForEach-Object { $_.Current.Name })
$guidance = switch ($Step) {
  'CreateJob' { '「決定・次へ」で新しい1冊の作業を用意します。' }
  'OpenSavedSession' { '「決定・次へ」で専用Kindleを開き、本人がログインして1冊を開いてください。' }
  'ConfirmTargetTab' { '対象の専用タブを選び、「決定・次へ」で確定してください。以前の承認は使いません。' }
}
while ($names -notcontains $guidance -and $watch.ElapsedMilliseconds -lt 5000) {
  Start-Sleep -Milliseconds 150
  $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $names = @($all | ForEach-Object { $_.Current.Name })
}
if ($names -notcontains $guidance) { throw 'expected_public_guidance_not_found' }
$buttons = @($all | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq '決定・次へ' })
if ($buttons.Count -ne 1 -or !$buttons[0].Current.IsEnabled) { throw 'public_button_not_unique_or_disabled' }
# Invoke the public accessibility action directly. Never synthesize input,
# set focus, read arbitrary values, or advance past opening the reader.
$invoke = $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
[ordered]@{ step = $Step; publicActionInvoked = $true; elapsedMs = $watch.ElapsedMilliseconds } | ConvertTo-Json -Compress

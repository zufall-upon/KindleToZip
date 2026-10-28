param([Parameter(Mandatory)][int]$ControlProcessId, [ValidateSet('SelectTarget','Preview','AutoPreview')][string]$Action='Preview', [string]$ResultPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$watch=[Diagnostics.Stopwatch]::StartNew()
$w=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$ControlProcessId))
if (!$w) { throw 'control_window_not_found' }
function Elements { $w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) }
$section=if($Action -eq 'Preview'){'manualOptions'}else{'captureActions'}
$g=@(Elements | Where-Object {$_.Current.AutomationId -eq $section})
if($g.Count -ne 1){throw 'public_section_unavailable'}
foreach($e in $g[0].FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)) {
  $p=$null
  if($e.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$p)){if($p.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Collapsed){$p.Expand()};break}
}
$id=switch($Action){'SelectTarget'{'selectReaderTab'}'Preview'{'preview'}'AutoPreview'{'quickPreview'}}
$buttons=@(Elements | Where-Object {$_.Current.AutomationId -eq $id -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button})
if($buttons.Count -ne 1 -or !$buttons[0].Current.IsEnabled){throw 'public_action_unavailable'}
$buttons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
if($Action -eq 'SelectTarget') { [ordered]@{action=$Action;publicInvoked=$true;elapsedMs=$watch.ElapsedMilliseconds}|ConvertTo-Json -Compress;return }
do {
  Start-Sleep -Milliseconds 200
  $result=& "$PSScriptRoot/inspect-live-preview.ps1" -ControlProcessId $ControlProcessId | ConvertFrom-Json
  # Do not mistake the preceding result for completion before the new UI task settles.
  if($watch.ElapsedMilliseconds -gt 1800 -and !$result.inspecting -and ($result.previewDisplayed -or $result.previewFailed)){break}
}while($watch.ElapsedMilliseconds -lt 15000)
$result|Add-Member -NotePropertyName publicAction -NotePropertyValue $Action
$result|Add-Member -NotePropertyName operationElapsedMs -NotePropertyValue $watch.ElapsedMilliseconds
$serialized=$result|ConvertTo-Json -Compress -Depth 4
if($ResultPath){
  if($ResultPath -notmatch '^artifacts/portable-repair/[a-z0-9-]+\.json$'){throw 'invalid_result_path'}
  [IO.File]::WriteAllText((Join-Path (Get-Location) $ResultPath),$serialized,[Text.UTF8Encoding]::new($false))
}
$serialized

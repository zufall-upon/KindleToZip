param([Parameter(Mandatory)][int]$ControlProcessId, [switch]$WaitForResult, [string]$ResultPath, [string]$BuildDirectory)
$ErrorActionPreference = 'Stop'
$watch = [Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if ($WaitForResult) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PreviewOsObservation {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
  $before = [PreviewOsObservation+Point]::new()
  if (![PreviewOsObservation]::GetCursorPos([ref]$before)) { throw 'cursor_observation_unavailable' }
  $foreground = [PreviewOsObservation]::GetForegroundWindow()
}
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ControlProcessId))
if (!$window) { throw 'control_window_not_found' }
$all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$guidance = @($all | ForEach-Object { $_.Current.Name })
$allowed = @('「決定・次へ」でプレビューします。自動判定できない場合は詳細指定へ案内します。', '「決定・次へ」でプレビューします。詳細指定を開いた場合は指定した4項目を検査します。自動判別へ戻す必要はありません。')
while (!@($allowed | Where-Object { $_ -in $guidance }).Count -and $watch.ElapsedMilliseconds -lt 5000) {
  Start-Sleep -Milliseconds 150
  $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $guidance = @($all | ForEach-Object { $_.Current.Name })
}
if (!@($allowed | Where-Object { $_ -in $guidance }).Count) { throw 'preview_only_guidance_not_observed' }
$buttons = @($all | Where-Object { $_.Current.AutomationId -eq 'decisionButton' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button })
if ($buttons.Count -ne 1 -or !$buttons[0].Current.IsEnabled) { throw 'preview_button_not_unique_or_disabled' }
$buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
if ($WaitForResult) {
  do {
    Start-Sleep -Milliseconds 200
    $result = & "$PSScriptRoot/inspect-live-preview.ps1" -ControlProcessId $ControlProcessId | ConvertFrom-Json
    if ($result.previewDisplayed -or ($watch.ElapsedMilliseconds -gt 2000 -and $result.previewFailed -and !$result.inspecting)) { break }
  } while ($watch.ElapsedMilliseconds -lt 12000)
  $after = [PreviewOsObservation+Point]::new()
  if (![PreviewOsObservation]::GetCursorPos([ref]$after)) { throw 'cursor_observation_unavailable' }
  $result | Add-Member -NotePropertyName osCursorUnchanged -NotePropertyValue ($before.X -eq $after.X -and $before.Y -eq $after.Y)
  $result | Add-Member -NotePropertyName foregroundUnchanged -NotePropertyValue ($foreground -eq [PreviewOsObservation]::GetForegroundWindow())
  $result | Add-Member -NotePropertyName publicPreviewInvoked -NotePropertyValue $true
  $result | Add-Member -NotePropertyName publicPreviewElapsedMs -NotePropertyValue $watch.ElapsedMilliseconds
  if ($BuildDirectory) {
    if ($BuildDirectory -notmatch '^artifacts/releases/build-[a-z0-9-]+$') { throw 'invalid_build_path' }
    $report = Get-Content -LiteralPath "$BuildDirectory/KindleToZip-Portable.json" -Raw -Encoding utf8 | ConvertFrom-Json
    $result | Add-Member -NotePropertyName candidateSha256 -NotePropertyValue $report.executableSha256
  }
  $serialized = $result | ConvertTo-Json -Compress -Depth 4
  if ($ResultPath) {
    if ($ResultPath -notmatch '^artifacts/portable-repair/[a-z0-9-]+\.json$') { throw 'invalid_observation_path' }
    [IO.File]::WriteAllText((Join-Path (Get-Location) $ResultPath), $serialized, [Text.UTF8Encoding]::new($false))
  }
  $serialized
  return
}
[ordered]@{ previewPublicActionInvoked = $true; elapsedMs = $watch.ElapsedMilliseconds } | ConvertTo-Json -Compress

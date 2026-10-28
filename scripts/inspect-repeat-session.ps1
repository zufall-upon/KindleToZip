param([Parameter(Mandatory)][int]$ControlProcessId, [Parameter(Mandatory)][int]$ReaderProcessId, [Parameter(Mandatory)][string]$ResultPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Window([int]$id) {
  $w=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$id))
  if(!$w){throw 'owned_window_not_found'}
  return $w
}
function Hash([string]$text) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant() }
$control=Window $ControlProcessId
foreach($summary in @('表示の再検査・個別確認（補助）','自動判定できない場合（詳細指定）','範囲が合わない場合・CSS/iframe設定')) {
  $buttons=@($control.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)|Where-Object{$_.Current.Name -eq $summary -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button})
  if($buttons.Count -ne 1){throw 'inspection_panel_unavailable'}
  $expand=$buttons[0].GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
  if($expand.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Collapsed){$expand.Expand();Start-Sleep -Milliseconds 150}
}
$all=@($control.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))
function Text([string]$id) {
  $e=@($all|Where-Object{$_.Current.AutomationId -eq $id})
  return (@($e|ForEach-Object{$_.Current.Name; $_.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)|ForEach-Object{$_.Current.Name}}) -join "`n")
}
$quick=@($all|Where-Object{$_.Current.AutomationId -eq 'quickPreview' -and $_.Current.IsEnabled})
$pause=@($all|Where-Object{$_.Current.AutomationId -eq 'pause' -and $_.Current.IsEnabled})
if($quick.Count -ne 1 -or $pause.Count -or (Text 'message').Contains('処理中')){throw 'application_not_quiescent'}
$jobText=Text 'jobPath'
$jobMatch=[regex]::Match($jobText,'中断復帰用フォルダ：([^\r\n]+)')
if($jobMatch.Success){$jobPath=[IO.Path]::GetFullPath($jobMatch.Groups[1].Value.Trim())}
else {
  # Captured from the current public setup panel before returning to capture.
  # Never infer the current job from timestamps or stale lock files.
  $context=Get-Content artifacts/portable-repair/repeat-job-context.json -Raw -Encoding utf8|ConvertFrom-Json
  $jobPath=[IO.Path]::GetFullPath($context.currentJobPath)
}
$jobsRoot=[IO.Path]::GetFullPath('_testenv/data/jobs')+[IO.Path]::DirectorySeparatorChar
if(!$jobPath.StartsWith($jobsRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'unexpected_job_root'}
$reader=Window $ReaderProcessId
$nodes=@($reader.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))
if(@($nodes|Where-Object{$_.Current.IsPassword}).Count){throw 'authentication_boundary'}
$title=@($nodes|Where-Object{$_.Current.AutomationId -eq 'readerChromeTitleBar'})
$slider=@($nodes|Where-Object{$_.Current.ControlType -eq [Windows.Automation.ControlType]::Slider})
if($title.Count -ne 1 -or $slider.Count -ne 1){throw 'book_position_not_unique'}
$label=@($title[0].Current.Name; $title[0].FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)|ForEach-Object{$_.Current.Name}) -join "`n"
$range=$null
if(!$slider[0].TryGetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern,[ref]$range)){throw 'position_value_unavailable'}
$position=$range.Current.Value.ToString('R',[Globalization.CultureInfo]::InvariantCulture)
$process=Get-CimInstance Win32_Process -Filter "ProcessId=$ReaderProcessId"
$match=[regex]::Match($process.CommandLine,'--user-data-dir=(?:"([^"]+)"|(\S+))')
$profile=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
$dataRoot=[IO.Path]::GetFullPath('_testenv/data')+[IO.Path]::DirectorySeparatorChar
if(!$match.Success -or !$profile.StartsWith($dataRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($profile) -notmatch '^saved-[a-f0-9-]{36}$'){throw 'persistent_owned_profile_required'}
$files=[ordered]@{}
foreach($f in Get-ChildItem _testenv/data/jobs -Recurse -File -Force|Sort-Object FullName){
  if($f.Name -eq '.job.lock'){continue}
  if($f.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'unexpected_job_link'}
  $relative=[IO.Path]::GetRelativePath($jobsRoot,$f.FullName)
  $files[(Hash $relative)]=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$settings=[ordered]@{}
foreach($name in @('kindle-session.json','reader-presets.json')){ $settings[$name]=(Get-FileHash -LiteralPath "_testenv/data/$name" -Algorithm SHA256).Hash.ToLowerInvariant() }
# Read only these application-owned configuration fields, never password/URL controls.
$values=@(); foreach($id in @('preset','frame','reader','identity','position','next','captureScale','pageOutputMode','readingDirection')) {
  $e=@($all|Where-Object{$_.Current.AutomationId -eq $id}); if($e.Count -ne 1){throw 'configuration_field_unavailable'}
  $values+= $e[0].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
}
$preview=& "$PSScriptRoot/inspect-live-preview.ps1" -ControlProcessId $ControlProcessId | ConvertFrom-Json
$result=[ordered]@{ observedAtUtc=[DateTime]::UtcNow.ToString('o'); controlPid=$ControlProcessId; readerPid=$ReaderProcessId; quiescent=$true; currentJobPath=$jobPath; persistentProfile=$true; profileDigest=(Hash $profile.ToLowerInvariant()); bookPositionDigest=(Hash ($label+"`n"+$position)); titleVisible=!$title[0].Current.IsOffscreen; positionVisible=!$slider[0].Current.IsOffscreen; configurationDigest=(Hash ($values -join "`n")); settings=$settings; existingFiles=$files; preview=$preview; rawBookUrlCredentialsEmitted=$false }
if($ResultPath -notmatch '^artifacts/portable-repair/[a-z0-9-]+\.json$'){throw 'invalid_result_path'}
[IO.File]::WriteAllText((Join-Path (Get-Location) $ResultPath),($result|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
[ordered]@{ quiescent=$true; persistentProfile=$true; titleVisible=$result.titleVisible; positionVisible=$result.positionVisible; existingFileCount=$files.Count; previewDisplayed=$preview.previewDisplayed; rawBookUrlCredentialsEmitted=$false }|ConvertTo-Json -Compress

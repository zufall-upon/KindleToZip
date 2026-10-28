param(
    [ValidateSet('Inspect','Markers','Hover','Restore','SelectTab','OpenKindle','Pick','PickClick','ClickReader','Preview','ExpandReader','Recover','Close')][string]$Action = 'Inspect',
    [Parameter(Mandatory)][int]$LauncherId,
    [string]$Field = 'reader',
    [string]$JobPath = '',
    [int]$Tab = 2,
    [double]$X = -1,
    [double]$Y = -1
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KtzPickerInput {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
function Elements($w) { return $w.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) }
function Find($w, $name) { return Elements $w | Where-Object { $_.Current.Name -eq $name } | Select-Object -First 1 }
function ReaderElements {
    $ws=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ProcessId -eq $reader.Current.ProcessId }
    foreach($w in $ws) { Elements $w }
}
function Invoke($w, $name) {
    $e = Elements $w | Where-Object { $_.Current.Name -eq $name -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button } | Select-Object -First 1
    if (-not $e) { throw "公開コントロールなし: $name" }
    if ($e.Current.IsOffscreen) {
        $ancestor = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($e)
        $scroll = $null
        while ($ancestor -and -not $ancestor.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern, [ref]$scroll)) { $ancestor = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor) }
        if ($scroll) { for ($i=0; $i -lt 12 -and $e.Current.IsOffscreen; $i++) { $scroll.Scroll([Windows.Automation.ScrollAmount]::NoAmount,[Windows.Automation.ScrollAmount]::LargeIncrement) } }
    }
    if (-not $e.Current.IsEnabled) { throw "公開コントロール無効: $name" }
    $pattern=$null
    if($e.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $pattern.Invoke() }
    elseif($e.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)) { $pattern.Expand() }
    else { throw "公開ボタンの操作パターンなし: $name" }
    Write-Output "公開UI操作: $name"
}
$all = @(Get-CimInstance Win32_Process)
$owners = [Collections.Generic.HashSet[int]]::new(); [void]$owners.Add($LauncherId)
do { $added=$false; foreach($p in $all) { if($owners.Contains([int]$p.ParentProcessId) -and $owners.Add([int]$p.ProcessId)) { $added=$true } } } while($added)
$windows = @([Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition) | Where-Object { $owners.Contains($_.Current.ProcessId) })
$app = $windows | Where-Object { $elements=Elements $_; @($elements | Where-Object { $_.Current.AutomationId -in @('stop','create','openKindle') }).Count -gt 0 } | Select-Object -First 1
$reader = $windows | Where-Object { $_ -ne $app -and ($all | Where-Object ProcessId -eq $_.Current.ProcessId).Name -eq 'chrome.exe' } | Select-Object -First 1
# Enable Chromium accessibility without emitting page names or contents.
if ($app) { [void](Elements $app) }
if ($reader) { [void](Elements $reader) }
switch($Action) {
    'Inspect' {
        if ($app) {
            Write-Output '操作画面あり'
            Elements $app | Where-Object { $_.Current.AutomationId -in @('state','readerStatus','identityStatus','positionStatus','nextStatus','mappingStatus','message','previewInfo','previewImage','preview','start','approve','readerTab') } | ForEach-Object {
                $c=$_.Current
                [pscustomobject]@{ id=$c.AutomationId; value=if($c.AutomationId -eq 'previewImage'){'画像内容は非出力'}elseif($c.Name){$c.Name}else{((Elements $_ | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Text } | ForEach-Object {$_.Current.Name}) -join '')}; enabled=$c.IsEnabled; offscreen=$c.IsOffscreen; rect=$c.BoundingRectangle.ToString() }
            } | ConvertTo-Json
        }
        if ($reader) {
            $es=Elements $reader
            Write-Output "専用読書窓あり / pid=$($reader.Current.ProcessId) / rect=$($reader.Current.BoundingRectangle)"
            Write-Output "loginVisible=$(@($es | Where-Object { $_.Current.Name -eq 'Amazon アカウントでログイン' -and -not $_.Current.IsOffscreen }).Count -gt 0)"
            $es | Where-Object { $_.Current.ControlType -in @([Windows.Automation.ControlType]::Document,[Windows.Automation.ControlType]::Image,[Windows.Automation.ControlType]::Slider) -or $_.Current.AutomationId -in @('readerChromeTitle','kindleReader_content','kindleReader_pageTurnAreaLeft','kindleReader_pageTurnAreaRight') } | ForEach-Object {
                $c=$_.Current
                [pscustomobject]@{ type=$c.ControlType.ProgrammaticName; knownId=if($c.AutomationId -in @('readerChromeTitle','kindleReader_content','kindleReader_pageTurnAreaLeft','kindleReader_pageTurnAreaRight')){$c.AutomationId}else{''}; namePresent=[bool]$c.Name; offscreen=$c.IsOffscreen; rect=$c.BoundingRectangle.ToString() }
            } | ConvertTo-Json
        }
    }
    'Restore' {
        if (-not $reader) { throw '専用読書窓なし' }
        (Find $reader 'Chromium').GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
        Start-Sleep -Milliseconds 400
        $history=ReaderElements | Where-Object { $_.Current.Name -match '^履歴' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::MenuItem } | Select-Object -First 1
        $history.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
        Start-Sleep -Milliseconds 400
        $tabs=ReaderElements | Where-Object { $_.Current.Name -eq '2 個のタブ' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::MenuItem } | Select-Object -First 1
        if(-not $tabs){throw '本人の直前の2タブ復元候補なし。書籍の新規選択はしない'}
        $tabs.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
        Start-Sleep -Milliseconds 400
        $restore=ReaderElements | Where-Object { $_.Current.Name -like 'ウィンドウを復元*' } | Select-Object -First 1
        if(-not $restore){throw '標準ウィンドウ復元なし'}
        $restore.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-Output '専用Chromeの標準履歴から直前の2タブを復元（認証・本棚の選択・ページ送りなし）'
    }
    'SelectTab' {
        $combo=Elements $app | Where-Object { $_.Current.Name -eq '対象の専用タブ' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::ComboBox } | Select-Object -First 1
        $combo.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
        $option=Find $app "専用タブ $Tab"
        if(-not $option){throw '指定タブなし'}
        $option.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
        Invoke $app 'このタブを対象にする'
    }
    'OpenKindle' { Invoke $app '日本向けKindle Webを開く' }
    'Pick' {
        $names=@{reader='読書領域を選ぶ';identity='本の識別表示を選ぶ';position='位置表示を選ぶ';next='次へボタンを選ぶ'}
        $manual=Find $app '読書領域を選ぶ'
        if(-not $manual) { Invoke $app '自動判定できない場合（詳細指定）' }
        Invoke $app $names[$Field]
    }
    'Markers' {
        $doc=Elements $reader | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Document } | Select-Object -First 1
        Elements $doc | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.ControlType -in @([Windows.Automation.ControlType]::Text,[Windows.Automation.ControlType]::Button,[Windows.Automation.ControlType]::Slider,[Windows.Automation.ControlType]::Image) } | ForEach-Object {
            $c=$_.Current; [pscustomobject]@{type=$c.ControlType.ProgrammaticName; namePresent=[bool]$c.Name; rect=$c.BoundingRectangle.ToString()}
        } | ConvertTo-Json
    }
    {$_ -in 'ClickReader','PickClick','Hover'} {
        if (-not $reader -or $X -lt 0 -or $Y -lt 0) { throw '専用窓と明示座標が必要' }
        if($Action -eq 'PickClick') {
            Invoke $app '読書領域を選ぶ'
            Start-Sleep -Milliseconds 300
        }
        # Require the app's isolated selection document. Never send a click to
        # the unprotected official reader (including its navigation controls).
        if($Action -in @('ClickReader','PickClick')) {
            $hint=Elements $reader | Where-Object { $_.Current.Name -like '*Escで取消（90秒）。' -and -not $_.Current.IsOffscreen } | Select-Object -First 1
            if(-not $hint){throw '指定面の可視案内なし。クリックは送らない'}
        }
        $doc=Elements $reader | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Document } | Select-Object -First 1
        $r=$doc.Current.BoundingRectangle
        if($X -ge $r.Width -or $Y -ge $r.Height) {throw '指定座標が表示外'}
        $selectedTab=Elements $reader | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::TabItem -and $_.Current.BoundingRectangle.Y -lt $r.Y -and $_.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } | Select-Object -First 1
        if($selectedTab) { $selectedTab.SetFocus() }
        $thread=[KtzPickerInput]::GetCurrentThreadId()
        $foreground=[KtzPickerInput]::GetWindowThreadProcessId([KtzPickerInput]::GetForegroundWindow(),[IntPtr]::Zero)
        try {
            [void][KtzPickerInput]::AttachThreadInput($thread,$foreground,$true)
            [void][KtzPickerInput]::SetForegroundWindow([IntPtr]$reader.Current.NativeWindowHandle)
        } finally { [void][KtzPickerInput]::AttachThreadInput($thread,$foreground,$false) }
        Start-Sleep -Milliseconds 150
        if([KtzPickerInput]::GetForegroundWindow() -ne [IntPtr]$reader.Current.NativeWindowHandle){throw '専用窓を前面にできず、入力を送らない'}
        [void][KtzPickerInput]::SetCursorPos([int]($r.X+$X),[int]($r.Y+$Y))
        if($Action -in @('ClickReader','PickClick')) {
            [KtzPickerInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
            [KtzPickerInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
            Write-Output "専用の指定面をクリック: CSS x=$X y=$Y"
        } else { Write-Output "専用読書窓内のhoverのみ: CSS x=$X y=$Y" }
    }
    'Preview' { Invoke $app '現在の指定でプレビュー' }
    'ExpandReader' { Invoke $app '選んだ領域を1段広げて選ぶ' }
    'Recover' {
        if(-not $JobPath) { throw 'Portable jobs内のジョブフォルダを明示してください' }
        $jobsRoot=(Resolve-Path (Join-Path $PSScriptRoot '../_testenv/data/jobs')).Path.TrimEnd('\')+'\'
        $resolved=(Resolve-Path -LiteralPath $JobPath).Path
        if(-not $resolved.StartsWith($jobsRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Portable jobs外のパスは開きません' }
        Invoke $app '作業先・中断データ・終了'
        $fieldElement=Elements $app | Where-Object { $_.Current.AutomationId -eq 'recoverPath' } | Select-Object -First 1
        if(-not $fieldElement -or -not $fieldElement.Current.IsEnabled) { throw '中断データの公開パス欄がありません' }
        $value=$null
        if(-not $fieldElement.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$value)) { throw '中断データの公開パス欄を入力できません' }
        $value.SetValue($resolved)
        Invoke $app '中断データを開く（自動取得しない）'
    }
    'Close' {
        if(-not $app){throw '対象の操作画面なし'}
        [void][KtzPickerInput]::PostMessage([IntPtr]$app.Current.NativeWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)
        Write-Output '所有する操作画面へ通常終了要求'
    }
}

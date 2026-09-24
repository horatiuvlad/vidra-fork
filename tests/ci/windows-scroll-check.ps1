# Does a packaged Vidra app scroll on Windows? (issue #14, item 1)
#
# Usage: windows-scroll-check.ps1 -Exe <path\to\App.Host.exe> -OutDir <dir>
#
# Uses the scaffolded template unmodified, in a window short enough that the
# page overflows it, then scrolls it three ways:
#   1. a real OS mouse wheel over the window (what a user does),
#   2. a wheel event injected into the renderer over CDP,
#   3. a real OS PageDown key press.
# The verdict on 1 is read off the screen: the top of the page must move. When
# WebView2's DevTools port opens, scrollY is reported too, and 2 runs; 1 failing
# while 2 works would put the bug in WinUI/WebView2 input routing rather than in
# the page.
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = "Stop"
$cdp = Join-Path $PSScriptRoot "cdp.mjs"

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class U32 {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    // The biggest visible top-level window the process owns. Process.MainWindowHandle
    // can stay zero for a WinUI window, so this does not rely on it.
    public static IntPtr MainWindowOf(uint pid) {
        IntPtr best = IntPtr.Zero; long bestArea = 0;
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != pid || !IsWindowVisible(h)) return true;
            RECT r; GetWindowRect(h, out r);
            long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            if (area > bestArea) { bestArea = area; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }
}
"@

function Shot([string]$Name) {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $OutDir "$Name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

# A strip of the window's client area, as a bitmap. Top of the page only: the
# badge and the title, above the counter card whose number changes every 10s.
function Grab-Strip($hwnd) {
    $r = New-Object U32+RECT
    [U32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $w = ($r.Right - $r.Left) - 60; $h = 160
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left + 20, $r.Top + 40, 0, 0, (New-Object System.Drawing.Size $w, $h))
    $g.Dispose()
    return $bmp
}

# Share of sampled pixels that differ between two strips.
function Diff-Ratio($a, $b) {
    $n = 0; $d = 0
    for ($y = 0; $y -lt $a.Height; $y += 3) {
        for ($x = 0; $x -lt $a.Width; $x += 3) {
            $p = $a.GetPixel($x, $y); $q = $b.GetPixel($x, $y)
            $n++
            if ([Math]::Abs($p.R - $q.R) + [Math]::Abs($p.G - $q.G) + [Math]::Abs($p.B - $q.B) -gt 30) { $d++ }
        }
    }
    return [Math]::Round($d / $n, 4)
}

function Wheel([int]$Notches) {
    $step = if ($Notches -lt 0) { 120 } else { -120 }
    for ($n = 0; $n -lt [Math]::Abs($Notches); $n++) {
        [U32]::mouse_event(0x0800, 0, 0, $step, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 150
    }
    Start-Sleep -Seconds 1
}

function Page-State {
    $json = & node $cdp eval 'JSON.stringify({ y: Math.round(scrollY), sh: document.scrollingElement.scrollHeight, ih: innerHeight, focus: document.hasFocus(), hit: (document.elementFromPoint(innerWidth/2, innerHeight/2)||{}).tagName })'
    if ($LASTEXITCODE -ne 0) { throw "CDP evaluate failed" }
    return $json | ConvertFrom-Json
}

function Reset-Scroll {
    & node $cdp eval 'scrollTo(0, 0); scrollY' | Out-Null
    Start-Sleep -Milliseconds 500
}

# WebView2 ignored WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS on the runner (the
# browser process started without the flag), so the port is also opened through
# the per-executable policy key, which is the documented way. DevTools is only
# used to read scrollY; the verdict comes from the screen, so the check stands
# without it.
$exeName = Split-Path $Exe -Leaf
$policy = "HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
New-Item -Path $policy -Force | Out-Null
New-ItemProperty -Path $policy -Name $exeName -Value "--remote-debugging-port=9222" -PropertyType String -Force | Out-Null
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"

$log = Join-Path $OutDir "scroll-app.log"
$app = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"

try {
    # Ready = a window, and the first counter line, which means the page loaded
    # and React rendered.
    $hwnd = [IntPtr]::Zero
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Seconds 1
        if ($app.HasExited) { throw "the app exited with $($app.ExitCode)" }
        $hwnd = [U32]::MainWindowOf([uint32]$app.Id)
        $fs = $null
        if (Test-Path $log) {
            $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite, Delete')
            try { $text = (New-Object System.IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
            if ($hwnd -ne [IntPtr]::Zero -and $text.Contains("Counter is now")) { break }
        }
    }
    if ($hwnd -eq [IntPtr]::Zero) { throw "the app never showed a window" }

    $devtools = $false
    try {
        $targets = @(Invoke-RestMethod http://127.0.0.1:9222/json/list -TimeoutSec 3)
        $devtools = [bool]($targets | Where-Object { $_.type -eq "page" })
    } catch { }
    Write-Host "DevTools reachable: $devtools"
    if (-not $devtools) {
        Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Select-Object -First 1 |
            ForEach-Object { Write-Host "  browser: $($_.CommandLine.Substring(0, [Math]::Min(300, $_.CommandLine.Length)))" }
    }

    # Short enough that the unmodified template (~850px of content) overflows,
    # which is the situation the issue describes: a scrollbar, and no scrolling.
    [U32]::MoveWindow($hwnd, 40, 40, 1000, 520, $true) | Out-Null
    Start-Sleep -Seconds 2
    [U32]::SetForegroundWindow($hwnd) | Out-Null
    $r = New-Object U32+RECT
    [U32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $cx = [int](($r.Left + $r.Right) / 2); $cy = [int](($r.Top + $r.Bottom) / 2)
    Write-Host "window rect: $($r.Left),$($r.Top) - $($r.Right),$($r.Bottom); centre $cx,$cy"
    [U32]::SetCursorPos($cx, $cy) | Out-Null
    Start-Sleep -Milliseconds 500
    $p = New-Object U32+POINT; $p.X = $cx; $p.Y = $cy
    $cls = New-Object System.Text.StringBuilder 256
    [U32]::GetClassName([U32]::WindowFromPoint($p), $cls, 256) | Out-Null
    Write-Host "window under the cursor: class '$cls'"

    if ($devtools) {
        $s0 = Page-State
        Write-Host "page: scrollHeight $($s0.sh), innerHeight $($s0.ih), scrollY $($s0.y)"
        if ($s0.sh -le $s0.ih) { throw "the page does not overflow the window, so there is nothing to scroll (test setup problem)" }
    }

    # Control: with no input the strip must not change, or the comparison
    # below means nothing.
    $a = Grab-Strip $hwnd; Start-Sleep -Seconds 2; $b = Grab-Strip $hwnd
    $idle = Diff-Ratio $a $b
    Write-Host "idle difference: $idle"
    if ($idle -gt 0.01) { throw "the page changes on its own ($idle), so a pixel comparison cannot judge scrolling" }
    Shot "scroll-0-before"

    # 1. A real OS mouse wheel over the window, five notches down.
    $before = Grab-Strip $hwnd
    Wheel 5
    $after = Grab-Strip $hwnd
    $wheelDiff = Diff-Ratio $before $after
    $osWheel = $wheelDiff -gt 0.05
    $wheelY = if ($devtools) { (Page-State).y } else { "n/a" }
    Shot "scroll-1-after-os-wheel"
    Write-Host "OS wheel: strip changed $wheelDiff, scrollY $wheelY"

    # 2. A wheel injected into the renderer, bypassing Windows input routing.
    $cdpWheel = "n/a"
    if ($devtools) {
        Reset-Scroll
        & node $cdp Input.dispatchMouseEvent (@{ type = "mouseWheel"; x = 300; y = 200; deltaX = 0; deltaY = 600 } | ConvertTo-Json -Compress) | Out-Null
        Start-Sleep -Seconds 1
        $cdpWheel = (Page-State).y -gt 0
        Write-Host "CDP wheel scrolled: $cdpWheel"
    }

    # 3. A real OS PageDown. Informational: it needs the WebView to hold keyboard
    # focus, which nothing here arranges beyond bringing the window forward.
    if ($devtools) { Reset-Scroll } else { Wheel -20 }
    [U32]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 300
    $before = Grab-Strip $hwnd
    [System.Windows.Forms.SendKeys]::SendWait("{PGDN}")
    Start-Sleep -Seconds 1
    $keyDiff = Diff-Ratio $before (Grab-Strip $hwnd)
    Write-Host "OS PageDown: strip changed $keyDiff"

    $summary = @"
### Scroll on Windows (issue #14, item 1)

| input | result |
|---|---|
| no input (control) | strip changed $idle |
| OS mouse wheel, 5 notches | strip changed $wheelDiff, scrollY $wheelY -> **scrolled: $osWheel** |
| wheel injected into the renderer (CDP) | scrolled: $cdpWheel |
| OS PageDown | strip changed $keyDiff |
"@
    Write-Host $summary
    $summary | Out-File -Append -FilePath $env:GITHUB_STEP_SUMMARY

    if (-not $osWheel) { throw "a real mouse wheel does not scroll the packaged app" }
    Write-Host "==> PASS - the packaged app scrolls with a real mouse wheel"
} finally {
    if (-not $app.HasExited) { $app.Kill() }
    foreach ($f in @($log, "$log.err")) { if (Test-Path $f) { Write-Host "---- $f"; Get-Content $f | Select-Object -Last 5 } }
}

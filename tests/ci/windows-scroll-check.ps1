# Does a packaged Vidra app scroll on Windows? (issue #14, item 1)
#
# Usage: windows-scroll-check.ps1 -Exe <path\to\App.Host.exe> -OutDir <dir>
#
# Uses the scaffolded template unmodified. Launches the app with WebView2's DevTools port open, so the page's scroll
# position can be read from outside, then scrolls it three ways:
#   1. a real OS mouse wheel over the window (what a user does),
#   2. a wheel event injected into the renderer over CDP,
#   3. a real OS PageDown key press.
# 1 failing while 2 works would put the bug in WinUI/WebView2 input routing
# rather than in the page. The page must overflow the window for any of this to
# mean something, so that is asserted first.
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

function Page-State {
    $json = & node $cdp eval 'JSON.stringify({ y: Math.round(scrollY), sh: document.scrollingElement.scrollHeight, ih: innerHeight, focus: document.hasFocus(), hit: (document.elementFromPoint(innerWidth/2, innerHeight/2)||{}).tagName })'
    if ($LASTEXITCODE -ne 0) { throw "CDP evaluate failed" }
    return $json | ConvertFrom-Json
}

function Reset-Scroll {
    & node $cdp eval 'scrollTo(0, 0); scrollY' | Out-Null
    Start-Sleep -Milliseconds 500
}

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
$log = Join-Path $OutDir "scroll-app.log"
$app = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"

try {
    $ready = $false; $hwnd = [IntPtr]::Zero; $devtools = "not tried"
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Seconds 1
        if ($app.HasExited) { throw "the app exited with $($app.ExitCode)" }
        $hwnd = [U32]::MainWindowOf([uint32]$app.Id)
        try {
            $targets = @(Invoke-RestMethod http://127.0.0.1:9222/json/list -TimeoutSec 2)
            $devtools = ($targets | ForEach-Object { "$($_.type) $($_.url)" }) -join "; "
            if (($targets | Where-Object { $_.type -eq "page" -and $_.url -notlike "about:*" }) -and $hwnd -ne [IntPtr]::Zero) { $ready = $true; break }
        } catch { $devtools = "no answer: $($_.Exception.Message)" }
        if ($i % 10 -eq 9) { Write-Host "  [$($i + 1)s] window $hwnd; devtools: $devtools" }
    }
    if (-not $ready) {
        Write-Host "---- listening TCP ports and their processes"
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 1024 } |
            ForEach-Object { "  $($_.LocalAddress):$($_.LocalPort) $((Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName)" }
        Write-Host "---- msedgewebview2 command lines"
        Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Select-Object -First 3 |
            ForEach-Object { "  " + $_.CommandLine.Substring(0, [Math]::Min(400, $_.CommandLine.Length)) }
        throw "not ready: window $hwnd; devtools: $devtools"
    }
    # Give React time to render.
    Start-Sleep -Seconds 5

    # Short enough that the unmodified template (~850px of content) overflows,
    # which is the situation the issue describes: a scrollbar, and no scrolling.
    [U32]::MoveWindow($hwnd, 40, 40, 1000, 520, $true) | Out-Null
    Start-Sleep -Seconds 2
    [U32]::SetForegroundWindow($hwnd) | Out-Null
    $r = New-Object U32+RECT
    [U32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $cx = [int](($r.Left + $r.Right) / 2); $cy = [int](($r.Top + $r.Bottom) / 2)
    Write-Host "window rect: $($r.Left),$($r.Top) - $($r.Right),$($r.Bottom); centre $cx,$cy"

    $s0 = Page-State
    Write-Host "page: scrollHeight $($s0.sh), innerHeight $($s0.ih), scrollY $($s0.y), element at centre $($s0.hit)"
    if ($s0.sh -le $s0.ih) { throw "the page does not overflow the window, so there is nothing to scroll (test setup problem)" }
    Shot "scroll-0-before"

    # 1. OS mouse wheel, with the cursor over the window. No click: Windows
    # routes the wheel to the window under the cursor, as a user's would be.
    [U32]::SetCursorPos($cx, $cy) | Out-Null
    Start-Sleep -Milliseconds 300
    $p = New-Object U32+POINT; $p.X = $cx; $p.Y = $cy
    $under = [U32]::WindowFromPoint($p)
    $cls = New-Object System.Text.StringBuilder 256
    [U32]::GetClassName($under, $cls, 256) | Out-Null
    Write-Host "window under the cursor: class '$cls'"
    for ($n = 0; $n -lt 5; $n++) {
        [U32]::mouse_event(0x0800, 0, 0, -120, [UIntPtr]::Zero)   # MOUSEEVENTF_WHEEL, one notch down
        Start-Sleep -Milliseconds 150
    }
    Start-Sleep -Seconds 1
    $s1 = Page-State
    Shot "scroll-1-os-wheel"
    $osWheel = $s1.y -gt $s0.y
    Write-Host "OS wheel: scrollY $($s0.y) -> $($s1.y)"

    # 2. The same wheel, injected into the renderer.
    Reset-Scroll
    & node $cdp Input.dispatchMouseEvent (@{ type = "mouseWheel"; x = [int]($s0.ih / 2); y = [int]($s0.ih / 2); deltaX = 0; deltaY = 600 } | ConvertTo-Json -Compress) | Out-Null
    Start-Sleep -Seconds 1
    $s2 = Page-State
    $cdpWheel = $s2.y -gt 0
    Write-Host "CDP wheel: scrollY 0 -> $($s2.y)"

    # 3. OS keyboard. Informational: it depends on the WebView holding keyboard
    # focus, which nothing here arranges beyond bringing the window forward.
    Reset-Scroll
    [U32]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("{PGDN}")
    Start-Sleep -Seconds 1
    $s3 = Page-State
    $osKey = $s3.y -gt 0
    Write-Host "OS PageDown: scrollY 0 -> $($s3.y) (page has focus: $($s3.focus))"

    Write-Host ""
    Write-Host "| input | scrolled |"
    Write-Host "|---|---|"
    Write-Host "| OS mouse wheel over the window | $osWheel |"
    Write-Host "| wheel injected into the renderer (CDP) | $cdpWheel |"
    Write-Host "| OS PageDown | $osKey |"
    @"
### Scroll on Windows (issue #14, item 1)

| input | scrolled |
|---|---|
| OS mouse wheel over the window | $osWheel |
| wheel injected into the renderer (CDP) | $cdpWheel |
| OS PageDown | $osKey |
"@ | Out-File -Append -FilePath $env:GITHUB_STEP_SUMMARY

    if (-not $osWheel) { throw "a real mouse wheel does not scroll the packaged app" }
    Write-Host "==> PASS - the packaged app scrolls with a real mouse wheel"
} finally {
    if (-not $app.HasExited) { $app.Kill() }
    foreach ($f in @($log, "$log.err")) { if (Test-Path $f) { Write-Host "---- $f"; Get-Content $f | Select-Object -Last 30 } }
}

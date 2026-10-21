# Exercise `vidra dev` end to end on Windows: Vite starts, the host builds under
# `dotnet watch`, the app actually launches, its bridge answers, and a C# edit
# reaches the running app.
#
# Usage: dev-loop-smoke.ps1 -AppDir <path\to\scaffolded\app> -Cli <path\to\cli.js>
#                           [-ReadyTimeout 300] [-ReloadTimeout 180] [-Screenshot <png>]
#
# The PowerShell counterpart of dev-loop-smoke.sh, which tears its session down
# through POSIX process groups that git-bash on the Windows runner does not
# provide. Here the session runs under one cmd.exe whose tree `taskkill /T`
# takes down: Vite, dotnet watch and the app it launched.
#
# As in the bash script, what is asserted is that the edit reaches the app, not
# how: a hot-reload delta and a rebuild + relaunch are both correct outcomes.
param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [Parameter(Mandatory = $true)][string]$Cli,
    [int]$ReadyTimeout = 300,
    [int]$ReloadTimeout = 180,
    [string]$Screenshot = ""
)

$ErrorActionPreference = "Stop"

# Native file notifications routinely fail to fire for a CI working directory;
# polling is slower but deterministic.
if (-not $env:DOTNET_USE_POLLING_FILE_WATCHER) { $env:DOTNET_USE_POLLING_FILE_WATCHER = "1" }

$ReadyLine = "host ready"
$EditMarker = "[smoke] edit applied"
$CounterLine = "[MainPage] Counter is now"

$log = Join-Path $env:RUNNER_TEMP "vidra-dev-$(Get-Random).log"
if ($env:VIDRA_DEV_LOG) { $log = $env:VIDRA_DEV_LOG }
Set-Location $AppDir

# Reads the log while cmd.exe still holds it open for writing.
function Read-Log {
    if (-not (Test-Path $log)) { return @() }
    $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite, Delete')
    try {
        $reader = New-Object System.IO.StreamReader($fs)
        return $reader.ReadToEnd() -split "`r?`n"
    } finally { $fs.Dispose() }
}

# Literal substring match: -like would read "[MainPage]" as a character class.
function Find-Lines([string]$Needle, [int]$From = 0) {
    @(Read-Log | Select-Object -Skip $From | Where-Object { $_.Contains($Needle) })
}

function Dump-Log([int]$From = 0) {
    Read-Log | Select-Object -Skip $From | ForEach-Object { "    $_" }
}

# Ready reports from the CLI, not the raw `[vidra] host ready` sentinel.
function Ready-Count {
    @(Find-Lines $ReadyLine | Where-Object { -not $_.Contains("[vidra]") }).Count
}

function Save-Screenshot([string]$Path) {
    if (-not $Path) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Host "==> screenshot: $Path"
    } catch {
        Write-Host "::warning::screenshot failed: $_"
    }
}

function Stop-Session {
    if ($script:session -and -not $script:session.HasExited) {
        & taskkill /PID $script:session.Id /T /F 2>&1 | Out-Null
    }
}

function Fail([string]$Message, [int]$From = 0) {
    Write-Host "::error::$Message"
    Dump-Log $From
    Stop-Session
    exit 1
}

function Wait-Ready([int]$Want, [int]$Limit) {
    for ($waited = 0; $waited -lt $Limit; $waited += 2) {
        if ((Ready-Count) -ge $Want) { return $true }
        if ($script:session.HasExited) { Fail "vidra dev exited before the host reached readiness" }
        Start-Sleep -Seconds 2
    }
    return $false
}

Write-Host "==> starting: vidra dev --target windows (log: $log)"
$cmdLine = "/d /s /c `"`"node`" `"$Cli`" dev --target windows > `"$log`" 2>&1`""
$script:session = Start-Process -FilePath "cmd.exe" -ArgumentList $cmdLine -PassThru -NoNewWindow

try {
    if (-not (Wait-Ready 1 $ReadyTimeout)) { Fail "the host never reached readiness within ${ReadyTimeout}s" }
    Write-Host "==> host ready"

    if ((Find-Lines "vite ready").Count -eq 0) { Fail "Vite never reported ready" }
    Write-Host "==> vite ready"

    # The template page increments the JS counter every 10s, so a counter line
    # means a C# -> JS -> C# round-trip over the dev bridge.
    for ($waited = 0; $waited -lt 60; $waited += 2) {
        if ((Find-Lines $CounterLine).Count -gt 0) { break }
        if ((Find-Lines "Counter increment failed").Count -gt 0) { Fail "the bridge call from C# into JS failed" }
        Start-Sleep -Seconds 2
    }
    if ((Find-Lines $CounterLine).Count -eq 0) { Fail "no counter round-trip within 60s of readiness" }
    Write-Host "==> bridge round-trip in the dev session"
    Save-Screenshot $Screenshot

    $mainPage = Get-ChildItem -Path src -Recurse -Filter MainPage.cs | Select-Object -First 1
    if (-not $mainPage) { Fail "could not find MainPage.cs to edit" }

    $before = @(Read-Log).Count
    $readyBefore = Ready-Count
    Write-Host "==> editing $($mainPage.FullName)"
    $src = [System.IO.File]::ReadAllText($mainPage.FullName)
    $edited = [regex]::Replace($src, '(private async Task OnTickAsync\([^)]*\)\s*\{)',
        "`$1`n        System.Console.WriteLine(`"$EditMarker`");")
    if ($edited -eq $src) { Fail "the edit did not apply to $($mainPage.Name) - has OnTickAsync been renamed?" }
    [System.IO.File]::WriteAllText($mainPage.FullName, $edited)

    $landed = $false
    for ($waited = 0; $waited -lt $ReloadTimeout; $waited += 3) {
        if ((Find-Lines $EditMarker $before).Count -gt 0) { $landed = $true; break }
        if ($script:session.HasExited) { Fail "vidra dev exited while waiting for the edit to take effect" $before }
        Start-Sleep -Seconds 3
    }
    if (-not $landed) { Fail "the edit never reached the running app within ${ReloadTimeout}s" $before }

    Write-Host "---- session output ----"
    Dump-Log | Select-Object -Last 60

    if ((Ready-Count) -gt $readyBefore) {
        Write-Host "==> the edit reached the app after a rebuild + relaunch (~${waited}s)"
    } else {
        Write-Host "==> the edit reached the running app in place, no relaunch (~${waited}s)"
    }
    Write-Host "==> PASS - dev session starts, serves, launches the app, the bridge answers, and an edit reaches it"
} finally {
    Stop-Session
}
exit 0

# Verify the packaged Windows build: signature, then a real launch.
#
# Usage: launch-windows-app.ps1 -Zip <path\to\App.zip> [-TimeoutSeconds 120]
#
# Asserts the shipped .exe carries an Authenticode signature (self-signed is
# fine — see windows-selfsigned-cert.ps1), then runs it with VIDRA_E2E_PROOF set
# and waits for the bridge round-trip proof written by the E2E MainPage.
param(
    [Parameter(Mandatory = $true)][string]$Zip,
    [Parameter(Mandatory = $true)][string]$Cli,
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"

$stage = Join-Path $env:RUNNER_TEMP "vidra-e2e-$(Get-Random)"
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Write-Host "==> expanding $Zip"
Expand-Archive -Path $Zip -DestinationPath $stage -Force

$exe = Get-ChildItem -Path $stage -Recurse -Filter "*.Host.exe" | Select-Object -First 1
if (-not $exe) {
    $exe = Get-ChildItem -Path $stage -Recurse -Filter "*.exe" | Select-Object -First 1
}
if (-not $exe) {
    Write-Host "::error::no .exe found inside $Zip"
    exit 1
}
Write-Host "==> found $($exe.FullName)"

# The substantive check lives in the CLI, so `vidra build` and CI share one
# implementation. What follows is a deliberately independent re-assertion —
# a test should not let the thing under test be its own judge.
Write-Host "==> vidra verify (the same checks vidra build performs)"
& node $Cli verify $exe.FullName
if ($LASTEXITCODE -ne 0) {
    Write-Host "::error::vidra verify failed for $($exe.FullName)"
    exit 1
}

Write-Host "==> independent authenticode re-check"
$sig = Get-AuthenticodeSignature -FilePath $exe.FullName
Write-Host "    status: $($sig.Status)"
Write-Host "    signer: $($sig.SignerCertificate.Subject)"
if ($sig.Status -eq "NotSigned") {
    Write-Host "::error::the shipped .exe is not signed"
    exit 1
}
# `UnknownError`/`UntrustedRoot` are expected for a self-signed certificate: the
# signature exists and is intact, it just doesn't chain to a trusted CA.
if ($sig.Status -ne "Valid" -and $sig.Status -ne "UnknownError" -and $sig.Status -ne "UntrustedRoot") {
    Write-Host "::error::unexpected signature status: $($sig.Status)"
    exit 1
}
if (-not $sig.TimeStamperCertificate) {
    Write-Host "::warning::signature is not timestamped — it will stop validating when the certificate expires"
}

$proof = Join-Path $stage "proof.txt"
$log = Join-Path $stage "app.log"
Write-Host "==> launching with VIDRA_E2E_PROOF=$proof"
$env:VIDRA_E2E_PROOF = $proof
$process = Start-Process -FilePath $exe.FullName -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"

for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
    if (Test-Path $proof) { break }
    if ($process.HasExited) { break }
    Start-Sleep -Seconds 1
}

if (Test-Path $proof) {
    $value = (Get-Content $proof -Raw).Trim()
    Write-Host "==> bridge round-trip proof: '$value'"
    if ($value -ne "1") {
        Write-Host "::error::unexpected proof value (want 1, got '$value')"
        exit 1
    }
    Write-Host "==> PASS - packaged app launched and completed a C#<->JS round-trip"
    if (-not $process.HasExited) { $process.Kill() }
    exit 0
}

Write-Host "::error::the packaged app produced no bridge proof within ${TimeoutSeconds}s"
foreach ($f in @($log, "$log.err")) {
    if (Test-Path $f) {
        Write-Host "---- $f ----"
        Get-Content $f | Select-Object -First 60 | ForEach-Object { "    $_" }
    }
}
if (-not $process.HasExited) {
    Write-Host "---- process still running (the WebView likely never reached the bridge) ----"
    $process.Kill()
} else {
    Write-Host "---- process exited with code $($process.ExitCode) ----"
}
exit 1

# Create a throwaway Authenticode certificate for CI.
#
# Same rationale as the macOS script: signtool only needs a certificate with a
# private key and the codeSigning EKU. Chain trust matters for SmartScreen
# reputation, not for producing and verifying a signature — so the entire
# Windows signing path is testable without buying a certificate.
#
# Exports VIDRA_WINDOWS_CERT_THUMBPRINT via $GITHUB_ENV when present.
$ErrorActionPreference = "Stop"

$subject = if ($env:VIDRA_CI_CERT_SUBJECT) { $env:VIDRA_CI_CERT_SUBJECT } else { "CN=Vidra CI (self-signed)" }

Write-Host "==> creating a self-signed code-signing certificate"
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(1)

$thumbprint = $cert.Thumbprint
Write-Host "==> thumbprint: $thumbprint"

# Deliberately NOT added to the Root store. Adding a certificate to the trusted
# root store raises an interactive "do you want to install this certificate?"
# confirmation dialog, which on a headless runner nobody can answer — it simply
# hangs until the job times out.
#
# Trust is unnecessary anyway: signtool signs from the CurrentUser\My store via
# the thumbprint, and launch-windows-app.ps1 already accepts an UntrustedRoot
# signature as valid for this purpose.
Write-Host "==> certificate left in CurrentUser\My (untrusted root is expected)"

if ($env:GITHUB_ENV) {
    "VIDRA_WINDOWS_CERT_THUMBPRINT=$thumbprint" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
Write-Host "==> VIDRA_WINDOWS_CERT_THUMBPRINT=$thumbprint"

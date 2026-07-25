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

# Trusting the cert is best-effort — it only affects local verification, and
# signing works regardless.
try {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
    $store.Open("ReadWrite")
    $store.Add($cert)
    $store.Close()
    Write-Host "==> installed into the CurrentUser Root store"
} catch {
    Write-Host "note: could not install trust settings ($($_.Exception.Message)) — signing still works"
}

if ($env:GITHUB_ENV) {
    "VIDRA_WINDOWS_CERT_THUMBPRINT=$thumbprint" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
Write-Host "==> VIDRA_WINDOWS_CERT_THUMBPRINT=$thumbprint"

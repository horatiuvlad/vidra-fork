using System.Security.Cryptography;
using System.Text.Json;

namespace Vidra.Updates;

/// <summary>The feed said something this app is not willing to believe.</summary>
public sealed class SignatureVerificationException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// A detached signature over the exact bytes of <c>bundles.json</c>.
/// </summary>
/// <remarks>
/// Detached, and over the raw bytes, on purpose. Embedding the signature inside
/// the document it signs forces both sides to agree on a canonical JSON
/// serialization — whitespace, key order, number formatting — and any drift in
/// that agreement is a signature that silently stops verifying, or worse, one
/// that verifies a document the other side reads differently. Signing the bytes
/// as fetched has no such gap.
/// </remarks>
public sealed record ManifestSignature(string Algorithm, string KeyId, byte[] Signature)
{
    /// <summary>ECDSA on the NIST P-256 curve, SHA-256, DER-encoded signature.</summary>
    public const string EcdsaP256Sha256 = "ecdsa-p256-sha256";

    public static ManifestSignature Parse(string json)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException ex)
        {
            throw new SignatureVerificationException($"the signature file is not valid JSON: {ex.Message}", ex);
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new SignatureVerificationException("the signature file must be a JSON object");

            var algorithm = ReadString(root, "algorithm")
                ?? throw new SignatureVerificationException("the signature file names no algorithm");

            if (!string.Equals(algorithm, EcdsaP256Sha256, StringComparison.Ordinal))
            {
                // Refused rather than attempted: an algorithm this build does not
                // implement must never degrade into "accept it anyway".
                throw new SignatureVerificationException(
                    $"unsupported signature algorithm '{algorithm}' (this host verifies {EcdsaP256Sha256})");
            }

            var encoded = ReadString(root, "signature")
                ?? throw new SignatureVerificationException("the signature file carries no signature");

            byte[] signature;
            try
            {
                signature = Convert.FromBase64String(encoded);
            }
            catch (FormatException ex)
            {
                throw new SignatureVerificationException($"the signature is not valid base64: {ex.Message}", ex);
            }

            return new ManifestSignature(algorithm, ReadString(root, "keyId") ?? "unknown", signature);
        }
    }

    private static string? ReadString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

/// <summary>
/// Decides whether a manifest is allowed to be believed.
/// </summary>
/// <remarks>
/// The <c>sha256</c> on each entry answers "did this archive arrive intact",
/// which is a question about the network. This answers "did the person who holds
/// the signing key publish this", which is a question about the feed host — and
/// it is the one that matters, because a host that can serve a manifest can serve
/// a matching archive too, and nothing else stands between a compromised CDN and
/// arbitrary code running in the app.
/// </remarks>
public static class ManifestVerifier
{
    /// <summary>
    /// Verifies <paramref name="manifestBytes"/> against the configured keys.
    /// </summary>
    /// <param name="trustedKeys">
    /// Base64 SubjectPublicKeyInfo (SPKI) DER, one per accepted key. More than
    /// one so a key can be rotated: publish under the new key while apps in the
    /// wild still trust the old one.
    /// </param>
    /// <param name="signatureJson">Contents of <c>bundles.json.sig</c>, or null if absent.</param>
    /// <exception cref="SignatureVerificationException">
    /// Keys are configured and the manifest is not signed by one of them.
    /// </exception>
    public static void Verify(
        byte[] manifestBytes,
        string? signatureJson,
        IReadOnlyList<string> trustedKeys)
    {
        ArgumentNullException.ThrowIfNull(manifestBytes);
        ArgumentNullException.ThrowIfNull(trustedKeys);

        if (trustedKeys.Count == 0)
            return; // Unsigned feeds are allowed; the host warns about them.

        if (string.IsNullOrWhiteSpace(signatureJson))
        {
            // Fail closed. An app configured to require signatures must not
            // install from a feed that simply stopped providing one — that is
            // exactly what an attacker who can replace the manifest would do.
            throw new SignatureVerificationException(
                "the feed is not signed, but this app requires a signed manifest");
        }

        var signature = ManifestSignature.Parse(signatureJson);

        foreach (var key in trustedKeys)
        {
            if (Matches(manifestBytes, signature, key))
                return;
        }

        throw new SignatureVerificationException(
            $"the manifest signature (key {signature.KeyId}) does not match any of this app's "
            + $"{trustedKeys.Count} trusted key(s)");
    }

    private static bool Matches(byte[] manifestBytes, ManifestSignature signature, string trustedKey)
    {
        byte[] spki;
        try
        {
            spki = Convert.FromBase64String(trustedKey.Trim());
        }
        catch (FormatException)
        {
            // A malformed configured key is the developer's mistake, not the
            // feed's; skip it rather than letting it reject a good signature.
            return false;
        }

        try
        {
            using var ecdsa = ECDsa.Create();
            ecdsa.ImportSubjectPublicKeyInfo(spki, out _);

            // A key on some other curve would be a different security claim than
            // the one this format makes.
            if (ecdsa.KeySize != 256)
                return false;

            return ecdsa.VerifyData(
                manifestBytes,
                signature.Signature,
                HashAlgorithmName.SHA256,
                DSASignatureFormat.Rfc3279DerSequence);
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    /// <summary>
    /// Short, stable identifier for a public key — the first 8 hex characters of
    /// the SHA-256 of its SPKI bytes. Only ever used in messages, so a mismatch
    /// can be described without printing the whole key.
    /// </summary>
    public static string KeyId(byte[] spki)
        => Convert.ToHexStringLower(SHA256.HashData(spki))[..8];
}

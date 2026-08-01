using System.Security.Cryptography;
using System.Text;

namespace Vidra.Updates.Tests;

/// <summary>
/// Manifest signing is the difference between "this archive arrived intact" and
/// "this is what my publisher published". Every test here is a way a feed could
/// lie.
/// </summary>
public class ManifestSignatureTests
{
    private static readonly byte[] Manifest = Encoding.UTF8.GetBytes(
        """{ "schema": 1, "bundles": [ { "version": "1.1.0" } ] }""");

    [Fact]
    public void Accepts_a_manifest_signed_by_a_trusted_key()
    {
        var key = NewKey();

        ShouldNotThrow(() => ManifestVerifier.Verify(Manifest, SignatureFor(Manifest, key), [PublicKey(key)]));
    }

    [Fact]
    public void Rejects_a_manifest_that_changed_after_it_was_signed()
    {
        // The attack this exists to stop: a feed host swapping in an entry that
        // points at an archive of its choosing, with a hash that matches it.
        var key = NewKey();
        var signature = SignatureFor(Manifest, key);
        var tampered = Encoding.UTF8.GetBytes(
            """{ "schema": 1, "bundles": [ { "version": "9.9.9" } ] }""");

        Verifying(tampered, signature, [PublicKey(key)])
            .Should().Throw<SignatureVerificationException>()
            .WithMessage("*does not match*");
    }

    [Fact]
    public void Rejects_a_signature_from_a_key_the_app_does_not_trust()
    {
        var attacker = NewKey();

        Verifying(Manifest, SignatureFor(Manifest, attacker), [PublicKey(NewKey())])
            .Should().Throw<SignatureVerificationException>();
    }

    [Fact]
    public void Rejects_an_unsigned_feed_when_a_key_is_configured()
    {
        // Fail closed. Dropping the signature file is exactly what someone who
        // could replace the manifest would try.
        Verifying(Manifest, null, [PublicKey(NewKey())])
            .Should().Throw<SignatureVerificationException>()
            .WithMessage("*not signed*");
    }

    [Fact]
    public void Allows_an_unsigned_feed_when_no_key_is_configured()
    {
        // A local directory or a private feed is a legitimate unsigned case; the
        // host warns loudly instead of refusing.
        ShouldNotThrow(() => ManifestVerifier.Verify(Manifest, null, []));
    }

    [Fact]
    public void Accepts_either_key_while_one_is_being_rotated()
    {
        var oldKey = NewKey();
        var newKey = NewKey();
        var trusted = new[] { PublicKey(oldKey), PublicKey(newKey) };

        ShouldNotThrow(() => ManifestVerifier.Verify(Manifest, SignatureFor(Manifest, oldKey), trusted));
        ShouldNotThrow(() => ManifestVerifier.Verify(Manifest, SignatureFor(Manifest, newKey), trusted));
    }

    [Fact]
    public void Rejects_an_algorithm_this_host_does_not_implement()
    {
        // Never "unknown algorithm, assume it is fine".
        var signature = """{ "algorithm": "totally-legit", "keyId": "aaaa", "signature": "AAAA" }""";

        Verifying(Manifest, signature, [PublicKey(NewKey())])
            .Should().Throw<SignatureVerificationException>()
            .WithMessage("*unsupported signature algorithm*");
    }

    [Theory]
    [InlineData("{ not json")]
    [InlineData("[]")]
    [InlineData("""{ "keyId": "aaaa" }""")]
    [InlineData("""{ "algorithm": "ecdsa-p256-sha256" }""")]
    [InlineData("""{ "algorithm": "ecdsa-p256-sha256", "signature": "not base64 !!" }""")]
    public void Rejects_a_malformed_signature_file(string signature)
        => Verifying(Manifest, signature, [PublicKey(NewKey())])
            .Should().Throw<SignatureVerificationException>();

    [Fact]
    public void Rejects_a_key_on_another_curve()
    {
        // A P-521 key would verify a signature this format does not describe.
        using var wrongCurve = ECDsa.Create(ECCurve.NamedCurves.nistP521);
        var trusted = Convert.ToBase64String(wrongCurve.ExportSubjectPublicKeyInfo());

        Verifying(Manifest, SignatureFor(Manifest, wrongCurve), [trusted])
            .Should().Throw<SignatureVerificationException>();
    }

    [Fact]
    public void A_garbled_trusted_key_does_not_reject_a_good_signature()
    {
        // A typo in one configured key is the developer's mistake; it must not
        // take out a signature that another configured key verifies.
        var key = NewKey();

        ShouldNotThrow(() => ManifestVerifier.Verify(
            Manifest,
            SignatureFor(Manifest, key),
            ["!!!not base64!!!", PublicKey(key)]));
    }

    [Fact]
    public void Key_ids_are_stable_and_short()
    {
        using var key = NewKey();
        var spki = key.ExportSubjectPublicKeyInfo();

        var id = ManifestVerifier.KeyId(spki);

        id.Should().HaveLength(8);
        id.Should().Be(ManifestVerifier.KeyId(spki));
        id.Should().MatchRegex("^[0-9a-f]{8}$");
    }

    private static ECDsa NewKey() => ECDsa.Create(ECCurve.NamedCurves.nistP256);

    private static string PublicKey(ECDsa key) => Convert.ToBase64String(key.ExportSubjectPublicKeyInfo());

    private static string SignatureFor(byte[] manifest, ECDsa key)
    {
        var signature = key.SignData(
            manifest,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.Rfc3279DerSequence);

        var keyId = ManifestVerifier.KeyId(key.ExportSubjectPublicKeyInfo());
        return $$"""
            { "algorithm": "ecdsa-p256-sha256", "keyId": "{{keyId}}", "signature": "{{Convert.ToBase64String(signature)}}" }
            """;
    }

    private static Action Verifying(byte[] manifest, string? signature, string[] trusted)
        => () => ManifestVerifier.Verify(manifest, signature, trusted);

    private static void ShouldNotThrow(Action action) => action.Should().NotThrow();
}

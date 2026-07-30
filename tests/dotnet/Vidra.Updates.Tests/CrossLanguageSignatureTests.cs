namespace Vidra.Updates.Tests;

/// <summary>
/// The signature is produced by Node (`vidra bundle`) and verified by .NET (the
/// host). Nothing in either codebase exercises that boundary — each side is
/// perfectly self-consistent while disagreeing about signature encoding, hash
/// input, or key format, and the symptom would be "updates just never install"
/// in the field.
/// </summary>
/// <remarks>
/// The fixture in <c>fixtures/</c> was produced by Node's <c>crypto.sign</c>,
/// exactly as the CLI produces one, and is committed so this runs on the Linux
/// leg without Node in the loop. Regenerate it with
/// <c>tests/smoke/regenerate-signature-fixture.mjs</c> if the format ever
/// changes — and if that changes, old installed apps stop accepting new feeds,
/// so it should not.
/// </remarks>
public class CrossLanguageSignatureTests
{
    [Fact]
    public void Verifies_a_signature_produced_by_the_publisher_CLI()
    {
        ManifestVerifier.Verify(ManifestBytes(), Signature(), [PublicKey()]);
    }

    [Fact]
    public void Rejects_the_same_signature_over_a_changed_manifest()
    {
        // Proves the fixture test above is actually checking something: flip one
        // byte of the manifest and the same signature must stop verifying.
        var tampered = ManifestBytes();
        tampered[^3] ^= 0x01;

        var verify = () => ManifestVerifier.Verify(tampered, Signature(), [PublicKey()]);

        verify.Should().Throw<SignatureVerificationException>();
    }

    [Fact]
    public void Reads_the_key_id_the_CLI_printed()
    {
        var signature = ManifestSignature.Parse(Signature());

        signature.Algorithm.Should().Be(ManifestSignature.EcdsaP256Sha256);
        signature.KeyId.Should().Be(ManifestVerifier.KeyId(Convert.FromBase64String(PublicKey())));
    }

    private static byte[] ManifestBytes() => File.ReadAllBytes(Fixture("bundles.json"));

    private static string Signature() => File.ReadAllText(Fixture("bundles.json.sig"));

    private static string PublicKey() => File.ReadAllText(Fixture("public-key.txt")).Trim();

    private static string Fixture(string name) => Path.Combine(AppContext.BaseDirectory, "fixtures", name);
}

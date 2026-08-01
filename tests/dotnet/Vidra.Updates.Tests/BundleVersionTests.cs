namespace Vidra.Updates.Tests;

public class BundleVersionTests
{
    [Theory]
    [InlineData("1.2.3", 1, 2, 3, null)]
    [InlineData("0.0.1", 0, 0, 1, null)]
    [InlineData("1.2.3-beta.1", 1, 2, 3, "beta.1")]
    [InlineData("1.2.3+build.5", 1, 2, 3, null)]
    [InlineData("1.2.3-rc.1+build.5", 1, 2, 3, "rc.1")]
    public void Parses(string text, int major, int minor, int patch, string? prerelease)
    {
        BundleVersion.TryParse(text, out var version).Should().BeTrue();

        version.Major.Should().Be(major);
        version.Minor.Should().Be(minor);
        version.Patch.Should().Be(patch);
        version.Prerelease.Should().Be(prerelease);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("1.2")]
    [InlineData("1.2.3.4")]
    [InlineData("v1.2.3")]
    [InlineData("1.2.x")]
    [InlineData("1.2.3-")]
    public void Rejects(string? text)
        => BundleVersion.TryParse(text, out _).Should().BeFalse();

    [Fact]
    public void Orders_numerically_not_lexically()
    {
        // The bug this exists to prevent: "1.2.10" < "1.2.9" as strings.
        Parse("1.2.10").Should().BeGreaterThan(Parse("1.2.9"));
    }

    [Theory]
    [InlineData("2.0.0", "1.9.9")]
    [InlineData("1.3.0", "1.2.99")]
    [InlineData("1.0.0", "1.0.0-rc.1")]
    [InlineData("1.0.0-rc.2", "1.0.0-rc.1")]
    [InlineData("1.0.0-rc.10", "1.0.0-rc.9")]
    [InlineData("1.0.0-beta", "1.0.0-alpha")]
    [InlineData("1.0.0-alpha.1", "1.0.0-alpha")]
    public void Orders(string greater, string lesser)
    {
        Parse(greater).Should().BeGreaterThan(Parse(lesser));
        Parse(lesser).Should().BeLessThan(Parse(greater));
    }

    [Fact]
    public void Build_metadata_does_not_affect_ordering()
        => Parse("1.0.0+a").Should().Be(Parse("1.0.0+b"));

    [Fact]
    public void Keeps_the_text_it_was_given()
        => Parse("1.2.3-rc.1+build.5").ToString().Should().Be("1.2.3-rc.1+build.5");

    private static BundleVersion Parse(string text)
    {
        BundleVersion.TryParse(text, out var version).Should().BeTrue($"'{text}' should parse");
        return version;
    }
}

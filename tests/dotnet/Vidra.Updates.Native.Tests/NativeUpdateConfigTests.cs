namespace Vidra.Updates.Native.Tests;

/// <summary>
/// Where a native feed URL comes from, and which source wins.
/// </summary>
/// <remarks>
/// Getting this wrong is silent by design — an app with no feed configured
/// logs nothing, because an updater that announces "no feed" on every launch of
/// every app trains people to ignore the line that matters. Silent failure is
/// exactly why the rules belong in a unit test rather than in a packaged app on
/// a platform runner.
/// </remarks>
public sealed class NativeUpdateConfigTests
{
    private const string Stamped = """
        {
          "feedUrl": "https://cdn.example.com/app/bundles.json",
          "channel": "stable",
          "native": {
            "feedUrl": "https://cdn.example.com/app/",
            "channel": "osx"
          }
        }
        """;

    [Fact]
    public void Reads_the_native_block()
    {
        var settings = NativeUpdateConfig.ParseStampedFile(Stamped);

        settings.FeedUrl.Should().Be("https://cdn.example.com/app/");
        settings.Channel.Should().Be("osx");
        settings.Enabled.Should().BeNull();
    }

    /// <summary>
    /// The two tiers share one file and one prefix. Reading the OTA feed URL as
    /// the native one would point Velopack at <c>bundles.json</c> and produce a
    /// failure a long way from its cause.
    /// </summary>
    [Fact]
    public void Does_not_mistake_the_OTA_feed_for_the_native_one()
    {
        var settings = NativeUpdateConfig.ParseStampedFile("""
            { "feedUrl": "https://cdn.example.com/app/bundles.json", "channel": "stable" }
            """);

        settings.FeedUrl.Should().BeNull();
        settings.Channel.Should().BeNull();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("{ not json")]
    [InlineData("[]")]
    [InlineData("""{ "native": "yes" }""")]
    public void Treats_anything_unreadable_as_nothing_configured(string? json)
    {
        var settings = NativeUpdateConfig.ParseStampedFile(json);

        settings.Should().Be(new NativeUpdateSettings());
    }

    [Fact]
    public void Reads_an_explicit_off_switch()
    {
        NativeUpdateConfig.ParseStampedFile("""{ "native": { "enabled": false } }""")
            .Enabled.Should().BeFalse();
    }

    [Fact]
    public void Trims_what_a_hand_edited_config_leaves_behind()
    {
        var settings = NativeUpdateConfig.ParseStampedFile("""
            { "native": { "feedUrl": "  https://cdn.example.com/app/  ", "channel": " " } }
            """);

        settings.FeedUrl.Should().Be("https://cdn.example.com/app/");
        settings.Channel.Should().BeNull();
    }

    // --- precedence -----------------------------------------------------------

    [Fact]
    public void Code_outranks_the_environment_and_the_stamped_file()
    {
        var resolved = NativeUpdateConfig.Resolve(
            fromCode: new NativeUpdateSettings(FeedUrl: "https://code/"),
            fromEnvironment: new NativeUpdateSettings(FeedUrl: "https://env/"),
            fromFile: new NativeUpdateSettings(FeedUrl: "https://file/"));

        resolved.FeedUrl.Should().Be("https://code/");
    }

    /// <summary>
    /// The environment is what makes a staging build or a CI round-trip
    /// possible without editing the app, so it has to outrank the file the
    /// build stamped in.
    /// </summary>
    [Fact]
    public void The_environment_outranks_the_stamped_file()
    {
        var resolved = NativeUpdateConfig.Resolve(
            fromCode: new NativeUpdateSettings(),
            fromEnvironment: new NativeUpdateSettings(FeedUrl: "https://env/"),
            fromFile: new NativeUpdateSettings(FeedUrl: "https://file/"));

        resolved.FeedUrl.Should().Be("https://env/");
    }

    /// <summary>
    /// Per field, not per source. Setting a channel in code must not throw away
    /// the feed URL the build stamped in — that would be an app that silently
    /// stops updating the moment someone configures anything.
    /// </summary>
    [Fact]
    public void Settles_each_field_on_its_own()
    {
        var resolved = NativeUpdateConfig.Resolve(
            fromCode: new NativeUpdateSettings(Channel: "beta"),
            fromEnvironment: new NativeUpdateSettings(),
            fromFile: new NativeUpdateSettings(FeedUrl: "https://file/", Channel: "osx"));

        resolved.FeedUrl.Should().Be("https://file/");
        resolved.Channel.Should().Be("beta");
    }

    [Fact]
    public void Is_on_unless_something_says_otherwise()
    {
        NativeUpdateConfig.Resolve(new(), new(), new()).Enabled.Should().BeTrue();
        NativeUpdateConfig.Resolve(new(), new(), new(Enabled: false)).Enabled.Should().BeFalse();
        NativeUpdateConfig.Resolve(new(Enabled: true), new(), new(Enabled: false)).Enabled.Should().BeTrue();
    }

    // --- environment ----------------------------------------------------------

    [Fact]
    public void Reads_the_environment_variables()
    {
        var env = new Dictionary<string, string?>
        {
            [NativeUpdateConfig.FeedUrlEnvironmentVariable] = "http://127.0.0.1:8098/",
            [NativeUpdateConfig.ChannelEnvironmentVariable] = "win",
            [NativeUpdateConfig.EnabledEnvironmentVariable] = "0",
        };

        var settings = NativeUpdateConfig.FromEnvironment(name => env.GetValueOrDefault(name));

        settings.FeedUrl.Should().Be("http://127.0.0.1:8098/");
        settings.Channel.Should().Be("win");
        settings.Enabled.Should().BeFalse();
    }

    [Theory]
    [InlineData("1", true)]
    [InlineData("true", true)]
    [InlineData("TRUE", true)]
    [InlineData("0", false)]
    [InlineData("false", false)]
    [InlineData("off", false)]
    // A typo must not read as "off": falling through to the next source is
    // recoverable, silently disabling updates is not.
    [InlineData("flase", null)]
    [InlineData("", null)]
    public void Understands_the_spellings_people_actually_type(string value, bool? expected)
    {
        NativeUpdateConfig.FromEnvironment(_ => value).Enabled.Should().Be(expected);
    }
}

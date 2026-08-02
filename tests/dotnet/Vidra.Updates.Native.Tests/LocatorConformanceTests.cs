using System.Reflection;
using Velopack.Locators;

namespace Vidra.Updates.Native.Tests;

/// <summary>
/// Velopack's own locator is the oracle: build one bundle, point both
/// implementations at it, and assert they answer identically.
/// </summary>
/// <remarks>
/// <para>
/// The standing objection to owning a locator is that it encodes an install
/// layout Velopack can change without calling it breaking, such as where
/// <c>packages/</c> lives, which <c>sq.version</c> wins, what counts as
/// portable. This is the answer to that objection, and it is a test rather than
/// a promise: the day they move something, it fails on us before it fails on a
/// user.
/// </para>
/// <para>
/// macOS only, and not because of a policy. <see cref="OsxVelopackLocator"/>
/// refuses to be constructed on a non-osx system, which is the whole reason
/// <see cref="VidraCatalystLocator"/> exists. Comparing against it therefore
/// has to happen on a real Mac, which the macOS CI leg is.
/// </para>
/// <para>
/// Properties are enumerated by reflection rather than listed, so a property
/// Velopack adds in a future release is compared without anyone remembering to
/// add it here.
/// </para>
/// </remarks>
public sealed class LocatorConformanceTests
{
    /// <summary>
    /// Compared by value. <c>Log</c> and <c>Process</c> are excluded: they are
    /// object identities, not answers about the install, and the logger is the
    /// one thing Vidra's locator deliberately implements differently, because
    /// Velopack's combined logger is internal.
    /// </summary>
    private static readonly string[] NotComparable = ["Log", "Process"];

    [MacOsFact]
    public void Answers_exactly_what_Velopacks_own_locator_answers()
    {
        if (!OperatingSystem.IsMacOS()) return;

        using var home = new TemporaryHome();
        using var app = AppBundleFixture.Create(appId: "com.vidra.conformance", version: "3.1.4", channel: "osx");
        var process = new FakeProcess(app.ExecutablePath);

        AssertSameAnswers(new OsxVelopackLocator(process, null), new VidraCatalystLocator(process));
    }

    /// <summary>
    /// The degenerate case matters as much as the happy one: an unpacked
    /// development build must look the same to both, or Vidra apps would report
    /// an install that is not there.
    /// </summary>
    [MacOsFact]
    public void Agrees_when_the_process_is_not_inside_a_bundle()
    {
        if (!OperatingSystem.IsMacOS()) return;

        using var home = new TemporaryHome();
        using var app = AppBundleFixture.Create();
        var process = new FakeProcess(app.LooseExecutable());

        AssertSameAnswers(new OsxVelopackLocator(process, null), new VidraCatalystLocator(process));
    }

    /// <summary>
    /// A bundle that was built but never packed, so there is no <c>UpdateMac</c>. Velopack
    /// treats it as not installed; so must we.
    /// </summary>
    [MacOsFact]
    public void Agrees_when_the_bundle_was_never_packed()
    {
        if (!OperatingSystem.IsMacOS()) return;

        using var home = new TemporaryHome();
        using var app = AppBundleFixture.Create(updateExe: false);
        var process = new FakeProcess(app.ExecutablePath);

        AssertSameAnswers(new OsxVelopackLocator(process, null), new VidraCatalystLocator(process));
    }

    private static void AssertSameAnswers(IVelopackLocator oracle, IVelopackLocator ours)
    {
        var compared = 0;

        foreach (var property in typeof(IVelopackLocator).GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (NotComparable.Contains(property.Name)) continue;

            compared++;
            Read(property, ours).Should().Be(
                Read(property, oracle),
                "VidraCatalystLocator.{0} must match OsxVelopackLocator.{0}: Velopack's install layout is the contract",
                property.Name);
        }

        // A reflection loop that silently compares nothing is a green test that
        // proves nothing; this is the guard against that.
        compared.Should().BeGreaterThan(5);

        ours.GetLocalPackages().Should().HaveCount(oracle.GetLocalPackages().Count);
        ours.GetLatestLocalFullPackage()?.FileName
            .Should().Be(oracle.GetLatestLocalFullPackage()?.FileName);
    }

    private static string? Read(PropertyInfo property, IVelopackLocator locator)
    {
        try
        {
            return property.GetValue(locator)?.ToString();
        }
        catch (TargetInvocationException ex)
        {
            // A property that throws is still an answer, and both had better
            // throw the same one. `ThisExeRelativePath` does exactly this when
            // the process is not under the app content directory.
            return $"threw {ex.InnerException?.GetType().Name}";
        }
    }
}

/// <summary>
/// A <see cref="FactAttribute"/> that skips itself off macOS, with the reason
/// in the test report rather than in a comment nobody reads.
/// </summary>
internal sealed class MacOsFactAttribute : FactAttribute
{
    public MacOsFactAttribute()
    {
        if (!OperatingSystem.IsMacOS())
        {
            Skip = "OsxVelopackLocator refuses to construct off macOS, which is the reason VidraCatalystLocator exists.";
        }
    }
}

using System.Globalization;

namespace Vidra.Updates;

/// <summary>
/// The subset of semver a bundle version needs: ordering, and knowing that a
/// prerelease sorts below the release it precedes.
/// </summary>
/// <remarks>
/// Deliberately not a general semver implementation. Bundle versions come from
/// the app's own <c>package.json</c> (see the versioning work in PR #6), so they
/// are already well-formed; what matters here is that <c>1.2.10</c> beats
/// <c>1.2.9</c> — which a string comparison gets wrong — and that
/// <c>1.3.0-beta.1</c> does not beat <c>1.3.0</c>. Build metadata (<c>+…</c>) is
/// ignored for ordering, as semver requires.
/// </remarks>
public readonly struct BundleVersion : IComparable<BundleVersion>, IEquatable<BundleVersion>
{
    private BundleVersion(int major, int minor, int patch, string? prerelease, string raw)
    {
        Major = major;
        Minor = minor;
        Patch = patch;
        Prerelease = prerelease;
        Raw = raw;
    }

    public int Major { get; }
    public int Minor { get; }
    public int Patch { get; }

    /// <summary>The dot-separated prerelease tag, or <see langword="null"/> for a release.</summary>
    public string? Prerelease { get; }

    public string Raw { get; }

    public static bool TryParse(string? value, out BundleVersion version)
    {
        version = default;
        if (string.IsNullOrWhiteSpace(value))
            return false;

        var raw = value.Trim();
        var text = raw;

        var plus = text.IndexOf('+');
        if (plus >= 0)
            text = text[..plus];

        string? prerelease = null;
        var dash = text.IndexOf('-');
        if (dash >= 0)
        {
            prerelease = text[(dash + 1)..];
            text = text[..dash];
            if (prerelease.Length == 0)
                return false;
        }

        var parts = text.Split('.');
        if (parts.Length != 3)
            return false;

        if (!TryParseNumber(parts[0], out var major)
            || !TryParseNumber(parts[1], out var minor)
            || !TryParseNumber(parts[2], out var patch))
        {
            return false;
        }

        version = new BundleVersion(major, minor, patch, prerelease, raw);
        return true;
    }

    private static bool TryParseNumber(string text, out int value)
        => int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value);

    public int CompareTo(BundleVersion other)
    {
        var core = Major.CompareTo(other.Major);
        if (core != 0) return core;
        core = Minor.CompareTo(other.Minor);
        if (core != 0) return core;
        core = Patch.CompareTo(other.Patch);
        if (core != 0) return core;

        // A release outranks any prerelease of the same core version.
        if (Prerelease is null && other.Prerelease is null) return 0;
        if (Prerelease is null) return 1;
        if (other.Prerelease is null) return -1;

        return ComparePrerelease(Prerelease, other.Prerelease);
    }

    private static int ComparePrerelease(string left, string right)
    {
        var leftParts = left.Split('.');
        var rightParts = right.Split('.');

        for (var i = 0; i < Math.Max(leftParts.Length, rightParts.Length); i++)
        {
            // The shorter set of identifiers sorts first: alpha < alpha.1.
            if (i >= leftParts.Length) return -1;
            if (i >= rightParts.Length) return 1;

            var leftIsNumber = TryParseNumber(leftParts[i], out var leftNumber);
            var rightIsNumber = TryParseNumber(rightParts[i], out var rightNumber);

            int comparison;
            if (leftIsNumber && rightIsNumber)
                comparison = leftNumber.CompareTo(rightNumber);
            else if (leftIsNumber)
                comparison = -1; // numeric identifiers sort below alphanumeric ones
            else if (rightIsNumber)
                comparison = 1;
            else
                comparison = string.CompareOrdinal(leftParts[i], rightParts[i]);

            if (comparison != 0) return comparison;
        }

        return 0;
    }

    public bool Equals(BundleVersion other) => CompareTo(other) == 0;

    public override bool Equals(object? obj) => obj is BundleVersion other && Equals(other);

    public override int GetHashCode() => HashCode.Combine(Major, Minor, Patch, Prerelease);

    public override string ToString() => Raw;

    public static bool operator >(BundleVersion left, BundleVersion right) => left.CompareTo(right) > 0;

    public static bool operator <(BundleVersion left, BundleVersion right) => left.CompareTo(right) < 0;

    public static bool operator >=(BundleVersion left, BundleVersion right) => left.CompareTo(right) >= 0;

    public static bool operator <=(BundleVersion left, BundleVersion right) => left.CompareTo(right) <= 0;

    public static bool operator ==(BundleVersion left, BundleVersion right) => left.Equals(right);

    public static bool operator !=(BundleVersion left, BundleVersion right) => !left.Equals(right);
}

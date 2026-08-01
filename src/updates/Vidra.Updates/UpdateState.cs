using System.Text;
using System.Text.Json;

namespace Vidra.Updates;

/// <summary>A bundle that has been promoted but has not yet proved it can boot.</summary>
public sealed record BundleProbation(string Sha256, int Attempts);

/// <summary>
/// What a bundle was chosen against — its version and the two contract
/// fingerprints of the host that accepted it.
/// </summary>
/// <remarks>
/// Recorded per bundle rather than per slot. Three parallel sets of
/// <c>Current*</c>/<c>Previous*</c>/<c>Pending*</c> fields would have to be moved
/// in step by every transition, and the first one that forgets is a bundle
/// carrying another bundle's identity.
/// </remarks>
public sealed record BundleIdentity(string Version, string CoreFingerprint, string AppFingerprint);

/// <summary>
/// The contracts of the binary that is running right now, and the version of the
/// bundle it ships with.
/// </summary>
public sealed record HostContracts(string CoreFingerprint, string AppFingerprint, string? EmbeddedVersion);

/// <summary>
/// What the host knows about installed bundles, persisted as
/// <c>vidra/bundles/state.json</c> in app data.
/// </summary>
/// <remarks>
/// <c>Current</c> is what serves; <see langword="null"/> means the embedded copy,
/// which is always present and is the floor. <c>Previous</c> exists so a failed
/// promotion has somewhere to fall back to that is not all the way down to the
/// shipped bundle. <c>Blocked</c> remembers what has already failed, so a broken
/// bundle is not downloaded and promoted again on the next check — without it,
/// rollback is a loop.
///
/// <c>Installed</c> records what each bundle was chosen against, so a launch can
/// ask whether the bundle it is about to serve is still compatible with the
/// binary underneath it. Nothing else can answer that: the feed's fingerprints
/// are consulted when an entry is selected, and a native update replaces the
/// binary long after that.
/// </remarks>
public sealed record UpdateState
{
    /// <summary>
    /// Bumped to 2 when <see cref="Installed"/> arrived. A schema-1 document has
    /// no identities, so nothing can vouch for the bundle it names — and
    /// <see cref="Parse"/> already resolves anything it cannot read to
    /// <see cref="Empty"/>, which serves the embedded copy. That normally costs
    /// every install one launch on the shipped UI; it costs nothing here,
    /// because no released version has ever written one.
    /// </summary>
    public const int SupportedSchema = 2;

    public static readonly UpdateState Empty = new();

    public string? Current { get; init; }

    public string? CurrentVersion { get; init; }

    public string? Previous { get; init; }

    public string? PreviousVersion { get; init; }

    public string? Pending { get; init; }

    public string? PendingVersion { get; init; }

    public BundleProbation? Probation { get; init; }

    public IReadOnlyList<string> Blocked { get; init; } = [];

    /// <summary>What each known bundle was chosen against, keyed by its sha256.</summary>
    public IReadOnlyDictionary<string, BundleIdentity> Installed { get; init; }
        = new Dictionary<string, BundleIdentity>(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Compares by value, including <see cref="Blocked"/> and <see cref="Installed"/>.
    /// </summary>
    /// <remarks>
    /// A record's synthesized equality compares <see cref="Blocked"/> by
    /// reference, so two states that are identical in every way — the one just
    /// written and the one just read back — would compare unequal purely because
    /// each holds its own list. Anything that asks "did this change?" before
    /// writing to disk would answer yes, always.
    /// </remarks>
    public bool Equals(UpdateState? other)
        => other is not null
            && Current == other.Current
            && CurrentVersion == other.CurrentVersion
            && Previous == other.Previous
            && PreviousVersion == other.PreviousVersion
            && Pending == other.Pending
            && PendingVersion == other.PendingVersion
            && Probation == other.Probation
            && Blocked.SequenceEqual(other.Blocked, StringComparer.Ordinal)
            && Installed.Count == other.Installed.Count
            && Installed.All(pair =>
                other.Installed.TryGetValue(pair.Key, out var theirs) && theirs == pair.Value);

    public override int GetHashCode()
    {
        var hash = new HashCode();
        hash.Add(Current);
        hash.Add(CurrentVersion);
        hash.Add(Previous);
        hash.Add(PreviousVersion);
        hash.Add(Pending);
        hash.Add(PendingVersion);
        hash.Add(Probation);
        foreach (var sha in Blocked)
            hash.Add(sha, StringComparer.Ordinal);
        // Folded into one value with XOR rather than added one by one: HashCode.Add
        // is order-dependent, a dictionary's enumeration order is not part of its
        // value, and two equal states must never hash differently.
        var installed = 0;
        foreach (var pair in Installed)
            installed ^= HashCode.Combine(
                pair.Key.GetHashCode(StringComparison.OrdinalIgnoreCase), pair.Value);
        hash.Add(installed);
        return hash.ToHashCode();
    }

    /// <summary>
    /// Reads a state document. Any damage — truncated write, hand-edit, a schema
    /// from a newer host — resolves to <see cref="Empty"/> rather than throwing:
    /// the consequence is serving the embedded copy, which is always correct, and
    /// an app that will not start because its update bookkeeping is unreadable
    /// would be a far worse failure than a missed update.
    /// </summary>
    public static UpdateState Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
            return Empty;

        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return Empty;

            if (!root.TryGetProperty("schema", out var schema)
                || schema.ValueKind != JsonValueKind.Number
                || schema.GetInt32() != SupportedSchema)
            {
                return Empty;
            }

            BundleProbation? probation = null;
            if (root.TryGetProperty("probation", out var probationElement)
                && probationElement.ValueKind == JsonValueKind.Object)
            {
                var sha = ReadString(probationElement, "sha256");
                var attempts = probationElement.TryGetProperty("attempts", out var attemptsElement)
                    && attemptsElement.ValueKind == JsonValueKind.Number
                        ? attemptsElement.GetInt32()
                        : 0;
                if (sha is not null)
                    probation = new BundleProbation(sha, attempts);
            }

            var blocked = new List<string>();
            if (root.TryGetProperty("blocked", out var blockedElement)
                && blockedElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in blockedElement.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.String && item.GetString() is { } sha)
                        blocked.Add(sha);
                }
            }

            var installed = new Dictionary<string, BundleIdentity>(StringComparer.OrdinalIgnoreCase);
            if (root.TryGetProperty("installed", out var installedElement)
                && installedElement.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in installedElement.EnumerateObject())
                {
                    if (property.Value.ValueKind != JsonValueKind.Object) continue;

                    var version = ReadString(property.Value, "version");
                    var core = ReadString(property.Value, "coreFingerprint");
                    var app = ReadString(property.Value, "appFingerprint");

                    // A half-written identity cannot vouch for anything, so drop it
                    // rather than record one that revalidation would have to guess at.
                    if (version is null || core is null || app is null) continue;

                    installed[property.Name] = new BundleIdentity(version, core, app);
                }
            }

            return new UpdateState
            {
                Installed = installed,
                Current = ReadString(root, "current"),
                CurrentVersion = ReadString(root, "currentVersion"),
                Previous = ReadString(root, "previous"),
                PreviousVersion = ReadString(root, "previousVersion"),
                Pending = ReadString(root, "pending"),
                PendingVersion = ReadString(root, "pendingVersion"),
                Probation = probation,
                Blocked = blocked,
            };
        }
        catch (JsonException)
        {
            return Empty;
        }
    }

    private static string? ReadString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public string ToJson()
    {
        var json = new StringBuilder();
        json.Append("{\n  \"schema\": ").Append(SupportedSchema);
        AppendString(json, "current", Current);
        AppendString(json, "currentVersion", CurrentVersion);
        AppendString(json, "previous", Previous);
        AppendString(json, "previousVersion", PreviousVersion);
        AppendString(json, "pending", Pending);
        AppendString(json, "pendingVersion", PendingVersion);

        if (Probation is { } probation)
        {
            json.Append(",\n  \"probation\": { \"sha256\": ").Append(Quote(probation.Sha256))
                .Append(", \"attempts\": ").Append(probation.Attempts).Append(" }");
        }

        if (Blocked.Count > 0)
        {
            json.Append(",\n  \"blocked\": [")
                .Append(string.Join(", ", Blocked.Select(Quote)))
                .Append(']');
        }

        if (Installed.Count > 0)
        {
            // Sorted, so the file a human opens twice looks the same twice.
            var entries = Installed
                .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .Select(pair =>
                    $"\n    {Quote(pair.Key)}: {{ \"version\": {Quote(pair.Value.Version)}, "
                    + $"\"coreFingerprint\": {Quote(pair.Value.CoreFingerprint)}, "
                    + $"\"appFingerprint\": {Quote(pair.Value.AppFingerprint)} }}");

            json.Append(",\n  \"installed\": {")
                .Append(string.Join(",", entries))
                .Append("\n  }");
        }

        json.Append("\n}\n");
        return json.ToString();
    }

    private static void AppendString(StringBuilder json, string name, string? value)
    {
        if (value is null) return;
        json.Append(",\n  ").Append(Quote(name)).Append(": ").Append(Quote(value));
    }

    private static string Quote(string value)
    {
        var quoted = new StringBuilder("\"");
        foreach (var c in value)
        {
            quoted.Append(c switch
            {
                '"' => "\\\"",
                '\\' => "\\\\",
                '\n' => "\\n",
                '\r' => "\\r",
                '\t' => "\\t",
                _ => c < ' ' ? $"\\u{(int)c:x4}" : c.ToString(),
            });
        }
        return quoted.Append('"').ToString();
    }
}

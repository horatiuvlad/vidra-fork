using System.Text;
using System.Text.Json;

namespace Vidra.Updates;

/// <summary>A bundle that has been promoted but has not yet proved it can boot.</summary>
public sealed record BundleProbation(string Sha256, int Attempts);

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
/// </remarks>
public sealed record UpdateState
{
    public const int SupportedSchema = 1;

    public static readonly UpdateState Empty = new();

    public string? Current { get; init; }

    public string? CurrentVersion { get; init; }

    public string? Previous { get; init; }

    public string? PreviousVersion { get; init; }

    public string? Pending { get; init; }

    public string? PendingVersion { get; init; }

    public BundleProbation? Probation { get; init; }

    public IReadOnlyList<string> Blocked { get; init; } = [];

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

            return new UpdateState
            {
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

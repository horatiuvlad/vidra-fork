using System.Text.Json;

namespace Vidra.Updates;

/// <summary>One publishable JS bundle, as it appears in <c>bundles.json</c>.</summary>
public sealed record BundleEntry
{
    public required string Version { get; init; }

    /// <summary>Absolute, or relative to the manifest's own URL.</summary>
    public required string Url { get; init; }

    /// <summary>Lowercase hex SHA-256 of the archive. Also the bundle's identity on disk.</summary>
    public required string Sha256 { get; init; }

    public long Size { get; init; }

    public required string CoreFingerprint { get; init; }

    public required string AppFingerprint { get; init; }

    /// <summary>Optional channel label; entries for other channels are ignored.</summary>
    public string? Channel { get; init; }
}

/// <summary>The published index of installable bundles.</summary>
public sealed record BundleManifest
{
    public const int SupportedSchema = 1;

    public int Schema { get; init; } = SupportedSchema;

    public IReadOnlyList<BundleEntry> Bundles { get; init; } = [];

    /// <summary>
    /// Parses a manifest. Reads the JSON tree by hand rather than deserializing
    /// into these records: the host runs trimmed and AOT-compiled on Mac
    /// Catalyst, where reflection-based deserialization is the classic thing that
    /// works in Debug and returns null in the artifact users install.
    /// </summary>
    /// <exception cref="BundleManifestException">The document is malformed or a newer schema.</exception>
    public static BundleManifest Parse(string json)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException ex)
        {
            throw new BundleManifestException($"the manifest is not valid JSON: {ex.Message}", ex);
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new BundleManifestException("the manifest must be a JSON object");

            var schema = root.TryGetProperty("schema", out var schemaElement)
                && schemaElement.ValueKind == JsonValueKind.Number
                    ? schemaElement.GetInt32()
                    : 0;

            if (schema != SupportedSchema)
            {
                // Refusing an unknown schema is the point: a future publisher that
                // adds a required field must not have it silently ignored by an
                // old client that then installs something it misunderstood.
                throw new BundleManifestException(
                    $"unsupported manifest schema {schema} (this host understands {SupportedSchema})");
            }

            var entries = new List<BundleEntry>();
            if (root.TryGetProperty("bundles", out var bundles) && bundles.ValueKind == JsonValueKind.Array)
            {
                foreach (var element in bundles.EnumerateArray())
                {
                    if (element.ValueKind != JsonValueKind.Object)
                        continue;

                    var version = ReadString(element, "version");
                    var url = ReadString(element, "url");
                    var sha256 = ReadString(element, "sha256");
                    var coreFingerprint = ReadString(element, "coreFingerprint");
                    var appFingerprint = ReadString(element, "appFingerprint");

                    // A single unusable entry must not poison the whole feed —
                    // an older client should keep installing the entries it does
                    // understand.
                    if (version is null || url is null || sha256 is null
                        || coreFingerprint is null || appFingerprint is null)
                    {
                        continue;
                    }

                    entries.Add(new BundleEntry
                    {
                        Version = version,
                        Url = url,
                        Sha256 = sha256.ToLowerInvariant(),
                        Size = element.TryGetProperty("size", out var size) && size.ValueKind == JsonValueKind.Number
                            ? size.GetInt64()
                            : 0,
                        CoreFingerprint = coreFingerprint,
                        AppFingerprint = appFingerprint,
                        Channel = ReadString(element, "channel"),
                    });
                }
            }

            return new BundleManifest { Schema = schema, Bundles = entries };
        }
    }

    private static string? ReadString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

public sealed class BundleManifestException(string message, Exception? inner = null)
    : Exception(message, inner);

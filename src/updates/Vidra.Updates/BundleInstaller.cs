using System.IO.Compression;
using System.Security.Cryptography;

namespace Vidra.Updates;

public sealed class BundleVerificationException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// Turns a downloaded archive into an installed bundle directory, or refuses to.
/// </summary>
/// <remarks>
/// Everything here is written as if the feed were hostile, because for update
/// code that is the only safe assumption: no store review sits between a
/// compromised CDN and the JS this extracts. Concretely — the archive is hashed
/// before anything is unpacked, entries that escape the destination are rejected
/// rather than sanitized, and the bundle only appears at its final path once it
/// is complete, so a killed process leaves a temporary directory rather than a
/// half-written bundle that looks installed.
/// </remarks>
public sealed class BundleInstaller(BundleStore store)
{
    private readonly BundleStore _store = store ?? throw new ArgumentNullException(nameof(store));

    /// <summary>
    /// Downloads, verifies and installs an entry, returning the directory it now
    /// occupies. An already-installed bundle is returned untouched.
    /// </summary>
    public async Task<string> InstallAsync(
        IBundleSource source,
        BundleEntry entry,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(entry);

        var destination = _store.BundleDirectory(entry.Sha256);
        if (Directory.Exists(destination) && File.Exists(Path.Combine(destination, "index.html")))
            return destination;

        _store.EnsureCreated();
        var archivePath = Path.Combine(_store.RootDirectory, $".download-{entry.Sha256}.zip");
        var staging = Path.Combine(_store.RootDirectory, $".staging-{entry.Sha256}");

        try
        {
            await DownloadAsync(source, entry, archivePath, ct).ConfigureAwait(false);
            VerifyHash(archivePath, entry);

            if (Directory.Exists(staging))
                Directory.Delete(staging, recursive: true);

            Extract(archivePath, staging);

            if (!File.Exists(Path.Combine(staging, "index.html")))
                throw new BundleVerificationException($"bundle {Short(entry.Sha256)} has no index.html at its root");

            // The rename is what makes a bundle "installed"; nothing before this
            // point is visible under the name the state file will reference.
            if (Directory.Exists(destination))
                Directory.Delete(destination, recursive: true);

            Directory.Move(staging, destination);
            return destination;
        }
        catch
        {
            TryDelete(staging);
            throw;
        }
        finally
        {
            TryDeleteFile(archivePath);
        }
    }

    /// <summary>
    /// Absolute ceiling on an archive when the manifest does not declare a size.
    /// A web bundle is megabytes; anything near this is not one.
    /// </summary>
    internal const long MaxBundleBytes = 512L * 1024 * 1024;

    private static async Task DownloadAsync(
        IBundleSource source,
        BundleEntry entry,
        string archivePath,
        CancellationToken ct)
    {
        // Bounded during the copy, not checked after: the hash and size are
        // verified once the file is on disk, but by then a hostile feed has
        // already written as much as it wanted. The limit is the manifest's own
        // declared size — which the signature covers — with a hard ceiling when
        // none is declared.
        var limit = entry.Size > 0 ? entry.Size : MaxBundleBytes;

        await using var remote = await source.OpenBundleAsync(entry.Url, ct).ConfigureAwait(false);
        await using var file = File.Create(archivePath);

        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await remote.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            total += read;
            if (total > limit)
            {
                throw new BundleVerificationException(
                    $"bundle {entry.Version} exceeds its declared size ({limit} bytes); stopping the download");
            }

            await file.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
        }
    }

    private static void VerifyHash(string archivePath, BundleEntry entry)
    {
        var actual = Sha256OfFile(archivePath);
        if (!string.Equals(actual, entry.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new BundleVerificationException(
                $"bundle {entry.Version} failed verification: expected sha256 {entry.Sha256}, got {actual}");
        }

        // A size mismatch alone is not fatal once the hash matches — the hash is
        // the stronger statement — but it means the publisher's metadata is wrong
        // and is worth surfacing rather than swallowing.
        if (entry.Size > 0)
        {
            var actualSize = new FileInfo(archivePath).Length;
            if (actualSize != entry.Size)
            {
                throw new BundleVerificationException(
                    $"bundle {entry.Version} is {actualSize} bytes, manifest says {entry.Size}");
            }
        }
    }

    public static string Sha256OfFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }

    private static void Extract(string archivePath, string destination)
    {
        Directory.CreateDirectory(destination);
        var root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;

        using var archive = ZipFile.OpenRead(archivePath);
        foreach (var zipEntry in archive.Entries)
        {
            // Directory entries have an empty name and only carry the path.
            var isDirectory = zipEntry.Name.Length == 0;
            var target = Path.GetFullPath(Path.Combine(destination, zipEntry.FullName));

            if (!target.StartsWith(root, StringComparison.Ordinal))
            {
                // Zip-slip: an entry named ../../something. Refused outright — a
                // sanitizing fallback would install an archive whose author was
                // clearly trying to write outside the bundle.
                throw new BundleVerificationException(
                    $"archive entry '{zipEntry.FullName}' would extract outside the bundle directory");
            }

            if (isDirectory)
            {
                Directory.CreateDirectory(target);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            zipEntry.ExtractToFile(target, overwrite: true);
        }
    }

    private static void TryDelete(string directory)
    {
        try
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
            // Leaving a .staging- directory behind is untidy, not harmful: it is
            // never referenced by state.json and the next prune removes it.
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch (IOException)
        {
        }
    }

    private static string Short(string sha256) => sha256.Length <= 8 ? sha256 : sha256[..8];
}

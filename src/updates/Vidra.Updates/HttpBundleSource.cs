namespace Vidra.Updates;

/// <summary>
/// Reads a feed over HTTP(S) — any static host will do, since the index is ours.
/// </summary>
public sealed class HttpBundleSource : IBundleSource, IDisposable
{
    private readonly HttpClient _http;
    private readonly bool _ownsClient;
    private readonly Uri _manifestUri;

    /// <param name="manifestUrl">Absolute URL of <c>bundles.json</c>.</param>
    /// <param name="headers">Optional headers, e.g. an authorization token for a private feed.</param>
    /// <param name="http">Client to reuse; one is created (and disposed) if omitted.</param>
    public HttpBundleSource(
        string manifestUrl,
        IReadOnlyDictionary<string, string>? headers = null,
        HttpClient? http = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(manifestUrl);

        if (!Uri.TryCreate(manifestUrl, UriKind.Absolute, out var uri))
            throw new ArgumentException($"'{manifestUrl}' is not an absolute URL", nameof(manifestUrl));

        _manifestUri = uri;
        _ownsClient = http is null;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(30) };

        if (headers is not null)
        {
            foreach (var (name, value) in headers)
                _http.DefaultRequestHeaders.TryAddWithoutValidation(name, value);
        }
    }

    public string Description => _manifestUri.ToString();

    public async Task<string> GetManifestAsync(CancellationToken ct = default)
    {
        using var response = await _http.GetAsync(_manifestUri, ct).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
    }

    public async Task<Stream> OpenBundleAsync(string url, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(url);

        // Relative URLs resolve against the manifest, so a feed can be moved or
        // mirrored without rewriting every entry in it.
        var target = new Uri(_manifestUri, url);

        var response = await _http
            .GetAsync(target, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);

        try
        {
            response.EnsureSuccessStatusCode();
            var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            return new ResponseStream(stream, response);
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        if (_ownsClient)
            _http.Dispose();
    }

    /// <summary>Keeps the response alive for as long as the caller reads the body.</summary>
    private sealed class ResponseStream(Stream inner, HttpResponseMessage response) : Stream
    {
        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);

        public override int Read(Span<byte> buffer) => inner.Read(buffer);

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
            => inner.ReadAsync(buffer, ct);

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct)
            => inner.ReadAsync(buffer, offset, count, ct);

        public override void Flush() => inner.Flush();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
                response.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}

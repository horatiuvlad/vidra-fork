#if WINDOWS
using Microsoft.Web.WebView2.Core;

namespace Vidra.Hosting;

public sealed partial class WebViewBridge
{
    partial void AttachPlatformChannel(WebView webView)
    {
        async void Wire()
        {
            if (webView.Handler?.PlatformView is not Microsoft.UI.Xaml.Controls.WebView2 webView2)
                return;

            try
            {
                await webView2.EnsureCoreWebView2Async();
                webView2.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
                webView2.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Vidra] Failed to wire WebView2 channel: {ex.Message}");
            }
        }

        if (webView.Handler is not null)
            Wire();
        else
            webView.HandlerChanged += (_, _) => Wire();
    }

    /// <summary>
    /// Receives <c>window.chrome.webview.postMessage(...)</c> calls from JS.
    /// </summary>
    private void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            HandleNativeInbound(args.TryGetWebMessageAsString());
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[Vidra] Failed to read web message: {ex.Message}");
        }
    }

    /// <summary>
    /// The one host name Vidra serves web assets under, whichever directory they
    /// come from. WebView2 resolves it internally, ahead of DNS, so it never
    /// reaches the network; <c>.invalid</c> is reserved by RFC 2606, so it can
    /// never collide with a real domain the app might want to fetch.
    /// </summary>
    /// <remarks>
    /// Origin stability is the reason this is used for the embedded copy too.
    /// MAUI's own default serves the embedded assets from
    /// <c>https://appdir/wwwroot/index.html</c>; pointing an updated bundle at a
    /// different host would move the page to a different *origin*, silently
    /// resetting localStorage, IndexedDB, caches and cookies every time an update
    /// is promoted or rolled back. One fixed host keeps the app's stored data
    /// across bundle swaps.
    /// </remarks>
    private const string VirtualHostName = "vidra.invalid";

    partial void LoadProductionAssetsCore(WebView webView)
    {
        var externalRoot = WebAssetRoot.Resolve();
        var embeddedRoot = System.IO.Path.Combine(AppContext.BaseDirectory, "wwwroot");
        var root = externalRoot ?? embeddedRoot;

        if (WebAssetRoot.PreferFileUrlOnWindows() && externalRoot is not null)
        {
            // Kept as an escape hatch, not the default: a file:// URL is an
            // opaque origin, so the page loses everything the virtual host gives
            // it (storage, and a stable identity across updates).
            WebAssetRoot.Announce(externalRoot, external: true, "file:// url");
            webView.Source = new UrlWebViewSource
            {
                Url = new Uri(System.IO.Path.Combine(externalRoot, "index.html")).AbsoluteUri,
            };
            return;
        }

        // The mapping lives on the CoreWebView2, so it has to exist before the
        // first navigation to the virtual host — hence the EnsureCoreWebView2Async
        // hop. Navigation itself still goes through the MAUI Source property so
        // the handler keeps raising Navigating/Navigated, which is what drives
        // the bridge handshake.
        async void Serve()
        {
            if (webView.Handler?.PlatformView is not Microsoft.UI.Xaml.Controls.WebView2 webView2)
                return;

            try
            {
                if (!File.Exists(System.IO.Path.Combine(root, "index.html")))
                    throw new FileNotFoundException($"no index.html under '{root}'");

                await webView2.EnsureCoreWebView2Async();
                webView2.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    VirtualHostName,
                    root,
                    CoreWebView2HostResourceAccessKind.Allow);

                WebAssetRoot.Announce(root, externalRoot is not null, $"https://{VirtualHostName}");
                webView.Source = new UrlWebViewSource { Url = $"https://{VirtualHostName}/index.html" };
            }
            catch (Exception ex)
            {
                // MAUI's own relative source is the last resort: it resolves the
                // embedded copy through the handler's `appdir` mapping, which
                // needs nothing from us.
                System.Diagnostics.Debug.WriteLine($"[Vidra] Failed to map '{root}': {ex.Message}");
                Console.WriteLine($"[vidra] failed to serve '{root}' ({ex.Message}); using the MAUI relative source");
                webView.Source = new UrlWebViewSource { Url = "wwwroot/index.html" };
            }
        }

        if (webView.Handler is not null)
            Serve();
        else
            webView.HandlerChanged += (_, _) => Serve();
    }
}
#endif

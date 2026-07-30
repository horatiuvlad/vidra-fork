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
    /// MAUI's own virtual host for app content. Reused deliberately.
    /// </summary>
    /// <remarks>
    /// The MAUI WebView2 handler maps <c>appdir</c> to the application directory
    /// and serves the embedded copy from <c>https://appdir/wwwroot/index.html</c>.
    /// An updated bundle is mapped to the same host and loaded from
    /// <c>https://appdir/index.html</c> — a different path, but the *same origin*,
    /// which is what localStorage, IndexedDB, caches and cookies are keyed on.
    ///
    /// The alternative was a host of our own, which gives the same stability
    /// across bundle swaps but moves every existing app off MAUI's origin once,
    /// including apps that never enable updates. Reusing MAUI's host means an app
    /// that never updates sees no change at all, and one that does keeps its data
    /// across every promotion and rollback.
    /// </remarks>
    private const string VirtualHostName = "appdir";

    partial void LoadProductionAssetsCore(WebView webView)
    {
        var externalRoot = WebAssetRoot.Resolve();

        if (externalRoot is null)
        {
            // Nothing to redirect: let the handler serve the embedded copy the
            // way it always has, including its own appdir mapping.
            WebAssetRoot.Announce("wwwroot/index.html", external: false, "MAUI relative source");
            webView.Source = new UrlWebViewSource { Url = "wwwroot/index.html" };
            return;
        }

        var root = externalRoot;

        if (WebAssetRoot.PreferFileUrlOnWindows())
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

                // Re-points MAUI's own mapping at the bundle. Same host, so the
                // page keeps the origin — and everything stored under it — that
                // the embedded copy had.
                webView2.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    VirtualHostName,
                    root,
                    CoreWebView2HostResourceAccessKind.Allow);

                WebAssetRoot.Announce(root, external: true, $"https://{VirtualHostName}");
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

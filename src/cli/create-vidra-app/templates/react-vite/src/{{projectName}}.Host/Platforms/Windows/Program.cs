// The app's real entry point on Windows.
//
// MAUI generates one of these for you. This app takes it over, via
// `<DefineConstants>` in the csproj setting DISABLE_XAML_GENERATED_MAIN, for
// one reason: a native updater has to run *first*, before any UI framework
// starts.
//
// On install, update and uninstall, Velopack re-launches the app with a
// `--veloapp-*` argument and expects it to do that work and exit without ever
// showing a window. `VelopackApp.Build()...Run()` is what handles those launches,
// and `vpk pack` statically inspects the assembly and warns when it finds the
// call anywhere other than the entry point.
//
// It is live from the first scaffold and does nothing at all until this app is
// installed from a Velopack release — which it is not, until `package.json`
// carries a `vidra.updates.native.feedUrl` and `vidra build` packs one. That
// URL is the whole opt-in: `npx vidra updates init --feed <url> --native`.

using Velopack;
using Vidra.Hosting;

namespace {{projectName}}.WinUI;

public static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        VelopackApp.Build().UseVidraLocator().Run();

        WinRT.ComWrappersSupport.InitializeComWrappers();

        Microsoft.UI.Xaml.Application.Start(p =>
        {
            var context = new Microsoft.UI.Dispatching.DispatcherQueueSynchronizationContext(
                Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread());
            System.Threading.SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
    }
}

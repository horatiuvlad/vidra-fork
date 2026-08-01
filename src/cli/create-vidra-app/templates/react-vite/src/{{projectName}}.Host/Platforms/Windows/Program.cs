// The app's real entry point on Windows.
//
// MAUI generates one of these for you. This app takes it over — `<DefineConstants>`
// in the csproj sets DISABLE_XAML_GENERATED_MAIN — for one reason: a native
// updater has to run *first*, before any UI framework starts.
//
// On install, update and uninstall, Velopack re-launches the app with a
// `--veloapp-*` argument and expects it to do that work and exit without ever
// showing a window. `VelopackApp.Build()...Run()` is what handles those launches,
// and `vpk pack` statically inspects the assembly and warns when it finds the
// call anywhere other than the entry point. Putting it here costs nothing and
// means an app that later enables updates needs no migration into generated code.
//
// To turn native updates on:
//   1. add the Vidra.Updates.Native package reference to this project
//   2. uncomment the two lines below, and the ones in MauiProgram.cs
//   3. add a `vidra.updates.native.feedUrl` to package.json
//   4. build with `npx vidra build --target windows --native-update`
//
// `npx vidra doctor` checks all four and names whichever is missing.

// using Velopack;
// using Vidra.Hosting;

namespace {{projectName}}.WinUI;

public static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // VelopackApp.Build().UseVidraLocator().Run();

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

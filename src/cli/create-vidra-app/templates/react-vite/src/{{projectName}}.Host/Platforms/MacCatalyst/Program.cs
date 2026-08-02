// The app's entry point on Mac Catalyst.
//
// A native updater has to run before UIKit does: on install, update and
// uninstall Velopack re-launches the app with a `--veloapp-*` argument and
// expects it to do that work and exit without ever showing a window. `vpk pack`
// also inspects the assembly statically and warns when
// `VelopackApp.Build()...Run()` is anywhere other than the entry point.
//
// `UseVidraLocator()` is the Mac Catalyst part. Velopack's client picks its
// locator from `RuntimeInformation.IsOSPlatform`, which answers false for OSX
// here, so without it, `Run()` throws before any update logic executes.
//
// To turn native updates on:
//   1. add the Vidra.Updates.Native package reference to this project
//   2. uncomment the two lines below, and the ones in MauiProgram.cs
//   3. add a `vidra.updates.native.feedUrl` to package.json
//   4. build with `npx vidra build --target macos --native-update`
//
// `npx vidra doctor` checks all four and names whichever is missing.

// using Velopack;
// using Vidra.Hosting;
using UIKit;

namespace {{projectName}};

public static class Program
{
    static void Main(string[] args)
    {
        // VelopackApp.Build().UseVidraLocator().Run();

        UIApplication.Main(args, null, typeof(AppDelegate));
    }
}

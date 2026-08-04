// The app's entry point on Mac Catalyst.
//
// A native updater has to run before UIKit does: on install, update and
// uninstall Velopack re-launches the app with a `--veloapp-*` argument and
// expects it to do that work and exit without ever showing a window. `vpk pack`
// also inspects the assembly statically and warns when
// `VelopackApp.Build()...Run()` is anywhere other than the entry point.
//
// It is live from the first scaffold and does nothing at all until this app is
// installed from a Velopack release — which it is not, until `package.json`'s
// `vidra.updates.feed` (already there, empty) names one and `vidra build` packs
// a release into it. Filling in that URL is the whole opt-in.
//
// `UseVidraLocator()` is the Mac Catalyst part. Velopack's client picks its
// locator from `RuntimeInformation.IsOSPlatform`, which answers false for OSX
// here, so without it, `Run()` throws before any update logic executes.

using Velopack;
using Vidra.Hosting;
using UIKit;

namespace {{projectName}};

public static class Program
{
    static void Main(string[] args)
    {
        VelopackApp.Build().UseVidraLocator().Run();

        UIApplication.Main(args, null, typeof(AppDelegate));
    }
}

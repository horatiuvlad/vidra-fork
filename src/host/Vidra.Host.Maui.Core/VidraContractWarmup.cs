using Microsoft.Maui.Hosting;
using Vidra.Bridge;

namespace Vidra.Hosting;

/// <summary>
/// Makes <see cref="BridgeContractRegistry"/> complete before any application
/// code runs.
/// </summary>
/// <remarks>
/// Contracts register themselves from generated <c>[ModuleInitializer]</c>s, so
/// an assembly that has not been touched yet contributes nothing — and
/// <see cref="BridgeContractRegistry.Fingerprint"/> happily hashes the partial
/// manifest, returning a wrong answer that looks exactly like a right one. The
/// built-in modules are only constructed when <see cref="BridgeDispatcher"/> is
/// first resolved, which used to be inside <c>VidraPage</c>'s constructor; a
/// fingerprint read before the first page (an update check, for instance) was
/// therefore a hash nothing would ever hand back over the wire.
///
/// Resolving the dispatcher here — MAUI runs every
/// <see cref="IMauiInitializeService"/> while building the app, before the
/// <c>Application</c> is constructed — pins the fingerprint for the whole
/// process lifetime. The modules are cheap to build and subscribe to nothing
/// until a callback channel is attached.
/// </remarks>
internal sealed class VidraContractWarmup : IMauiInitializeService
{
    public void Initialize(IServiceProvider services)
    {
        _ = services.GetService<BridgeDispatcher>();
    }
}

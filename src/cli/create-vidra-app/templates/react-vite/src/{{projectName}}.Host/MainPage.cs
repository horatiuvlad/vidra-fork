using System.Diagnostics;
using Vidra.Hosting;

namespace {{projectName}};

public class MainPage : VidraPage
{
    public MainPage()
    {
        StartCounterTimer();
    }

    private async void StartCounterTimer()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        while (await timer.WaitForNextTickAsync())
        {
            await OnTickAsync();
        }
    }

    private async Task OnTickAsync()
    {
        try
        {
            var count = await Bridge.Js().Counter.IncrementAsync();
            Trace.TraceInformation($"[MainPage] Counter is now {count}");
        }
        catch (Exception ex)
        {
            // Trace, not Debug: Debug.WriteLine compiles out of a Release build,
            // which is exactly the build where someone is looking at a counter
            // stuck at zero and has nothing to report. The whole exception, not
            // ex.Message, because the bridge's answer to "why" is the error code
            // on it (JS_HANDLER_NOT_FOUND, JS_HANDLER_ERROR, JS_RESPONSE_INVALID).
            Trace.TraceError($"[MainPage] Counter increment failed: {ex}");
        }
    }
}

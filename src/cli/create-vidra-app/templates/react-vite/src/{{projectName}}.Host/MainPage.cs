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
            Console.WriteLine($"[MainPage] Counter is now {count}");
        }
        catch (Exception ex)
        {
            // Console, which is what Vidra.Hosting itself logs through, and the
            // only one of the three that a Release build actually emits.
            // Debug.WriteLine is compiled out of Release entirely, and Release is
            // exactly the build where someone is looking at a counter stuck at
            // zero. Trace.TraceError survives the compile but goes to
            // DefaultTraceListener, which writes nothing unless a debugger is
            // attached, and this template registers no listener.
            //
            // The whole exception, not ex.Message: the bridge's answer to "why"
            // is the error code on it, and JS_HANDLER_NOT_FOUND, JS_HANDLER_ERROR
            // and JS_RESPONSE_INVALID are three different problems.
            Console.Error.WriteLine($"[MainPage] Counter increment failed: {ex}");
        }
    }
}

// Several tests redirect $HOME to assert the exact path a locator builds, and
// one reads the process environment. That is process-global state, so running
// classes in parallel would make the suite flaky for no gain: the whole thing
// finishes in milliseconds.
[assembly: CollectionBehavior(DisableTestParallelization = true)]

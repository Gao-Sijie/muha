# Repair the job report pipeline

The dependency-free ESM project parses job definitions, schedules them with a
bounded worker count, and renders a report. Several interacting defects were
introduced across the three modules.

Work autonomously and use tools throughout the investigation:

1. Run the test suite to establish the failures.
2. Inspect each source module and the relevant tests.
3. Fix production code without weakening or deleting tests.
4. Rerun focused checks while working, then run the complete test suite.
5. Briefly report what remains if you cannot finish every repair.

Do not add dependencies and do not use the network.

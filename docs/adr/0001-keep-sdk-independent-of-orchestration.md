# Keep Muha SDK independent of orchestration

Muha SDK will expose Coding Harness execution primitives and remain independent of graph orchestration, work tracking, workspace scheduling, and long-running runner concerns. Higher-level products such as Muha Graph or a Symphony-style runner may consume the SDK, but the SDK will not depend on or design for any one of them, preserving a stable and reusable harness boundary.

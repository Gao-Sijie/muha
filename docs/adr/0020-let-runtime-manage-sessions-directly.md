# Let Runtime manage Sessions directly

Muha will not expose a public `CodingHarness` wrapper between Muha Runtime and Agent Session. Runtime directly creates, resumes, and lists Sessions, while registered Harness Adapters remain integration boundaries rather than lifecycle objects and Coding Harness continues to mean the native agent runtime rather than a Muha lifecycle object.

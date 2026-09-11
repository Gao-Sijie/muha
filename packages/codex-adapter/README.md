# @muha-sdk/codex-adapter

Official Codex integration for Muha.

```bash
npm install @muha-sdk/core @muha-sdk/codex-adapter
```

The native `codex` command must already be installed, authenticated, and available on the same `PATH` used to launch Node.js. Muha starts Codex through its stdio App Server and does not install, upgrade, download, or authenticate Codex.

```ts
import { createMuhaRuntime } from "@muha-sdk/core";
import { codexAdapter } from "@muha-sdk/codex-adapter";

const runtime = await createMuhaRuntime({ harnesses: [codexAdapter()] });
```

Codex keeps authority over native sessions, models, tools, and behavior. Use `runtime.getHarnessCapabilities("codex")` for the exact portable capability contract exposed by this release.

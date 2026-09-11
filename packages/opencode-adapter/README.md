# @muha-sdk/opencode-adapter

Official OpenCode integration for Muha.

```bash
npm install @muha-sdk/core @muha-sdk/opencode-adapter
```

The native `opencode` command must already be installed, authenticated, and available on the same `PATH` used to launch Node.js. Muha owns a local authenticated loopback `opencode serve` process for the Runtime but does not install, upgrade, download, or authenticate OpenCode.

```ts
import { createMuhaRuntime } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter()] });
```

OpenCode keeps authority over native sessions, providers/models, tools, and behavior. Use `runtime.getHarnessCapabilities("opencode")` for the exact portable capability contract exposed by this release.

# @muha-sdk/kimi-adapter

Official Kimi Code integration for Muha.

```bash
npm install @muha-sdk/core @muha-sdk/kimi-adapter
```

The native `kimi` command must already be installed, authenticated, and available on the same `PATH` used to launch Node.js. Muha drives Kimi through its local `kimi web` server and does not install, upgrade, download, or authenticate Kimi Code.

```ts
import { createMuhaRuntime } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";

const runtime = await createMuhaRuntime({ harnesses: [kimiAdapter()] });
```

Kimi Code keeps authority over native sessions, models, tools, and behavior. Use `runtime.getHarnessCapabilities("kimi")` for the exact portable capability contract exposed by this release.

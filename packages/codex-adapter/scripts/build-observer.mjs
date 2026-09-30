import { chmod } from "node:fs/promises";
await chmod(new URL("../dist/codex-observer-worker.js", import.meta.url), 0o755);

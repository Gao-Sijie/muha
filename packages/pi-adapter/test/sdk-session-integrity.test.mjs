import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadSdk } from "../dist/sdk-loader.mjs";
const { SessionManager } = await loadSdk();

// Native tolerance explicitly accepted by the user on 2026-09-08. This does
// not promise that SDK list/open can detect all storage corruption.
test("SDK list and open silently accept a conversation containing a malformed physical record", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-pi-integrity-"));
  const cwd = join(root, "workspace"), sessionDir = join(root, "sessions");
  await mkdir(cwd);
  try {
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "before corruption" }], timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "persist" }], timestamp: 2,
      api: "openai-completions", provider: "controlled", model: "controlled", stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const path = manager.getSessionFile();
    const before = SessionManager.open(path, sessionDir).buildSessionContext().messages;
    await appendFile(path, '{"type":"message",THIS_IS_CORRUPT}\n');
    const progress = [];
    const listed = await SessionManager.list(cwd, sessionDir, (loaded, total) => progress.push({ loaded, total }));
    assert.equal(listed.length, 1);
    assert.deepEqual(progress, [{ loaded: 1, total: 1 }]);
    const restored = SessionManager.open(path, sessionDir);
    assert.deepEqual(restored.buildSessionContext().messages, before);
    assert.equal(restored.getSessionId(), manager.getSessionId());
  } finally { await rm(root, { recursive: true, force: true }); }
});

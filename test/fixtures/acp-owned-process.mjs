// Protocol-neutral ownership fault endpoint. All PIDs are test-owned; the
// detached grandchild deliberately escapes process-group-only cleanup.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
if (process.argv[2] === "grandchild") {
  process.send({ pid: process.pid });
} else if (process.argv[2] === "child") {
  const child = spawn(process.execPath, [import.meta.filename, "grandchild"], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("message", ({ pid }) => process.send({ pids: [process.pid, pid] }));
} else {
  const child = spawn(process.execPath, [import.meta.filename, "child"], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await new Promise(resolve => child.once("message", async ({ pids }) => {
    await writeFile(process.env.MUHA_TEST_OWNED_PIDS, JSON.stringify([process.pid, ...pids]));
    resolve();
  }));
  createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "initialize") process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion },
    })}\n`);
  });
}

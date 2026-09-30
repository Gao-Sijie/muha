#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { nativeFrames, writeNative } from "./codex-observer-wire.js";

/** No commands originate here. Both directions retain the bridge/native
 * payload, while relevant inbound semantics wait for Muha's commit ACK. */
async function main(): Promise<void> {
  const executable = process.env.MUHA_INTERNAL_CODEX_BINARY;
  const socketPath = process.env.MUHA_INTERNAL_CODEX_SOCKET;
  const token = process.env.MUHA_INTERNAL_CODEX_TOKEN;
  if (!executable || !socketPath || !token) throw new Error("Missing Codex observer ownership");
  const socket = createConnection(socketPath);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await once(socket, "connect");
    const acknowledgements = nativeFrames(socket);
    await writeNative(socket, `${JSON.stringify({ type: "hello", token })}\n`);
    const hello = await acknowledgements.next();
    if (hello.done || hello.value.message.type !== "ready") throw new Error("Codex observer ownership rejected");
    const environment: NodeJS.ProcessEnv = { ...process.env, CODEX_PATH: executable };
    delete environment.MUHA_INTERNAL_CODEX_BINARY;
    delete environment.MUHA_INTERNAL_CODEX_SOCKET;
    delete environment.MUHA_INTERNAL_CODEX_TOKEN;
    child = spawn(executable, process.argv.slice(2), { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.pipe(process.stderr);
    const native = child;
    const exit = new Promise<number | null>((resolve, reject) => {
      native.once("error", reject);
      native.once("close", code => { process.stdin.destroy(); resolve(code); });
    });
    const requests = new Map<string | number, string>();
    let sequence = 0;
    let observations = Promise.resolve();
    const observe = (envelope: Record<string, unknown>) => {
      const next = observations.then(async () => {
        await writeNative(socket, `${JSON.stringify({ ...envelope, sequence: ++sequence })}\n`);
        const ack = await acknowledgements.next();
        if (ack.done || ack.value.message.sequence !== sequence) throw new Error("Codex observer acknowledgement lost");
      });
      observations = next;
      return next;
    };
    const input = (async () => {
      for await (const { raw, message } of nativeFrames(process.stdin)) {
        // Validate a minimal execution descriptor in memory before forwarding.
        // No prompt, command body, authentication or outbound event is stored.
        if (message.method === "turn/start") {
          const params = message.params as Record<string, unknown> | undefined;
          if (!params || typeof params !== "object") throw new Error("Invalid Codex Turn request");
          await observe({ type: "execution", descriptor: {
            threadId: params.threadId, model: params.model, effort: params.effort,
            approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer,
            sandboxPolicy: params.sandboxPolicy,
          } });
        }
        // Only method identity is retained for relevant inbound responses.
        if ((typeof message.id === "string" || typeof message.id === "number") && typeof message.method === "string" &&
            /^(thread\/|turn\/|model\/list$)/.test(message.method)) {
          if (requests.size >= 4096) throw new Error("Codex observer request limit exceeded");
          requests.set(message.id, message.method);
        }
        await writeNative(native.stdin, raw);
      }
      native.stdin.end();
    })();
    const output = (async () => {
      for await (const { raw, message } of nativeFrames(native.stdout)) {
        const method = typeof message.method === "string" ? message.method : undefined;
        const requestMethod = method === undefined && (typeof message.id === "string" || typeof message.id === "number") ? requests.get(message.id) : undefined;
        if (method === undefined && (typeof message.id === "string" || typeof message.id === "number")) requests.delete(message.id);
        const semantic = method !== undefined && /^(thread\/|turn\/|item\/|serverRequest\/|error$)/.test(method);
        if (semantic || requestMethod !== undefined) {
          await observe({ type: "inbound", message, ...(requestMethod === undefined ? {} : { requestMethod }) });
        }
        await writeNative(process.stdout, raw);
      }
    })();
    const [, , code] = await Promise.all([input, output, exit]);
    if (code !== 0) throw new Error("Codex native process failed");
  } finally {
    socket.destroy();
    process.stdin.destroy();
    if (child && child.exitCode === null && child.signalCode === null) {
      const native = child;
      native.stdin.destroy();
      native.kill("SIGTERM");
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { native.kill("SIGKILL"); resolve(); }, 500);
        native.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    // No native payload, process log or credential enters the startup error.
    process.stderr.write("Muha Codex observer failed\n");
    process.exitCode = 1;
  });
}

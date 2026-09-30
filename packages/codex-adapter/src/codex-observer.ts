import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LiveHarnessAdapterContext } from "@muha-sdk/core/internal";
import { nativeFrames, writeNative, type NativeObject } from "./codex-observer-wire.js";

export class CodexNativeObserver {
  readonly #token = randomBytes(32).toString("hex");
  readonly #sockets = new Set<Socket>();
  #root: string | undefined;
  #server: Server | undefined;
  #closing = false;
  #authenticated = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    readonly context: LiveHarnessAdapterContext,
    readonly capture: (message: NativeObject, requestMethod: string | undefined) => () => Promise<void>,
    readonly verifyExecution: (descriptor: NativeObject) => void = () => {},
  ) {}

  async open(environment: Readonly<Record<string, string | undefined>>): Promise<Readonly<Record<string, string | undefined>>> {
    const executable = await findCodex((Object.hasOwn(environment, "PATH") ? environment.PATH : process.env.PATH) ?? "");
    const root = await mkdtemp(join(tmpdir(), "muha-codex-observer-"));
    this.#root = root;
    if (this.#closing) {
      await rm(root, { recursive: true, force: true });
      throw new Error("Codex observer is closed");
    }
    const socketPath = join(root, "native.sock");
    const server = createServer(socket => {
      // No untrusted local connection may consume unbounded frame buffers or
      // replace the single authenticated observer for this owned process.
      if (this.#closing || this.#authenticated || this.#sockets.size >= 8) { socket.destroy(); return; }
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
      void this.#consume(socket).catch(() => {
        socket.destroy();
        if (!this.#closing) this.context.reportFatalError({ code: "HARNESS_ERROR", harness: "codex", command: "codex-acp", operation: "initialize", message: "Codex native observer lost its committed semantic stream" });
      });
    });
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
      await chmod(socketPath, 0o600);
      return { ...environment, CODEX_PATH: fileURLToPath(new URL("./codex-observer-worker.js", import.meta.url)),
        MUHA_INTERNAL_CODEX_BINARY: executable, MUHA_INTERNAL_CODEX_SOCKET: socketPath, MUHA_INTERNAL_CODEX_TOKEN: this.#token };
    } catch (error) { await this.close(); throw error; }
  }

  async #consume(socket: Socket): Promise<void> {
    const frames = nativeFrames(socket);
    try {
      const hello = await frames.next();
      const supplied = hello.done ? undefined : hello.value.message.token;
      const candidate = typeof supplied === "string" ? Buffer.from(supplied) : undefined;
      const expected = Buffer.from(this.#token);
      if (this.#authenticated || hello.done || hello.value.message.type !== "hello" || candidate?.length !== expected.length ||
          !timingSafeEqual(candidate, expected)) { socket.destroy(); return; }
    } catch {
      // Parsing/framing/authentication failures before ownership is proved
      // belong to the untrusted connection, not the native semantic stream.
      socket.destroy(); return;
    }
    this.#authenticated = true;
    for (const other of this.#sockets) if (other !== socket) other.destroy();
    await writeNative(socket, `${JSON.stringify({ type: "ready" })}\n`);
    let sequence = 0;
    for await (const { message: envelope } of frames) {
      if (envelope.sequence !== ++sequence) throw new Error("Invalid Codex observation sequence");
      if (envelope.type === "execution") {
        const descriptor = envelope.descriptor;
        if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) throw new Error("Invalid Codex execution descriptor");
        this.verifyExecution(descriptor as NativeObject);
        await writeNative(socket, `${JSON.stringify({ sequence })}\n`);
        continue;
      }
      const message = envelope.message;
      if (envelope.type !== "inbound" || typeof message !== "object" || message === null || Array.isArray(message) ||
          (envelope.requestMethod !== undefined && typeof envelope.requestMethod !== "string")) throw new Error("Invalid Codex observation");
      const commit = this.capture(message as NativeObject, envelope.requestMethod as string | undefined);
      await this.context.recordNativeEvent("codex", message);
      await commit();
      await writeNative(socket, `${JSON.stringify({ sequence })}\n`);
    }
    if (!this.#closing) throw new Error("Codex observation ended");
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      for (const socket of this.#sockets) socket.destroy();
      if (this.#server?.listening) await new Promise<void>(resolve => this.#server!.close(() => resolve()));
      if (this.#root) await rm(this.#root, { recursive: true, force: true });
    })();
    return this.#closePromise;
  }
}

async function findCodex(path: string): Promise<string> {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "codex");
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* next explicit PATH entry */ }
  }
  throw { code: "HARNESS_ERROR", harness: "codex", command: "codex", operation: "initialize", message: "Existing Codex executable is required; Muha does not install a Harness" };
}

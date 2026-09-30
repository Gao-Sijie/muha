// ACP v1 JSON-RPC connection: framing, request correlation, notification
// dispatch, initialize handshake, owned process lifecycle and duplicate-close
// safety. Harness-neutral: the driver owns semantic translation and Native
// Event Record attribution.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { AcpOwnedProcess } from "./owned-process.js";
import type { AdapterProtocolErrorData, HarnessErrorData } from "../errors.js";
import type { HarnessKind } from "../harness-catalog.js";
import type { AcpRouteOptions } from "./types.js";

const defaultStartupTimeoutMs = 60_000;
const maxFrameBytes = 8 * 1024 * 1024;
const coreManifest = createRequire(import.meta.url)("../../package.json") as { version?: unknown };
if (typeof coreManifest.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(coreManifest.version)) {
  throw new Error("Core package manifest has no valid version");
}
const coreVersion = coreManifest.version;

type JsonObject = Record<string, unknown>;
export type RpcId = string | number;

export type AcpFailure = HarnessErrorData | AdapterProtocolErrorData;

interface PendingRequest {
  readonly method: string;
  readonly params: JsonObject;
  readonly operation: HarnessErrorData["operation"];
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: AcpFailure) => void;
}

type ErrorAttribution = {
  readonly harness: HarnessKind;
  readonly command: string;
};

function protocolError(attribution: ErrorAttribution, message: string): AdapterProtocolErrorData {
  return { code: "ADAPTER_PROTOCOL_ERROR", harness: attribution.harness, message };
}

function harnessError(attribution: ErrorAttribution, operation: HarnessErrorData["operation"], message: string, retryable = false): HarnessErrorData {
  return { code: "HARNESS_ERROR", harness: attribution.harness, command: attribution.command, operation, message, retryable };
}

export interface AcpConnectionEvents {
  /** Capture ownership/start persistence at receipt; return ordered mapping. */
  captureInbound?(message: JsonObject, request: { readonly method: string; readonly params: JsonObject } | undefined): () => Promise<void>;
  /** Framing-valid agent → host notifications (id + method + params). */
  onNotification(notification: JsonObject): void;
  /** Connection/process lost before explicit close.*/
  onLoss(error: AcpFailure): void;
}

export class AcpConnection {
  readonly #options: AcpRouteOptions;
  readonly #attribution: ErrorAttribution;
  readonly #events: AcpConnectionEvents;
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #startupTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  #child: ChildProcessWithoutNullStreams | undefined;
  #owned: AcpOwnedProcess | undefined;
  #nextRequestId = 1;
  #initialized = false;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #lost = false;
  #incoming: Promise<void> = Promise.resolve();
  #receiveFailed = false;

  constructor(options: AcpRouteOptions, events: AcpConnectionEvents, attribution: ErrorAttribution) {
    this.#options = options;
    this.#attribution = attribution;
    this.#events = events;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? defaultStartupTimeoutMs;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 60_000;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  /** Spawn the agent service and complete the initialize handshake. */
  async connect(protocolVersion: number, clientCapabilities: JsonObject = {}): Promise<JsonObject> {
    if (this.#child !== undefined) throw new Error("ACP connection already started");
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of Object.entries(this.#options.env ?? {})) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
    const lose = (message: string): void => {
      const error = harnessError(this.#attribution, "initialize", message);
      if (!this.#closing && !this.#lost) {
        this.#lost = true;
        this.#events.onLoss(error);
      }
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
    try {
      this.#owned = new AcpOwnedProcess(this.#options.command, this.#options.args ?? [], environment,
        this.#shutdownTimeoutMs, (message, kind) => {
          // A dead ownership helper cannot wait behind a semantic mapping
          // that needs a native completion which may never arrive. Fatal
          // closure releases that mapping's supplement and interaction waits.
          if (kind === "ownership") { lose(message); return; }
          // A normally reaped native exit still follows its complete inbound
          // semantic prefix, preserving final messages and protocol failures.
          void this.#incoming.then(() => lose(message), () => lose(message));
        });
    } catch {
      throw harnessError(this.#attribution, "initialize", "ACP agent service spawn failed");
    }
    const child = this.#owned.child;
    this.#child = child;
    const fail = (error: AcpFailure): void => {
      if (!this.#closing && !this.#lost) {
        this.#lost = true;
        this.#events.onLoss(error);
      }
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      void this.close().catch(() => {});
    };
    const failAfterPrefix = (error: AcpFailure): void => {
      if (this.#receiveFailed) return;
      this.#receiveFailed = true;
      this.#incoming = this.#incoming.then(() => fail(error), () => fail(error));
    };
    const receive = (line: string): void => {
      if (this.#closing || this.#lost || !line.trim()) return;
      try {
        const message = parseFrame(line, this.#attribution);
        const pending = typeof message.method === "string" ? undefined : this.#pending.get(message.id as RpcId);
        // Do not postpone this callback until the commit queue runs: the
        // current Session/Turn could have changed by that point.
        const commit = this.#events.captureInbound?.(message, pending);
        this.#incoming = this.#incoming.then(async () => {
          if (this.#closing || this.#lost) return;
          await commit?.();
          if (!this.#closing && !this.#lost) this.#handleMessage(message);
        }).catch(error => fail(isFailure(error) ? error : harnessError(this.#attribution, "initialize", "ACP inbound processing failed")));
      } catch (error) {
        failAfterPrefix(isFailure(error) ? error : protocolError(this.#attribution, "Invalid ACP frame"));
      }
    };
    let parts: Buffer[] = [];
    let length = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#closing || this.#lost || this.#receiveFailed) return;
      let offset = 0;
      while (offset < chunk.length && !this.#receiveFailed) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        length += part.length;
        if (length > maxFrameBytes) {
          parts = []; length = 0;
          failAfterPrefix(protocolError(this.#attribution, "ACP frame exceeds the 8 MiB transport limit"));
          return;
        }
        parts.push(part);
        if (newline < 0) return;
        try { receive(decoder.decode(Buffer.concat(parts, length))); }
        catch { failAfterPrefix(protocolError(this.#attribution, "ACP frame is not valid UTF-8")); }
        parts = []; length = 0;
        offset = end + 1;
      }
    });
    child.stdout.on("end", () => {
      if (this.#closing || this.#lost || this.#receiveFailed) return;
      failAfterPrefix(length > 0 ? protocolError(this.#attribution, "Truncated ACP frame")
        : harnessError(this.#attribution, "initialize", "ACP output channel closed"));
    });
    child.stdout.on("error", () => failAfterPrefix(harnessError(this.#attribution, "initialize", "ACP output channel failed")));

    const result = await this.#request("initialize", {
      protocolVersion,
      clientCapabilities,
      clientInfo: { name: "muha-sdk", version: coreVersion },
    }, "initialize", this.#startupTimeoutMs);
    if (!isRecord(result)) throw protocolError(this.#attribution, "ACP initialize result must be an object");
    this.#initialized = true;
    return result;
  }

  request(method: string, params: JsonObject, operation: HarnessErrorData["operation"]): Promise<unknown> {
    return this.#request(method, params, operation);
  }

  /** A notification has no native acknowledgement; resolve after transport write. */
  notify(method: string, params: JsonObject, operation: HarnessErrorData["operation"]): Promise<void> {
    const child = this.#child;
    if (this.#closing || this.#lost || !child?.stdin.writable) {
      return Promise.reject(protocolError(this.#attribution, "ACP connection is closed"));
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, error => {
        if (error) reject(harnessError(this.#attribution, operation, "ACP notification write failed"));
        else resolve();
      });
    });
  }

  /** A server request response has no second RPC ACK: transport completion is
   * the acknowledgement. Closed/failed writes must never look successful. */
  respondToNotification(id: RpcId, result: JsonObject | undefined, error?: JsonObject): Promise<void> {
    const child = this.#child;
    const payload: JsonObject = { jsonrpc: "2.0", id };
    if (error !== undefined) payload.error = error;
    else payload.result = result;
    const written = this.#closing || this.#lost || !child?.stdin.writable
      ? Promise.reject<void>(protocolError(this.#attribution, "ACP connection is closed"))
      : new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
          if (error) reject(harnessError(this.#attribution, "initialize", "ACP response write failed"));
          else resolve();
        });
      });
    // Unknown/unsupported host requests have no public caller awaiting them.
    // Handle those failures too while preserving rejection for interactions.
    void written.catch(error => {
      if (!this.#closing && !this.#lost) {
        this.#lost = true;
        this.#events.onLoss(error);
        void this.close().catch(() => {});
      }
    });
    return written;
  }

  #request(method: string, params: JsonObject, operation: HarnessErrorData["operation"], timeoutMs?: number): Promise<unknown> {
    const child = this.#child;
    if (!child?.stdin.writable) {
      return Promise.reject(protocolError(this.#attribution, "ACP connection is closed"));
    }
    const id = this.#nextRequestId++;
    // Only connection readiness has a transport deadline. Core owns the fixed
    // one-hour control watchdog and fatal close; a prompt's terminal response
    // and human-paced interactions must never inherit the startup timeout.
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.#pending.delete(id);
        reject(harnessError(this.#attribution, operation, `ACP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        params,
        operation,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (value) => { clearTimeout(timer); reject(value); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  #handleMessage(message: JsonObject): void {
    const id = message.id;
    if (id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(id as RpcId);
      if (pending === undefined) return; // late response after timeout
      this.#pending.delete(id as RpcId);
      if (message.error !== undefined) {
        if (isRecord(message.error)) {
          pending.reject(mapRpcError(this.#attribution, message.error, pending.operation));
        } else {
          pending.reject(harnessError(this.#attribution, pending.operation, "ACP returned a malformed error response"));
        }
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string" && message.method.length > 0) {
      this.#events.onNotification(message);
      return;
    }
    throw protocolError(this.#attribution, "Unrecognized ACP message");
  }

  async close(deadline = Date.now() + this.#shutdownTimeoutMs): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      for (const pending of this.#pending.values()) {
        pending.reject(protocolError(this.#attribution, "ACP connection closed"));
      }
      this.#pending.clear();
      try { await this.#owned?.close(deadline); }
      catch { throw harnessError(this.#attribution, "closeHarness", "ACP owned-process cleanup failed"); }
      this.#child = undefined;
    })();
    return this.#closePromise;
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailure(value: unknown): value is AcpFailure {
  return isRecord(value) && (value.code === "HARNESS_ERROR" || value.code === "ADAPTER_PROTOCOL_ERROR");
}

function parseFrame(line: string, attribution: ErrorAttribution): JsonObject {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw protocolError(attribution, "Malformed ACP frame"); }
  if (!isRecord(value) || value.jsonrpc !== "2.0") throw protocolError(attribution, "Invalid ACP JSON-RPC envelope");
  const hasId = Object.hasOwn(value, "id");
  const validId = typeof value.id === "string" || (typeof value.id === "number" && Number.isFinite(value.id));
  if (hasId && !validId) throw protocolError(attribution, "Invalid ACP request ID");
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (typeof value.method === "string" && value.method.length > 0 && !hasResult && !hasError) return value;
  if (hasId && !Object.hasOwn(value, "method") && hasResult !== hasError) return value;
  throw protocolError(attribution, "Ambiguous ACP message kind");
}

function mapRpcError(attribution: ErrorAttribution, error: JsonObject, operation: HarnessErrorData["operation"]): AcpFailure {
  const code = typeof error.code === "number" ? error.code : undefined;
  const message = typeof error.message === "string" ? error.message : "ACP request failed";
  if (code === -32601) return protocolError(attribution, `Unknown ACP method: ${message}`);
  // JSON-RPC defines code/message/data, not MABC nativeCode/retryable fields.
  // A server rejection is not permission to replay a possibly executed prompt.
  return { code: "HARNESS_ERROR", harness: attribution.harness, command: attribution.command, operation, message, retryable: false,
    ...(code === undefined ? {} : { nativeCode: String(code) }) };
}

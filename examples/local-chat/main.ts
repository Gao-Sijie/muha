/**
 * Local, single-user chat. Node >=22.20; no frontend build or extra dependency.
 *   node examples/local-chat/main.ts .
 *   MUHA_HARNESSES=codex,pi PORT=3000 node examples/local-chat/main.ts .
 * Install the complete @muha-sdk/muha package first. CLI harnesses are detected
 * on PATH; Pi's SDK comes with Muha and needs no globally installed pi command.
 * Selection controls configure a NEW conversation; only the New button commits them.
 * New conversations always use distinct native Sessions; they never share history.
 * Model suggestions are examples, not a discovered catalog or availability check.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { delimiter, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agyAdapter, codexAdapter, createMuhaRuntime, kimiAdapter, MuhaError,
  openCodeAdapter, piAdapter,
  type AgentSession, type ApprovalPolicy, type HarnessKind,
  type HarnessRegistration, type MuhaRuntime, type QuestionResponse, type TurnHandle,
} from "@muha-sdk/muha";

const factories = { codex: codexAdapter, opencode: openCodeAdapter,
  kimi: kimiAdapter, pi: piAdapter, agy: agyAdapter } as const;
const commands = { codex: "codex", opencode: "opencode", kimi: "kimi", agy: "agy" } as const;

async function commandPresent(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (process.platform !== "win32") { await access(path, constants.X_OK); return true; }
    if (path.toLowerCase().endsWith(".exe")) return true;
    if (info.size > 256 * 1024) return false;
    const source = await readFile(path, "utf8");
    if (/^#![^\r\n]*\bnode(?:\s|\r?\n|$)/u.test(source)) return true;
    // Match the literal npm bin entry accepted by the native Windows launcher.
    const entry = /(?:%dp0%|%~dp0)[\\/]([^"\r\n]+\.(?:m?js|cjs|exe))"/iu.exec(source)?.[1];
    return entry !== undefined && (await stat(resolve(dirname(path), entry))).isFile();
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return false;
  }
}

/** Presence only: no CLI execution, installation, credential probe or model calls. */
export async function installedHarnesses(path: string = process.env.PATH ?? "/usr/bin:/bin"): Promise<HarnessKind[]> {
  const kinds = Object.keys(factories) as HarnessKind[];
  const present = await Promise.all(kinds.map(async kind => {
    // Complete Muha installation supplies the Pi SDK as a production dependency.
    if (kind === "pi") return true;
    for (const directory of path.split(delimiter)) {
      const names = process.platform === "win32" ? [commands[kind] + ".exe", commands[kind], commands[kind] + ".cmd"] : [commands[kind]];
      for (const name of names) if (await commandPresent(resolve(directory || ".", name))) return true;
    }
    return false;
  }));
  return kinds.filter((_, index) => present[index]);
}

class SetupError extends Error {}
const suggestions: Record<HarnessKind, readonly string[]> = {
  codex: ["gpt-6-luna", "gpt-5.6-luna"],
  opencode: ["opencode-go/deepseek-v4.1-flash", "opencode-go/qwen3.8-flash"],
  kimi: ["k3", "deepseek/deepseek-flash"],
  pi: ["opencode-go/deepseek-v4.1-flash", "opencode-go/qwen3.8-flash"],
  agy: ["claude-sonnet-4-6"],
};

export function selectHarnesses(value?: string): [HarnessKind, ...HarnessKind[]] {
  const kinds = value === undefined ? Object.keys(factories) : value.split(",").map(s => s.trim());
  if (!kinds.length || kinds.some(kind => !Object.hasOwn(factories, kind)) ||
      new Set(kinds).size !== kinds.length) {
    throw new Error("MUHA_HARNESSES must contain unique names: codex,opencode,kimi,pi,agy");
  }
  return kinds as [HarnessKind, ...HarnessKind[]];
}

export function exampleRegistrations(kinds: readonly [HarnessKind, ...HarnessKind[]]):
  [HarnessRegistration, ...HarnessRegistration[]] {
  return kinds.map(kind => factories[kind]()) as [HarnessRegistration, ...HarnessRegistration[]];
}

/** MUHA_HARNESSES narrows local discovery; it cannot enable an absent native CLI. */
export async function createInstalledChatRuntime(options: {
  harnesses?: string; path?: string; createRuntime?: typeof createMuhaRuntime;
} = {}) {
  const requested = selectHarnesses(options.harnesses);
  const installed = await installedHarnesses(options.path);
  const enabled = requested.filter(kind => installed.includes(kind));
  if (!enabled.length) throw new SetupError("No locally installed harness matches MUHA_HARNESSES. Install its native CLI or include pi (provided by the complete @muha-sdk/muha installation).");
  const runtime = await (options.createRuntime ?? createMuhaRuntime)({
    harnesses: exampleRegistrations(enabled as [HarnessKind, ...HarnessKind[]]),
  });
  return { runtime, skipped: requested.filter(kind => !installed.includes(kind)) };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(body: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new HttpError(400, "Unknown request field");
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} must be non-empty text`);
  return value;
}

function optionalSelection(body: Record<string, unknown>, key: string): string | undefined {
  return body[key] === undefined ? undefined : text(body[key], key);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new HttpError(415, "Use application/json");
  }
  if (Number(req.headers["content-length"]) > 256 * 1024) {
    req.resume();
    throw new HttpError(413, "Request exceeds 256 KiB");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk as Uint8Array);
    bytes += data.length;
    if (bytes > 256 * 1024) throw new HttpError(413, "Request exceeds 256 KiB");
    chunks.push(data);
  }
  try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON");
  }
}

function publicError(error: unknown) {
  if (error instanceof MuhaError) return error.data;
  if (error instanceof HttpError) return { code: "EXAMPLE_REQUEST_ERROR", message: error.message };
  // Do not expose arbitrary Node errors, stack traces or native process logs.
  return { code: "EXAMPLE_ERROR", message: "Local example operation failed" };
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function streamWrite(res: ServerResponse, value: unknown) {
  if (res.destroyed) return;
  if (res.write(`data: ${JSON.stringify(value)}\n\n`)) return;
  await new Promise<void>(done => {
    const finish = () => { res.off("drain", finish); res.off("close", finish); done(); };
    res.once("drain", finish); res.once("close", finish);
    if (res.destroyed) finish();
  });
}

interface Conversation { session: AgentSession; busy: boolean; turn?: TurnHandle }

/** Owns the supplied Runtime, including cleanup if listening fails. Tests inject a fake Runtime. */
export async function startChatServer(runtime: MuhaRuntime,
  options: { workspacePath: string; port?: number }) {
  const conversations = new Map<string, Conversation>();
  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(24).toString("hex");
  let origin = "";
  let closing = false;
  let pendingCreates = 0;
  let closePromise: Promise<void> | undefined;
  let workspacePath: string;

  const summary = (id: string, entry: Conversation) => ({ id, reference: entry.session.reference,
    model: entry.session.model ?? null, effort: entry.session.effort ?? null,
    status: entry.session.status.status });

  async function streamTurn(entry: Conversation, body: Record<string, unknown>, res: ServerResponse) {
    onlyKeys(body, ["text"]);
    const prompt = text(body.text, "text");
    if (entry.busy) throw new HttpError(409, "Conversation is busy");
    entry.busy = true; // Cover startTurn's async acceptance window as well as the active Turn.
    let turn: TurnHandle | undefined;
    const disconnect = () => {
      if (!res.writableEnded && turn) {
        void turn.interrupt().catch(() => { void close().catch(() => undefined); });
      }
    };
    res.once("close", disconnect);
    try {
      turn = await entry.session.startTurn([{ type: "text", text: prompt }]);
      entry.turn = turn;
      if (res.destroyed) { await turn.interrupt(); }
      else res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no" });
      await streamWrite(res, { kind: "accepted", turnId: turn.turnId });
      // Continue draining after disconnect so Core is not left with an orphaned iterator.
      for await (const event of turn) await streamWrite(res, { kind: "event", event });
      await streamWrite(res, { kind: "result", result: await turn.result });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) throw error;
      await streamWrite(res, { kind: "error", error: publicError(error) });
      if (turn) {
        try { await turn.interrupt(); }
        catch { await close(); }
      }
    } finally {
      delete entry.turn;
      entry.busy = false;
      res.off("close", disconnect);
      if (res.headersSent && !res.destroyed) res.end();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; ` +
      `style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    // Strict Host defeats DNS rebinding; no permissive CORS or network listen address.
    if (req.headers.host !== new URL(origin).host ||
        req.headers.origin !== undefined && req.headers.origin !== origin ||
        req.headers["sec-fetch-site"] === "cross-site") {
      throw new HttpError(403, "Only same-origin loopback access is allowed");
    }
    const path = new URL(req.url ?? "/", origin).pathname;
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page.replaceAll("__NONCE__", nonce).replace("__TOKEN__", token));
      return;
    }
    if (req.headers["x-muha-token"] !== token) throw new HttpError(403, "Missing local API token");
    if (closing || runtime.status !== "active") throw new HttpError(503, "Runtime is closing or closed");
    if (req.method === "GET" && path === "/api/config") {
      json(res, 200, { workspacePath, harnesses: runtime.enabledHarnesses.map(harness => ({
        harness, models: suggestions[harness], capabilities: runtime.getHarnessCapabilities(harness),
      })) });
      return;
    }
    if (req.method === "POST" && path === "/api/sessions") {
      const body = await readBody(req);
      onlyKeys(body, ["harness", "model", "effort", "approvalPolicy"]);
      const harness = text(body.harness, "harness") as HarnessKind;
      if (!runtime.enabledHarnesses.includes(harness)) throw new HttpError(400, "Harness is not enabled");
      const caps = runtime.getHarnessCapabilities(harness);
      const approvalPolicy = text(body.approvalPolicy, "approvalPolicy") as ApprovalPolicy;
      if (!caps.approvalPolicies.includes(approvalPolicy)) throw new HttpError(400, "Unsupported approval policy");
      const model = optionalSelection(body, "model"), effort = optionalSelection(body, "effort");
      if (conversations.size + pendingCreates >= 20) throw new HttpError(429, "Close a conversation first (limit 20)");
      pendingCreates++;
      try {
        const session = await runtime.createSession({ harness, workspacePath, approvalPolicy,
          ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) });
        if (closing) { await session.close(); throw new HttpError(503, "Server closed during creation"); }
        const id = randomUUID(), entry = { session, busy: false };
        conversations.set(id, entry);
        json(res, 201, summary(id, entry));
      } finally { pendingCreates--; }
      return;
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(turn|interrupt|approval|question))?$/.exec(path);
    const id = match?.[1];
    const entry = id === undefined ? undefined : conversations.get(id);
    if (!entry || !id) throw new HttpError(404, "Unknown conversation or endpoint");
    const action = match?.[2];
    if (req.method === "DELETE" && !action) {
      if (entry.busy) throw new HttpError(409, "Stop the Turn before closing this conversation");
      entry.busy = true;
      try { await entry.session.close(); conversations.delete(id); json(res, 200, { closed: true }); }
      finally { entry.busy = false; }
      return;
    }
    const body = await readBody(req);
    if (req.method === "PATCH" && !action) {
      onlyKeys(body, ["model", "effort"]); // No harness/workspace mutation, ever.
      const model = optionalSelection(body, "model"), effort = optionalSelection(body, "effort");
      if (model === undefined && effort === undefined) throw new HttpError(400, "Specify model or effort");
      if (entry.busy) throw new HttpError(409, "Stop the Turn before changing selection");
      const caps = runtime.getHarnessCapabilities(entry.session.reference.harness);
      // Preflight both setters before either can mutate anything.
      if (model !== undefined && !caps.model.selectionAt.includes("idleSession") ||
          effort !== undefined && !caps.effort.selectionAt.includes("idleSession")) {
        throw new HttpError(409, "This harness requires a new conversation for this selection");
      }
      entry.busy = true;
      try {
        if (model !== undefined) await entry.session.setModel(model); // Also clears the old effort.
        if (effort !== undefined) await entry.session.setEffort(effort);
        json(res, 200, summary(id, entry));
      } catch (error) {
        // Setters are NOT transactional: expose current state after partial native success.
        json(res, error instanceof MuhaError ? 422 : 500, { error: publicError(error), session: summary(id, entry) });
      } finally { entry.busy = false; }
      return;
    }
    if (req.method !== "POST") throw new HttpError(405, "Unsupported method");
    if (action === "turn") { await streamTurn(entry, body, res); return; }
    const turn = entry.turn;
    if (!turn || body.turnId !== turn.turnId) throw new HttpError(409, "Turn is no longer active");
    if (action === "interrupt") { onlyKeys(body, ["turnId"]); await turn.interrupt(); }
    else if (action === "approval") {
      onlyKeys(body, ["turnId", "requestId", "decision"]);
      if (body.decision !== "allowOnce" && body.decision !== "deny") throw new HttpError(400, "Invalid approval decision");
      await turn.respondToApproval(text(body.requestId, "requestId"), body.decision);
    } else if (action === "question") {
      onlyKeys(body, ["turnId", "requestId", "response"]);
      await turn.respondToQuestion(text(body.requestId, "requestId"), record(body.response) as unknown as QuestionResponse);
    } else throw new HttpError(404, "Unknown action");
    json(res, 200, { ok: true });
  }

  const server = createServer((req, res) => {
    void route(req, res).catch(error => {
      if (res.headersSent || res.destroyed) { res.end(); return; }
      json(res, error instanceof HttpError ? error.status : error instanceof MuhaError ? 422 : 500,
        { error: publicError(error) });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true;
      const stopped = new Promise<void>(done => server.close(() => done()));
      try { await runtime.close(); }
      finally { server.closeAllConnections(); await stopped; }
    })();
    return closePromise;
  }
  try {
    workspacePath = await realpath(resolve(options.workspacePath));
    if (!(await stat(workspacePath)).isDirectory()) throw new Error("Workspace must be a directory");
    const port = options.port ?? 3000;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(port, "127.0.0.1", () => { server.off("error", fail); done(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Startup and cleanup failed"); }
    throw error;
  }
  void runtime.termination.then(() => close()).catch(() => { process.stderr.write("Chat Runtime cleanup failed\n"); });
  return { url: origin, close };
}

// All CSS and browser JavaScript live in this same file. Native content uses textContent, never HTML.
const page = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="muha-token" content="__TOKEN__"><title>Muha · Multi-Harness Chat</title>
<style nonce="__NONCE__">
:root{color-scheme:light;--ink:#202338;--muted:#747a90;--accent:#6c58df;--line:#e9eaf2}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:radial-gradient(ellipse at 8% 0%,#ece7ff88,transparent 46%),#f6f7fb;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.45}
button,input,select,textarea{border-radius:11px;border:1px solid #dddfea;background:white;color:inherit}
button{padding:9px 15px;transition:background .15s,box-shadow .15s}button:hover:enabled{background:#f2efff}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #d8cfff;outline-offset:2px}
.app{max-width:1320px;margin:0 auto;padding:28px 32px}.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:26px}
.brand{display:flex;align-items:center;gap:12px}.logo{display:grid;place-items:center;width:43px;height:43px;border-radius:14px;background:var(--accent);color:white;font-size:24px;font-weight:800;box-shadow:0 6px 16px #6c58df22}
.brand h1{font-size:21px;letter-spacing:-.7px;margin:0}.brand p{margin:0;color:var(--muted);font-size:12px}
.local-badge{font-size:11px;letter-spacing:1.4px;border:1px solid var(--line);padding:5px 11px;border-radius:30px;background:white;color:#697082;white-space:nowrap}
.layout{display:grid;grid-template-columns:286px minmax(0,1fr);gap:22px;align-items:start}.sidebar,.conversation{background:#fff;border:1px solid var(--line);border-radius:20px;box-shadow:0 8px 32px #31305b05}
.sidebar{padding:24px}.eyebrow{font-size:10px;font-weight:650;letter-spacing:1.6px;color:#9296aa}.sidebar h2{font-size:17px;margin:5px 0 4px}.muted{color:var(--muted);font-size:12px}.sidebar p{margin-top:0}
.field{display:block;margin-top:19px;font-size:12px;font-weight:550}.field span{float:right;font-size:10px;font-weight:400;color:#969bad}
.field input,.field select{display:block;width:100%;min-width:0;margin-top:7px;padding:11px 12px;font-size:13px;background:#fafbfe;font-weight:400}
.help{font-size:11px;color:#8b90a2;margin-top:6px;line-height:1.65}.config-note{padding:11px 12px;background:#f6f5fc;border-radius:10px;color:#77718c;font-size:11px;margin:20px 0 12px}.config-note.pending{color:#6551c5;background:#f0ecff}
button.primary{color:white;background:var(--accent);border-color:var(--accent);box-shadow:0 3px 9px #6c58df18;font-weight:550}button.primary:hover:enabled{background:#5c47d2}
#fresh{width:100%;padding:11px}.sidebar details{border-top:1px solid var(--line);padding-top:16px;margin-top:22px;font-size:11px;color:var(--muted)}summary{cursor:pointer}.sidebar details p{margin:9px 0;overflow-wrap:anywhere}
.workspace{display:flex;align-items:center;gap:8px;margin-top:18px;font-size:11px;color:#8b90a2}#workspace{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.conversation{overflow:hidden;min-width:0}.conversation-head{padding:21px 26px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:16px}
.conversation-head h2{font-size:16px;margin:3px 0}.active-title{display:flex;gap:9px;align-items:center}.harness-badge{font-size:10px;padding:3px 8px;border-radius:6px;background:#efebff;color:#705aca;max-width:130px;overflow-wrap:anywhere}
#conversation-meta{font-size:11px;color:var(--muted);overflow-wrap:anywhere}.connection-state{font-size:11px;white-space:nowrap;color:#8b90a2;display:flex;align-items:center;gap:6px}.connection-state:before{content:"";width:6px;height:6px;border-radius:50%;background:#b7bbca}.connection-state[data-state="ready"]:before{background:#48aa87}.connection-state[data-state="running"]:before{background:var(--accent)}
#chat{height:clamp(320px,calc(100dvh - 415px),680px);overflow:auto;padding:24px 26px;scrollbar-width:thin;scrollbar-color:#e3e0f0 transparent}
.empty{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px 8px}.empty-mark{display:grid;place-items:center;width:63px;height:63px;border-radius:20px;background:#f0edff;color:var(--accent);font-size:29px;margin-bottom:17px}.empty h3{font-size:20px;letter-spacing:-.4px;margin:0 0 7px}.empty p{font-size:12px;color:var(--muted);max-width:360px;margin:0}.starter-row{display:flex;gap:7px;flex-wrap:wrap;justify-content:center;margin-top:21px}.starter-row button{font-size:11px;background:#fafafe;padding:7px 10px;color:#78728e}
.bubble{max-width:94%;margin:0 0 22px;overflow-wrap:anywhere}.bubble.user{margin-left:auto;max-width:82%}.bubble.user .message-body{background:#efebff;border-radius:15px 15px 3px 15px;padding:12px 17px}.bubble.assistant .message-body{padding:3px 0}.bubble.error .message-body{padding:12px 15px;border-radius:12px;background:#fff1f0;color:#b34d47}.role{font-size:10px;letter-spacing:.6px;font-weight:600;color:#9396aa;margin-bottom:6px}.bubble.user .role{text-align:right}.message-body{white-space:pre-wrap;font-size:14px;line-height:1.8}
.event-card{border:1px solid #ebeaf3;border-radius:11px;background:#fbfbfd;margin:0 0 13px;padding:11px 14px;min-width:0}.event-head{display:flex;justify-content:space-between;align-items:center;gap:10px}.event-title{font-size:11px;font-weight:600;color:#78728b;overflow-wrap:anywhere}.event-sequence{font:10px ui-monospace,monospace;color:#a1a4b5;white-space:nowrap}.event-body{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.7 ui-monospace,SFMono-Regular,monospace;margin:7px 0 0;max-height:200px;overflow:auto;color:#73758a}
.event-card.reasoning{background:#f8f6ff;border-color:#efebff}.event-card.reasoning .event-body{font:12px/1.8 system-ui,sans-serif;color:#89809e}.event-card.completed{border-color:#e0efe9;background:#f6fbf8}.event-card.completed .event-title{color:#43866b}.event-card.failed,.event-card.error{border-color:#f2dedc;background:#fff8f7}.event-card.failed .event-title,.event-card.error .event-title{color:#b45a53}.event-card.interrupted,.event-card.retry{background:#fffbf2;border-color:#f4ecda}
.interaction{border-color:#ded5ff;background:#faf8ff}.interaction .event-body{max-height:240px}.interaction textarea{display:block;width:100%;height:170px;resize:vertical;margin:10px 0;padding:10px 12px;font:11px/1.65 ui-monospace,monospace}.interaction-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.interaction-actions button{font-size:11px;padding:6px 12px}.interaction.resolved{background:#fafbfd;border-color:var(--line)}.interaction-status{font-size:10px;color:#938ca6;margin-top:7px}
.composer{margin:0 20px 18px;border:1px solid #e5e2ef;border-radius:14px;background:#fff;box-shadow:0 3px 12px #31305b04;padding:11px 13px 10px}#prompt{display:block;width:100%;height:75px;resize:vertical;border:0;border-radius:7px;padding:4px 3px;min-height:55px;max-height:230px;font-size:13px;background:transparent}#prompt:disabled{background:transparent}.composer-actions{display:flex;justify-content:space-between;align-items:center;gap:10px}.keyboard-hint{font-size:10px;color:#a0a2b1}.actions{display:flex;gap:7px}#send,#stop{font-size:12px;padding:7px 15px}#status{color:#86889c;font-size:11px;min-height:20px;margin:0 26px 16px;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:850px){.app{padding:18px}.layout{grid-template-columns:225px minmax(0,1fr);gap:14px}.sidebar{padding:18px}.conversation-head{padding:17px}#chat{padding:20px 17px}.composer{margin:0 12px 14px}.keyboard-hint{display:none}}
@media(max-width:640px){.app{padding:16px 12px}.topbar{margin-bottom:18px}.brand h1{font-size:18px}.brand p{font-size:10px}.layout{grid-template-columns:minmax(0,1fr)}.sidebar{padding:18px}.draft-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 12px}.field{margin-top:12px}.config-note{margin-top:15px}.sidebar details{margin-top:16px}.conversation-head{gap:8px}.connection-state{font-size:10px}#chat{height:430px}.bubble{max-width:100%}.conversation-head .eyebrow{font-size:9px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
</style></head><body><main class="app"><header class="topbar"><div class="brand"><div class="logo" aria-hidden="true">m</div><div><h1>Muha Playground</h1><p>五种 Harness，一套对话接口。</p></div></div><span class="local-badge">LOCAL · PRIVATE</span></header>
<div class="layout"><aside class="sidebar"><div class="eyebrow">NEXT CONVERSATION</div><h2>新对话配置</h2><p class="muted">自由选择 Harness 与原生模型。</p>
<div class="draft-fields"><label class="field" for="harness">Harness<select id="harness" disabled></select></label>
<label class="field" for="model">Model <span>原生标识</span><input id="model" list="models" placeholder="使用原生默认" disabled><datalist id="models"></datalist></label>
<label class="field" for="effort">Effort <span>可选</span><input id="effort" placeholder="使用原生默认" disabled></label>
<label class="field" for="policy">Approval policy<select id="policy" disabled></select></label></div>
<div id="model-hint" class="help"></div><div id="effort-hint" class="help"></div><div id="draft-note" class="config-note">这些选项仅对新对话生效，不会修改当前会话。</div>
<button id="fresh" class="primary" disabled>＋ 新对话</button><div class="help">创建成功后才切换对话；旧原生历史不会被删除。</div>
<div class="help">发送消息会调用真实模型，可能消耗订阅额度或产生费用，并执行原生工具。打开页面或新建对话不会自动发送消息。</div>
<details><summary>能力与使用说明</summary><p id="capabilities"></p><p>Model 提示仅为示例，不是完整目录。Effort 与模型相关，默认不启用重试。</p><p>原生工具可能修改文件或运行命令。harnessManaged / autoApprove 不是沙箱，autoDeny 也不禁止无需审批的操作。</p></details>
<div class="workspace"><span aria-hidden="true">▱</span><span id="workspace"></span></div></aside>
<section class="conversation" aria-label="对话"><header class="conversation-head"><div><div class="eyebrow">CONVERSATION</div><div class="active-title"><h2>对话</h2><span id="active-harness" class="harness-badge">尚未开始</span></div><div id="conversation-meta">选择配置，点击“新对话”开始。</div></div><span id="connection-state" class="connection-state" data-state="idle">等待开始</span></header>
<div id="chat" role="log" aria-label="聊天与本轮事件" aria-live="polite"></div>
<div class="composer"><textarea id="prompt" aria-label="消息" placeholder="先点击“新对话”，然后输入你的消息…" disabled></textarea><div class="composer-actions"><span class="keyboard-hint">Enter 发送 · Shift + Enter 换行</span><div class="actions"><button id="stop" disabled>停止</button><button id="send" class="primary" disabled>发送 ↗</button></div></div></div>
<div id="status" role="status">正在加载本地配置…</div></section></div></main><script nonce="__NONCE__">
'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="muha-token"]').content;
const drafts = new Map(); let config, current, busy = false, creating = false;
const harnessLabels = { codex: 'Codex CLI', opencode: 'OpenCode', kimi: 'Kimi Code', pi: 'Pi', agy: 'AGY' };
function note(message) { $('status').textContent = message; }
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'x-muha-token': token,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(value.error || value));
  }
  return value;
}
function profile() { return config.harnesses.find(p => p.harness === $('harness').value); }
function appendChat(node) {
  const chat = $('chat'), follow = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100;
  chat.append(node);
  if (follow) chat.scrollTop = chat.scrollHeight;
}
function updateText(node, value) {
  const chat = $('chat'), follow = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100;
  node.textContent = value;
  if (follow) chat.scrollTop = chat.scrollHeight;
}
function bubble(role, value) {
  const wrapper = document.createElement('div'); wrapper.className = 'bubble ' + role;
  const title = document.createElement('div'); title.className = 'role';
  title.textContent = role === 'user' ? 'YOU' : role === 'error' ? 'ERROR' : 'MUHA · ' + harnessLabels[current.session.reference.harness];
  const body = document.createElement('div'); body.className = 'message-body'; body.textContent = value;
  wrapper.append(title, body); appendChat(wrapper);
  return body;
}
function emptyState() {
  const node = document.createElement('div'); node.className = 'empty';
  const mark = document.createElement('div'); mark.className = 'empty-mark'; mark.textContent = '✳';
  const title = document.createElement('h3'); title.textContent = current ? '新的对话，新的可能。' : '从一段新对话开始。';
  const help = document.createElement('p'); help.textContent = current ?
    '发送消息后，回复、推理、工具和用量会在这里实时呈现。' : '在左侧选择 Harness 和模型，点击“新对话”。配置变更不会影响已开始的对话。';
  node.append(mark, title, help);
  if (current) {
    const row = document.createElement('div'); row.className = 'starter-row';
    for (const sample of ['概述这个项目的结构', '帮我检查潜在的问题', '解释一段代码的工作原理']) {
      const button = document.createElement('button'); button.textContent = sample;
      button.onclick = () => { if (!busy) { $('prompt').value = sample; $('prompt').focus(); } };
      row.append(button);
    }
    node.append(row);
  }
  $('chat').replaceChildren(node);
}
function selections() {
  return { harness: $('harness').value, approvalPolicy: $('policy').value,
    ...($('model').value.trim() ? { model: $('model').value.trim() } : {}),
    ...($('effort').value.trim() ? { effort: $('effort').value.trim() } : {}) };
}
function describeDraft() {
  const caps = profile().capabilities;
  $('capabilities').textContent = 'Model: ' + caps.model.observation + ' · Effort: ' + caps.effort.observation +
    ' · Questions: ' + caps.turnQuestions + ' · Tool events: ' + caps.toolEvents;
  $('model').disabled = !caps.model.selectionAt.includes('createSession');
  $('effort').disabled = !caps.effort.selectionAt.includes('createSession');
  $('model-hint').textContent = profile().harness === 'kimi' ?
    'Kimi 模型示例：k3 或 deepseek/deepseek-flash。后者是 Kimi Code 的第三方 provider 配置示例，需先在原生配置中设置对应 provider、凭据和模型；Muha 不会自动配置。' : '';
  $('effort-hint').textContent = profile().harness === 'agy' ? 'AGY Sonnet 不接受显式 Effort，请留空。' :
    'Effort 是模型相关的原生值；留空使用默认。';
  const pending = current && JSON.stringify(selections()) !== JSON.stringify(current.selection);
  $('draft-note').className = 'config-note' + (pending ? ' pending' : '');
  $('draft-note').textContent = pending ? '配置已调整。点击“新对话”后生效，当前对话保持不变。' : '这些选项仅对新对话生效，不会修改当前会话。';
}
function lock(value) {
  busy = value;
  $('fresh').disabled = value || !config;
  $('fresh').textContent = creating ? '正在创建…' : '＋ 新对话';
  $('send').disabled = value || !current;
  $('prompt').disabled = value || !current;
  $('stop').disabled = !value || !current?.turnId;
  $('connection-state').dataset.state = value ? 'running' : current ? 'ready' : 'idle';
  $('connection-state').textContent = value ? creating ? '创建中' : '运行中' : current ? '就绪' : '等待开始';
  if (config) describeDraft();
}
function stageHarness() {
  const p = profile(), draft = drafts.get(p.harness) || {};
  $('models').replaceChildren(...p.models.map(model => { const o = document.createElement('option'); o.value = model; return o; }));
  $('policy').replaceChildren(...p.capabilities.approvalPolicies.map(policy => { const o = document.createElement('option'); o.value = o.textContent = policy; return o; }));
  $('model').value = draft.model || '';
  $('effort').value = draft.effort || '';
  $('policy').value = draft.approvalPolicy || (p.capabilities.approvalPolicies.includes('interactive') ? 'interactive' : 'harnessManaged');
  describeDraft(); // Deliberately never touches the active conversation or its chat DOM.
}
function updateActiveHeader() {
  const session = current.session;
  $('active-harness').textContent = harnessLabels[session.reference.harness];
  $('conversation-meta').textContent = (session.model || '原生默认模型') +
    (session.effort ? ' · Effort: ' + session.effort : '') + ' · ' + session.reference.sessionId.slice(0, 8);
  $('conversation-meta').title = session.reference.sessionId;
  $('prompt').placeholder = '输入你的消息，与 ' + harnessLabels[session.reference.harness] + ' 一起工作…';
}
async function control(action, fields = {}, owner = current) {
  if (!owner?.turnId) throw new Error('当前没有可操作的 Turn。');
  return api('/api/sessions/' + owner.session.id + '/' + action, 'POST', { turnId: owner.turnId, ...fields });
}
function eventCard(title, content, event, kind = '') {
  const card = document.createElement('div'); card.className = 'event-card ' + kind;
  if (event) card.dataset.eventType = event.type;
  const head = document.createElement('div'); head.className = 'event-head';
  const label = document.createElement('span'); label.className = 'event-title'; label.textContent = title;
  const sequence = document.createElement('span'); sequence.className = 'event-sequence';
  sequence.textContent = event ? '#' + event.sequence : '';
  const body = document.createElement('pre'); body.className = 'event-body';
  body.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  head.append(label, sequence); card.append(head, body); appendChat(card);
  return { card, body, sequence };
}
function messageNode(messageId) {
  if (!current.messages.has(messageId)) current.messages.set(messageId, bubble('assistant', ''));
  return current.messages.get(messageId);
}
function finalMessage(message) { updateText(messageNode(message.id), message.text); }
function renderEvent(event) {
  // Wait for visible content so a placeholder reply does not precede its reasoning/tools.
  if (event.type === 'assistant.message.started') return;
  if (event.type === 'assistant.message.delta') {
    const node = messageNode(event.messageId); updateText(node, node.textContent + event.delta); return;
  }
  if (event.type === 'assistant.message.completed') { finalMessage(event.message); return; }
  if (event.type === 'assistant.reasoning.delta') {
    if (!current.reasoning.has(event.messageId)) current.reasoning.set(event.messageId, eventCard('◇ 推理', '', event, 'reasoning'));
    const node = current.reasoning.get(event.messageId); updateText(node.body, node.body.textContent + event.delta);
    node.sequence.textContent = '#' + event.sequence;
    return;
  }
  if (event.type === 'approval.requested' || event.type === 'question.requested') { interaction(event); return; }
  if (event.type === 'approval.resolved' || event.type === 'question.resolved') {
    const entry = current.interactions.get(event.requestId);
    if (entry) {
      entry.card.className = 'event-card interaction resolved'; entry.card.dataset.resolved = 'true';
      for (const button of entry.buttons) button.disabled = true;
      if (entry.editor) entry.editor.disabled = true;
      entry.status.textContent = '已处理 · ' + event.outcome;
    }
    eventCard(event.type === 'approval.resolved' ? '✓ 审批结果' : '✓ 追问结果', event, event);
    return;
  }
  if (event.type === 'turn.started') eventCard('↗ 本轮开始', '事件将在对话中实时呈现。', event);
  else if (event.type === 'tool.started') {
    current.tools.set(event.toolCallId, event.toolName);
    eventCard('⌘ 工具 · ' + event.toolName, { input: event.input }, event);
  } else if (event.type === 'tool.updated') eventCard('↳ 工具更新 · ' + current.tools.get(event.toolCallId), { update: event.update }, event);
  else if (event.type === 'tool.completed') eventCard((event.isError ? '× 工具失败 · ' : '✓ 工具完成 · ') + current.tools.get(event.toolCallId), { output: event.output }, event, event.isError ? 'failed' : '');
  else if (event.type === 'usage.updated') eventCard('◷ Token 用量', event.usage, event);
  else if (event.type === 'turn.retrying') eventCard('↻ 重试 ' + event.retryNumber + '/' + event.maxRetries, event.error, event, 'retry');
  else if (event.type === 'turn.completed') {
    finalMessage(event.message); current.terminalShown = true;
    eventCard('✓ 本轮完成', event.usage || '已收到完成终态。', event, 'completed');
  } else if (event.type === 'turn.failed') {
    current.terminalShown = true; eventCard('× 本轮失败', event.error, event, 'failed');
  } else if (event.type === 'turn.interrupted') {
    current.terminalShown = true; eventCard('■ 本轮已停止', { reason: event.reason }, event, 'interrupted');
  } else eventCard(event.type, event, event);
}
function answerTemplate(questions) {
  return { action: 'answer', answers: questions.map(q => {
    if (q.default.kind !== 'none') return { questionId: q.questionId, kind: 'useDefault' };
    const kind = q.input.kind;
    if (kind === 'select' || kind === 'multiselect') return { questionId: q.questionId, kind: 'selection', optionIds: [], customValues: [] };
    if (kind === 'text') return { questionId: q.questionId, kind: 'text', text: '' };
    if (kind === 'number') return { questionId: q.questionId, kind: 'number', value: null };
    if (kind === 'boolean') return { questionId: q.questionId, kind: 'boolean', value: null };
    return { questionId: q.questionId, kind: 'externalAcknowledged' };
  }) };
}
function interaction(event) {
  const owner = current;
  const { card } = eventCard(event.type === 'approval.requested' ? '◈ 需要审批' : '◈ Agent 追问',
    event.type === 'approval.requested' ? { title: event.title, description: event.description, details: event.details } :
      { description: event.description, questions: event.questions }, event, 'interaction');
  card.dataset.requestId = event.requestId;
  const actions = document.createElement('div'); actions.className = 'interaction-actions';
  const status = document.createElement('div'); status.className = 'interaction-status'; status.textContent = '等待你的回应';
  const entry = { card, buttons: [], status }; owner.interactions.set(event.requestId, entry);
  function button(label, action) {
    const b = document.createElement('button'); b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try { await action(); } catch (error) { if (current === owner) note(error.message); }
      finally { b.disabled = card.dataset.resolved === 'true'; }
    };
    entry.buttons.push(b); actions.append(b);
  }
  if (event.type === 'approval.requested') {
    button('允许一次', () => control('approval', { requestId: event.requestId, decision: 'allowOnce' }, owner));
    button('拒绝', () => control('approval', { requestId: event.requestId, decision: 'deny' }, owner));
  } else {
    const hint = document.createElement('p'); hint.className = 'muted';
    hint.textContent = '编辑原生类型答案 JSON；选项使用 optionId，条件不满足的字段用 kind: skipped。hidden default 只用 useDefault，不读取值。externalAcknowledged 仅在实际完成外部操作后提交。Core 验证失败可继续修改。';
    const editor = document.createElement('textarea'); editor.setAttribute('aria-label', 'Question 答案 JSON');
    editor.value = JSON.stringify(answerTemplate(event.questions), null, 2); entry.editor = editor;
    card.append(hint, editor);
    button('提交答案', () => control('question', { requestId: event.requestId, response: JSON.parse(editor.value) }, owner));
    button('Dismiss', () => control('question', { requestId: event.requestId, response: { action: 'dismiss' } }, owner));
  }
  card.append(actions, status);
}
async function send() {
  const prompt = $('prompt').value;
  if (busy || !prompt.trim() || !current) return;
  lock(true); let sawResult = false;
  try {
    const response = await fetch('/api/sessions/' + current.session.id + '/turn', { method: 'POST',
      headers: { 'x-muha-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ text: prompt }) });
    if (!response.ok) throw new Error(JSON.stringify(await response.json()));
    if (!current.started) { $('chat').replaceChildren(); current.started = true; }
    bubble('user', prompt); $('prompt').value = '';
    current.messages = new Map(); current.reasoning = new Map(); current.tools = new Map();
    current.interactions = new Map(); current.terminalShown = false;
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    function receive(frame) {
      if (frame.kind === 'accepted') { current.turnId = frame.turnId; $('stop').disabled = false; note('运行中…'); }
      if (frame.kind === 'event') {
        renderEvent(frame.event);
      }
      if (frame.kind === 'result') {
        sawResult = true;
        if (frame.result.status === 'completed') finalMessage(frame.result.message);
        if (!current.terminalShown) eventCard('本轮结果 · ' + frame.result.status, frame.result, null, frame.result.status);
        note(frame.result.status === 'failed' ? JSON.stringify(frame.result.error) : frame.result.status);
      }
      if (frame.kind === 'error') throw new Error(JSON.stringify(frame.error));
    }
    while (true) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (frame.startsWith('data: ')) receive(JSON.parse(frame.slice(6)));
      }
      if (part.done) break;
    }
    if (!sawResult) throw new Error('连接已断开，未收到终态；不能视为成功。');
  } catch (error) {
    // Cancel an accepted Turn if browser parsing/reading fails, not only on network loss.
    if (current.turnId && !sawResult) { try { await control('interrupt'); } catch {} }
    if (!current.started) { $('chat').replaceChildren(); current.started = true; }
    bubble('error', error.message); note(error.message);
  } finally {
    current.turnId = null;
    for (const entry of current.interactions?.values() || []) {
      for (const button of entry.buttons) button.disabled = true;
      if (entry.editor) entry.editor.disabled = true;
      if (entry.card.dataset.resolved !== 'true') entry.status.textContent = '本轮已结束';
      entry.card.dataset.resolved = 'true';
    }
    lock(false);
  }
}
$('send').onclick = send;
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } };
$('harness').onchange = stageHarness;
for (const id of ['model','effort','policy']) $(id).oninput = () => { drafts.set(profile().harness, selections()); describeDraft(); };
$('stop').onclick = async () => {
  const owner = current, turnId = owner?.turnId;
  try {
    await control('interrupt', {}, owner);
    // The terminal SSE result can arrive BEFORE the interrupt HTTP acknowledgement.
    if (busy && current === owner && current.turnId === turnId) note('已请求停止…');
  } catch (error) { if (busy && current === owner) note(error.message); }
};
$('fresh').onclick = async () => {
  if (busy || !config) return;
  const selection = selections(); creating = true; lock(true);
  let replacement;
  try {
    // Validate the replacement first. A bad native model must not destroy the old chat.
    replacement = await api('/api/sessions', 'POST', selection);
    if (current) await api('/api/sessions/' + current.session.id, 'DELETE');
    current = { session: replacement, selection, started: false, turnId: null };
    updateActiveHeader(); emptyState(); $('prompt').value = '';
    note('新对话已创建。旧原生历史未删除，上下文不会迁移。');
  } catch (error) {
    if (replacement) {
      try { await api('/api/sessions/' + replacement.id, 'DELETE'); }
      catch { note(error.message + '\n新会话清理失败，请重启本地服务。'); return; }
    }
    note(error.message);
  } finally { creating = false; lock(false); }
};
async function init() {
  emptyState();
  try {
    config = await api('/api/config');
    $('workspace').textContent = 'Workspace: ' + config.workspacePath;
    $('harness').replaceChildren(...config.harnesses.map(p => { const o = document.createElement('option'); o.value = o.textContent = p.harness; return o; }));
    $('harness').disabled = false; $('policy').disabled = false;
    stageHarness(); lock(false); note('选择配置后点击“新对话”开始。');
  } catch (error) { note(error.message); $('send').disabled = true; }
}
void init();
</script></body></html>`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const workspacePath = await realpath(resolve(process.argv[2] ?? process.cwd()));
    if (!(await stat(workspacePath)).isDirectory()) throw new Error("Workspace must be a directory");
    const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1..65535");
    const { runtime, skipped } = await createInstalledChatRuntime(process.env.MUHA_HARNESSES === undefined ? {} : { harnesses: process.env.MUHA_HARNESSES });
    const app = await startChatServer(runtime, { workspacePath, port });
    process.stdout.write(`Muha multi-harness chat: ${app.url}\nWorkspace: ${workspacePath}\n`);
    process.stdout.write(`Installed harnesses: ${runtime.enabledHarnesses.join(", ")}\n`);
    if (skipped.length) process.stdout.write(`Not installed; omitted: ${skipped.join(", ")}\n`);
    const shutdown = () => { void app.close().catch(() => {
      process.stderr.write("Chat shutdown failed\n"); process.exitCode = 1;
    }); };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    void runtime.termination.then(termination => {
      if (termination.reason === "fatal") {
        process.stderr.write("Harness/Runtime failed; restart the example to continue\n"); process.exitCode = 1;
      }
      process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown);
    });
  } catch (error) {
    process.stderr.write(`${error instanceof MuhaError ? JSON.stringify(error.data) : error instanceof SetupError ? error.message : "Could not start chat. Check workspace, PORT, native tools and auth."}\n`);
    process.exitCode = 1;
  }
}

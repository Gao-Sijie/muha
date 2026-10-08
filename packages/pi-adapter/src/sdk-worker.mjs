import "./sdk-process-ownership.mjs";
import { loadSdk } from "./sdk-loader.mjs";
import { listedSessions, openNativeSession } from "./sdk-sessions.mjs";
import { sessionSettings, resolveModel, selection, selectEffort } from "./sdk-settings.mjs";
import { bindExtensions } from "./sdk-extensions.mjs";
const sdk = await loadSdk();
let session;
let modelRuntime;
let extensions;
let running;
let interrupted = false;
const send = message => new Promise((resolve, reject) => {
  process.send(message, error => error ? reject(error) : resolve());
});
const diagnostic = (source, payload) => send({ type: "diagnostic", source, payload });

async function create(options, resume = false) {
  const cwd = options.workspacePath, agentDir = sdk.getAgentDir();
  const settingsManager = sessionSettings(sdk, cwd, agentDir);
  modelRuntime = await sdk.ModelRuntime.create();
  const model = options.model ? resolveModel(modelRuntime, options.model) : undefined;
  const sessionManager = resume ? await openNativeSession(sdk, options, diagnostic) : sdk.SessionManager.create(cwd);
  const result = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, settingsManager,
    sessionManager, ...(model ? { model } : {}), ...(options.effort ? { thinkingLevel: options.effort } : {}) });
  session = result.session;
  if (result.modelFallbackMessage !== undefined) {
    await diagnostic("createAgentSession.modelFallbackMessage", result.modelFallbackMessage);
  }
  await diagnostic("createAgentSession.extensionsResult.errors", result.extensionsResult.errors);
  if (options.model && selection(session).model !== options.model) throw new Error("Pi did not accept the requested model");
  if (options.effort) selectEffort(session, options.effort);
  session.subscribe(event => { void send({ type: "native", event }); });
  extensions = await bindExtensions(session, options.shutdownTimeoutMs ?? 5000, () => interrupted,
    error => { void diagnostic("AgentSession.bindExtensions.onError", error); });
  const effective = selection(session);
  if ((options.model && effective.model !== options.model) || (options.effort && effective.effort !== options.effort)) {
    throw new Error("Pi extension changed the requested Session selection during initialization");
  }
  return { id: session.sessionId, ...selection(session) };
}

process.on("message", async message => {
  const { id, command, args } = message;
  const reply = value => send({ type: "reply", id, value });
  try {
    if (command === "ready") await reply({ version: sdk.VERSION });
    else if (command === "create") await reply(await create(args));
    else if (command === "resume") await reply(await create(args, true));
    else if (command === "list") await reply(await listedSessions(sdk, args.workspacePath, diagnostic));
    else if (command === "setModel") {
      await session.setModel(resolveModel(modelRuntime, args.model));
      if (selection(session).model !== args.model) throw new Error("Pi did not accept the requested model");
      await reply(selection(session));
    } else if (command === "setEffort") await reply(selectEffort(session, args.effort));
    else if (command === "prompt") {
      if (!session || running) throw new Error("Pi Session is unavailable or busy");
      if (args.input.some(part => part.type === "image") &&
          (session.settingsManager.getBlockImages() || !session.model?.input.includes("image"))) {
        throw new Error("Pi configuration or selected model does not accept images");
      }
      interrupted = false;
      extensions.reset();
      const messageCount = session.messages.length;
      let accepted = false;
      running = session.prompt(args.input, { preflightResult(disposition) {
        if (!accepted && ["started", "handled", "queued"].includes(disposition)) {
          extensions.check(); accepted = true; void reply(null);
        }
      } });
      try {
        await running;
        await extensions.settle();
        extensions.check();
        const last = session.messages.slice(messageCount).filter(m => m.role === "assistant").at(-1);
        if (!accepted) { accepted = true; await reply(null); }
        await send({ type: "settled", turnId: args.turnId, interrupted: interrupted || last?.stopReason === "aborted",
          text: last?.content.filter(p => p.type === "text").map(p => p.text).join(""),
          error: last?.stopReason === "error" ? last.errorMessage ?? "Pi model failed" : undefined });
      } catch (error) {
        if (accepted) await send({ type: "settled", turnId: args.turnId, interrupted,
          error: interrupted ? undefined : error.message });
        else throw error;
      } finally { running = undefined; extensions.reset(); }
    } else if (command === "abort") {
      interrupted = true; await session?.abort(); await running?.catch(() => {});
      await extensions?.settle(); await reply(null);
    } else if (command === "close") {
      interrupted = true; await session?.abort(); await running?.catch(() => {});
      await extensions?.settle();
      await extensions?.close(); session?.dispose();
      process.disconnect();
    } else throw new Error("Unknown Pi SDK command");
  } catch (error) { await send({ type: "reply", id, error: error.message,
    nativeCode: error.nativeCode, protocolError: error.protocolError }); }
});

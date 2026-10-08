export async function bindExtensions(session, shutdownTimeoutMs, isInterrupted = () => false, onError) {
  let failure;
  let watchdog;
  const prompts = new Set();
  const nativePrompt = session.prompt.bind(session);
  // SDK extension APIs dispatch through this public high-level method but
  // intentionally return void. Its preflight hooks can still be awaiting when
  // isIdle is true, so observe the promises as well as the native idle boundary.
  session.prompt = (input, options) => {
    const pending = nativePrompt(input, { ...options, preflightResult(disposition) {
      if (["started", "handled", "queued"].includes(disposition) && isInterrupted()) throw new Error("Pi prompt interrupted during preflight");
      options?.preflightResult?.(disposition);
    } });
    prompts.add(pending);
    pending.then(() => prompts.delete(pending), error => {
      prompts.delete(pending);
      failure ??= error;
    });
    return pending;
  };
  const unsupported = name => {
    failure ??= new Error(`Pi extension interaction is unsupported: ${name}`);
    // A third-party handler can catch an error and never settle. Once an
    // unsupported interaction occurs, it cannot retain unbounded execution.
    watchdog ??= setTimeout(() => process.exit(1), shutdownTimeoutMs);
    if (session.isStreaming) void session.abort().catch(() => {});
    throw failure;
  };
  // Retain the SDK's headless context identity, so ctx.hasUI remains false.
  // This object exists only inside this one-Session owned SDK process.
  const ui = session.extensionRunner.getUIContext();
  for (const name of ["select", "confirm", "input", "custom", "editor"]) {
    ui[name] = () => unsupported(name);
  }
  const check = () => { if (failure) throw failure; };
  await session.bindExtensions({
    mode: "print",
    onError,
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      reload: () => session.reload(),
      newSession: () => unsupported("replace Session"),
      fork: () => unsupported("fork Session"),
      switchSession: () => unsupported("switch Session"),
      navigateTree: () => unsupported("navigate Session tree"),
    },
  });
  check();
  return {
    check,
    async settle() {
      do {
        await Promise.allSettled([...prompts]);
        await session.waitForIdle();
      } while (prompts.size > 0);
    },
    reset() { failure = undefined; clearTimeout(watchdog); watchdog = undefined; },
    async close() {
      clearTimeout(watchdog);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    },
  };
}

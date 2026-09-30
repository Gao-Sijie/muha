// Overlay only Session-run selections through public SettingsManager methods.
// Other native writes (including package installation) keep their native backend;
// reload reads fresh native files before reapplying the process-local selections.
export function sessionSettings(sdk, cwd, agentDir) {
  const settings = sdk.SettingsManager.create(cwd, agentDir);
  const overrides = { retry: { enabled: false } };
  const apply = () => settings.applyOverrides(overrides);
  settings.setDefaultModelAndProvider = (provider, model) => {
    overrides.defaultProvider = provider;
    overrides.defaultModel = model;
    apply();
  };
  settings.setDefaultThinkingLevel = level => {
    overrides.defaultThinkingLevel = level;
    apply();
  };
  settings.setRetryEnabled = () => apply();
  const reload = settings.reload.bind(settings);
  settings.reload = async () => { await reload(); apply(); };
  apply();
  return settings;
}

export function resolveModel(runtime, id) {
  const slash = id.indexOf("/");
  if (slash <= 0) throw new Error("Pi model must be provider/model");
  const model = runtime.getModel(id.slice(0, slash), id.slice(slash + 1));
  if (!model) throw new Error("Unknown Pi model");
  return model;
}

export function selection(session) {
  return { model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
    effort: session.thinkingLevel };
}

export function selectEffort(session, effort) {
  if (!session.model || !session.getAvailableThinkingLevels().includes(effort)) {
    throw new Error("Pi model does not support the requested effort");
  }
  session.setThinkingLevel(effort);
  if (session.thinkingLevel !== effort) throw new Error("Pi did not accept the requested effort");
  return selection(session);
}

# Leave Unresolved OpenCode Models Undefined

When OpenCode Session creation or resumption omits `model`, the Adapter exposes a native model already recorded on that Session when one exists and otherwise leaves `AgentSession.model` undefined. Muha does not query, copy, or freeze OpenCode's current global default merely to populate the property. The first accepted Turn may let OpenCode resolve its native default; once the accepted native user message identifies the chosen `{ providerID, modelID }`, the Adapter updates the handle to the corresponding Harness Model string for subsequent Turns.

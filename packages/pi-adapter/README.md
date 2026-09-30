# @muha-sdk/pi-adapter

Stage-four implementation is qualified on the fixed SDK/patch baseline below,
including controlled tests, independent installation, real Pi and Pi/Pi grilling.
See [the qualification record](../../docs/testing/sdk-qualification.md)
for exact versions, evidence, failures and limits without exporting private diagnostics. No npm publication is implied.

```ts
import { createMuhaRuntime } from "@muha-sdk/core";
import { piAdapter } from "@muha-sdk/pi-adapter";

const runtime = await createMuhaRuntime({ harnesses: [piAdapter()] });
try {
  const session = await runtime.createSession({
    harness: "pi",
    workspacePath: "/absolute/project",
    model: "provider/model",
    approvalPolicy: "autoApprove",
  });
  const turn = await session.startTurn([{ type: "text", text: "Explain this project." }]);
  for await (const event of turn) console.log(event);
  console.log(await turn.result);
} finally {
  await runtime.close();
}
```

## Native configuration and execution

Pi declares the exact official SDK version `@earendil-works/pi-coding-agent@0.84.2`
as a normal npm dependency; it does not bundle the SDK tree. It is not a PATH
CLI or a globally installed SDK. Installing this Adapter needs Registry access or
a prewarmed npm cache. Callers supply native Pi authentication and
model configuration. `OfficialAdapterOptions.env` can override or delete child
environment variables, including Pi's `PI_CODING_AGENT_DIR`; it never changes
the host environment or working directory. Node.js 22.20.0 or newer is required.

Each Session handle owns an SDK process. Initialization and native listing use
short-lived owned processes; only the consumer's main process owns the Muha
Runtime and Diagnostic Event Store. This is lifecycle isolation, not a sandbox.
Unexpected owned-process loss closes the whole Runtime; native history can
be explicitly resumed through a new Runtime. Closing handles does not delete it.

Session IDs, listing and parsing belong to native SessionManager. Listings
include external native sessions and can target deleted Workspaces. SDK default
skipping of damaged records and silent handling of directory/file read errors
are accepted, as explicitly approved on 2026-09-08. An empty listing is the SDK's
result, not proof that physical storage contains no sessions. Muha does not add
an integrity checker or file parser. Returned identities and Workspaces remain
validated; explicit SDK errors propagate, and missing references never become
new Sessions.

Model IDs use `provider/model`; effort values are native and model-dependent.
Create/resume and idle setters verify the SDK's effective selection. Run
selections do not change persistent defaults. Native history/authentication,
authorized tool/extension configuration writes and native reload remain intact.
Whole-execution SDK retry stays disabled so Core owns the Turn retry budget.
Retries are at-least-once: native history, tools and external side effects can
repeat. No exactly-once execution, transactional rollback or transparent
recovery of an interrupted Turn is promised.

Private diagnostic records distinguish SDK event callbacks, extension errors,
native listing results and model-fallback warnings by source. Only the host
writes the store; SDK runtime/auth objects, logs and Adapter IPC acknowledgements
are not native evidence. Retained semantic payloads can contain sensitive content
and remain subject to Core's unredacted storage and caller-managed retention.

## Capabilities and boundaries

The static Profile supports ordered text/images, native listing, Workspace
Skills, model/effort selection, streaming messages/reasoning, tools and usage.
The current qualification status is recorded in
`docs/testing/sdk-qualification.md` in the source repository.

- Explicitly select `autoApprove` or `harnessManaged`. Pi has no built-in approval
  gate; neither policy manufactures Approval events or bypasses native denials.
  `interactive`, `autoDeny` and omitted policy (which defaults to `interactive`)
  reject before execution.
- Submit the ordinary ordered Turn Input array. File/base64 images are converted
  inside this Adapter; consumers need no Pi-specific ordering metadata. A bounded
  high-level SDK patch preserves normal user-message persistence and lifecycle.
  Explicit native input transformations and Skill/template expansion retain their
  native replacement semantics. Image-only input is valid; PNG/JPEG/WebP/GIF are
  the supported Muha media types.
- Workspace Skills use the native `.pi/skills` target. Pi can install and load
  native extensions, including MCP extensions, independently of Muha.
  `workspaceMcp` and `turnQuestions` remain false; configuring Pi MCP through Muha
  fails and unsupported native UI is not answered on the caller's behalf.
- Unsupported extension interaction fails with cleanup; an extension that never
  settles after that error is bounded by process termination and Runtime closure.
  Arbitrary third-party extension compatibility and Session replacement from
  native extension commands are not promised.

## Building

`npm run build --workspace @muha-sdk/pi-adapter` builds the TypeScript host and
verified input patch from the repository's locked SDK installation. `npm pack`
only verifies the prepared patch and fails if worker sources or the patch are
missing/stale; it does not rewrite an SDK tree used by live processes. The
resulting tarball contains the patch manifest, private workers and Pi upstream
MIT license, but not the SDK dependency tree. npm installs the exact SDK version
as an ordinary dependency. No consumer install script is needed.

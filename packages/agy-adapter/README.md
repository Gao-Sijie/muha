# @muha-sdk/agy-adapter

The stage-five AGY CLI Adapter for Muha SDK. It uses the caller-installed and
authenticated `agy` command on `PATH`; it never installs AGY or falls back to an
SDK or API integration. The current first-version qualification uses Claude
Sonnet 4.6; see the [acceptance results](https://github.com/Gao-Sijie/muha/blob/main/QUALIFICATION.md).

```js
import { createMuhaRuntime } from "@muha-sdk/core";
import { agyAdapter } from "@muha-sdk/agy-adapter";

const runtime = await createMuhaRuntime({ harnesses: [agyAdapter()] });
try {
  const session = await runtime.createSession({
    harness: "agy",
    workspacePath: process.cwd(),
    model: "claude-sonnet-4-6",
    approvalPolicy: "autoApprove",
  });
  const turn = await session.startTurn([{ type: "text", text: "Describe this project." }]);
  for await (const event of turn) {
    if (event.type === "assistant.message.delta") process.stdout.write(event.delta);
  }
  console.log(await turn.result);
} finally {
  await runtime.close();
}
```

`harnessManaged` delegates to native permissions; `autoApprove` applies
`--dangerously-skip-permissions` on creation, resume, and controlled reopen
after interruption. Native permission rules and plugins remain unmanaged.
The Core default `interactive` policy is unsupported, so select a supported
policy explicitly. Muha does not roll back native configuration on close.

The Profile supports text Turns, known-reference resume, assistant message
streaming, tool events, current-Turn usage, and explicit Workspace Skills.
Model and effort can be selected at create/resume and expose only caller
selections (`selectedOnly`); idle setters, listing, image input, structured
approvals/questions, reasoning streaming, and Muha-managed Workspace MCP are
unsupported. The accepted Claude Sonnet 4.6 model rejects an explicit
`--effort`; omit effort for that model. Native identifiers are not Muha aliases.

AGY cannot disable its native print timeout using `0` or `-1s`. This Adapter
uses `--print-timeout 60m` and emits `MUHA_AGY_NATIVE_TURN_TIMEOUT` when activated.
This is the total wait for each Turn, not an idle timeout; intermediate output
does not restart the clock. A native timeout is a failed Turn, including when
AGY returns partial output with a
`SUCCESS` status. This limitation does not add a Core or other-Harness timer.

Each new Session receives an independent native Project bound to its
Workspace. Resume reads only the referenced native SQLite metadata and its
Project to verify identity and directory binding, failing explicitly on an
unknown or inconsistent format. Closing does not delete native history or
Projects. Workspace Skills remain shared physical files between Sessions
using the same directory.

Malformed or incomplete native results fail explicitly and stop their owned
execution; native `SUCCESS` alone does not establish a completed Turn.

The package includes its Linux x64 process supervisor and C source. It needs
the existing glibc 2.28 platform, with no consumer compiler, Python, systemd,
namespace, or install script. It owns and reaps only its CLI descendants;
unexpected AGY loss closes the Runtime. Complete descendant reclamation is
guaranteed while this supervisor remains alive; supervisor death is still a
fatal error but is outside that reclamation guarantee. The consuming Node
process retains its signal handlers and child-process ownership.

Maintainers build the helper with `npm run build:native` using a C compiler
and `readelf`. Its startup compatibility source binds the existing x86-64
glibc ABI; keep the actual glibc 2.28 qualification when changing startup or
adding C constructors. The helper links the platform libc dynamically.

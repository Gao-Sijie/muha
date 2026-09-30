# @muha-sdk/opencode-adapter

Official OpenCode Adapter for [Muha SDK](https://github.com/Gao-Sijie/muha). It requires an independently installed and authenticated OpenCode v2 `opencode` command on `PATH`; this package never installs or updates OpenCode. The current implementation is qualified against the `opencode v2.0.11` binary and declares the official `@opencode/client@2.0.11` as an ordinary, unbundled runtime dependency. Other v2 versions require their own qualification.

Use `openCodeAdapter(options)` with the existing `createMuhaRuntime` API.
Muha starts an owned private `opencode serve` on loopback. This Adapter exposes only native Session References; it does not offer OpenCode ACP, combined execution, or automatic route fallback. An internal plugin preserves mixed text/image order through model dispatch without writing to a user's OpenCode config. An existing `OPENCODE_CONFIG_DIR` is rejected because the private plugin cannot safely compose with it.

`interactive`, `autoApprove`, and `autoDeny` use v2 Session-scoped permission
rules; any residual permission request receives only a one-shot reply. A native
Form is a Question, not an Approval. String and multiselect Forms are mapped;
the typed Question contract also maps number, integer, boolean, external,
hidden-default, and conditional fields. Unknown future Form schema fails closed.
Workspace Skills use Core's controlled worker, while MCP entries are written
to the v2 project `opencode.jsonc`/`opencode.json` `mcp.servers` shape by this
Adapter's controlled worker. Controlled Form tests, an actual-binary local
fake-provider Form probe, and the fixed-model built-in single-select Question
path pass; other real-model Profile paths are not yet qualified. Preview
packaging is not an immutable release candidate.

Maintainers can run `npm run qualify:opencode-v2:preflight` from the repository
root without sending a model Prompt. The optional `--text`, `--image`, `--tool`,
and `--question` modes of `scripts/qualify-opencode-v2-native.mjs` call the fixed
real model and may consume subscription quota. `--question` allows only the
built-in Question Tool's one-shot permission; its single-select lifecycle
passed with the fixed model, without qualifying every Form variant or Profile path.

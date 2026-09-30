# @muha-sdk/kimi-adapter

Official Kimi Code Adapter for [Muha SDK](https://github.com/Gao-Sijie/muha). It requires an independently installed and authenticated `kimi` command on `PATH`; this package never installs or updates Kimi Code.

Use `kimiAdapter(options)` with the existing `createMuhaRuntime` API. Kimi MCP
project files are written by this Adapter's packaged worker under Core's
controlled Workspace process lifecycle.

In the V0.1.12 migration, `autoApprove` applies native `auto` to the Session
profile and each prompt. It does not use `yolo`: native auto can suppress
Questions and reject dangerous commands. `interactive` and `autoDeny` apply
`manual`, with native requests forwarded or denied respectively. Profile
application failure rejects create/resume before a prompt is sent. Native
Session modes may persist after close; direct native resume can inherit them.
The Question Capability remains declared, and any Question actually emitted
keeps its independent SDK lifecycle.

# @muha-sdk/codex-adapter

Official Codex Adapter for [Muha SDK](https://github.com/Gao-Sijie/muha). It requires an independently installed and authenticated `codex` command on `PATH`; this package never installs or updates Codex.

Use `codexAdapter(options)` with the existing `createMuhaRuntime` API. `options.env`
applies only to the Codex process, not to Workspace configuration workers.

In the V0.1.12 migration, `autoApprove` selects native `never` approval with
`danger-full-access` sandbox. `interactive` and `autoDeny` retain `on-request`
and `workspace-write`. The Adapter checks the native response before exposing
a usable Session; rejected or unapplied settings fail. Native mode persistence
is not rolled back on close. This is a permission and event behavior change
despite the unchanged API. Remaining requests use one-shot policy approval;
independent Questions are not answered automatically.

When creating or resuming a Session, the native Adapter asks Codex for that
thread's effective `default_mode_request_user_input` feature value. If it is
disabled, Node emits `MUHA_CODEX_QUESTION_FEATURE_DISABLED`; if Codex cannot
report the value, Node emits `MUHA_CODEX_QUESTION_FEATURE_UNKNOWN`. These
warnings do not reject the Session or change Codex configuration. Codex applies
trusted project `.codex/config.toml` over user-level config, so a project can
enable or disable the feature independently of the global setting. Muha keeps
its native App Server connection stable-only (`capabilities: null`).

The Adapter launches App Server with a private zero thread-unload grace period
and unsubscribes after the last live handle closes. This lets the next resume
load its selected policy: resuming an already loaded native thread can ignore
overrides. The returned policy/sandbox is still checked, so unsupported or
unapplied mappings fail instead of silently retaining YOLO. This does not
archive, delete, or rewrite the native conversation.

# Muha

[English](https://github.com/Gao-Sijie/muha/blob/main/README.md) | [简体中文](https://github.com/Gao-Sijie/muha/blob/main/README.zh-CN.md)

通过同一套 TypeScript API 使用 Codex、OpenCode、Kimi Code、Pi 和 AGY。

将编码 Agent 接入你的脚本和应用：创建会话、接收流式回复与工具事件、
中断任务、恢复原生会话。每个 Agent 保留自己的模型、工具、权限与历史记录。

## 安装

```sh
npm install muha
```

需要 **Node.js 22.20.0 或更新版本**，运行环境为 **Linux x64、glibc 2.28
或更新版本**，包含满足这些条件的 WSL2。Muha 自有原生辅助程序已预编译，
你无需克隆或编译本仓库。

这条命令安装 Core 和五个适配器，你只需启用实际使用的 Agent。
Codex、OpenCode、Kimi Code 和 AGY 的原生工具需要分别安装、登录，并可通过
`PATH` 找到。Pi SDK 随 npm 依赖安装，使用前仍需配置原生认证和模型。

## 快速开始

安装并登录 Codex 后，将以下代码保存为 `example.mjs`：

```js
import { createMuhaRuntime, codexAdapter } from "muha";

const runtime = await createMuhaRuntime({ harnesses: [codexAdapter()] });
try {
  const session = await runtime.createSession({
    harness: "codex",
    workspacePath: process.cwd(),
    approvalPolicy: "autoDeny",
  });
  const turn = await session.startTurn([
    { type: "text", text: "Explain the structure of this project." },
  ]);
  for await (const event of turn) {
    if (event.type === "assistant.message.delta") process.stdout.write(event.delta);
    if (event.type === "question.requested") {
      await turn.respondToQuestion(event.requestId, { action: "dismiss" });
    }
  }
  const result = await turn.result;
  if (result.status !== "completed") {
    console.error(result);
    process.exitCode = 1;
  }
} finally {
  await runtime.close();
}
```

```sh
node example.mjs
```

示例会拒绝需要审批的工具操作，并忽略 Agent 的追问。实际使用时可选择
支持的审批策略，并处理追问；不同 Agent 的权限行为有所区别。

## 选择 Agent

| Agent | 适配器 | 准备工作 |
| --- | --- | --- |
| [Codex](https://github.com/Gao-Sijie/muha/blob/main/packages/codex-adapter/README.md) | `codexAdapter()` | 安装并登录 `codex` |
| [OpenCode](https://github.com/Gao-Sijie/muha/blob/main/packages/opencode-adapter/README.md) | `openCodeAdapter()` | 安装并登录 `opencode` v2 |
| [Kimi Code](https://github.com/Gao-Sijie/muha/blob/main/packages/kimi-adapter/README.md) | `kimiAdapter()` | 安装并登录 `kimi` |
| [Pi](https://github.com/Gao-Sijie/muha/blob/main/packages/pi-adapter/README.md) | `piAdapter()` | SDK 已随 Muha 安装；配置原生认证和模型 |
| [AGY](https://github.com/Gao-Sijie/muha/blob/main/packages/agy-adapter/README.md) | `agyAdapter()` | 安装并登录 `agy` |

通过 `createMuhaRuntime({ harnesses: [...] })` 传入所需适配器，Runtime 只
启动已配置的 Agent。Pi 和 AGY 需要显式选择支持的策略，例如
`harnessManaged`；它们不支持默认的 `interactive` 策略。

## 更多用法

- 保存 `session.reference`，恢复同一个原生会话。
- 使用 `runtime.getHarnessCapabilities(...)` 查询可选能力。
- 使用 `turn.interrupt()` 中断正在执行的任务。
- 为支持相应能力的 Agent 配置项目 Skills 和 MCP。

详细用法见 [API 指南](https://github.com/Gao-Sijie/muha/blob/main/packages/core/README.md)，验证过的原生版本与限制
见 [QUALIFICATION.md](https://github.com/Gao-Sijie/muha/blob/main/QUALIFICATION.md)。统一 API 保留各 Agent 的原生行为，
不同 Agent 的回答与模型标识仍有差别。

## 按需安装

只使用少数 Agent 时，也可以安装所需模块：

```sh
npm install @muha-sdk/core @muha-sdk/pi-adapter
```

随后从对应包导入 API，并保持使用同一个 Muha 发布版本。

## 使用问题

已启用的 Agent 无法启动时，先确认其原生命令可通过 `PATH` 找到，并且
认证已配置。上表的适配器说明提供各自的准备要求。包管理器阻止依赖
安装脚本时，请查看它列出的依赖与脚本策略，保留依赖正常安装行为；
使用 Muha 无需编译本仓库。

## 参与贡献

开发和测试步骤见 [CONTRIBUTING.md](https://github.com/Gao-Sijie/muha/blob/main/CONTRIBUTING.md)。问题反馈请使用
[GitHub Issues](https://github.com/Gao-Sijie/muha/issues)，安全问题请参考
[SECURITY.md](https://github.com/Gao-Sijie/muha/blob/main/SECURITY.md)。许可证为 [MIT](https://github.com/Gao-Sijie/muha/blob/main/LICENSE)。

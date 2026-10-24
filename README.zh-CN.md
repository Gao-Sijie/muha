# Muha

[English](README.md) | [简体中文](README.zh-CN.md)

通过同一套 TypeScript API 使用 Codex、OpenCode、Kimi Code、Pi 和 AGY。

Muha 是轻量 TypeScript SDK，将已有编码 Agent 接入脚本和应用。
你选择 Harness 与模型，用代码串联任务；Muha 统一执行控制，保留原生能力。
Harness 是包含模型、工具、权限与会话历史的 Agent 运行环境，不只是模型 API。

## 为什么需要 Muha

- **按需分配成本** 常规任务使用高性价比的模型，复杂任务使用更强配置，
  在同一工作流中组合现有订阅与 Provider 资源。
- **自动化 Agent 协作** 用代码串联调研、写作与审查，传递资料、处理结果，
  减少手工终端操作。
- **减少接入胶水** 通过同一 API 管理不同 Harness 的启动、会话、事件与
  交互，不必为每个应用重复接入。

## Muha 如何工作

- **轻量化 TypeScript API** 在普通 Node.js 脚本或应用中管理 Session 与 Turn，
  处理流式输出、交互、中断和可选重试，无需新的工作流 DSL。
- **保留原生能力** 复用 Harness 的模型、工具、认证、权限、历史及受支持的
  Skills/MCP。费用沿用原生订阅或 Provider 计费，不自动选择最低价模型。
- **无需额外部署** 不要求部署 Muha 服务、容器平台或额外沙箱层。适配器可
  管理本地辅助进程或原生服务；Muha 不是安全隔离边界。

## 可以用它做什么

- **灵活组织工作流** 持续上下文复用 Session，独立任务创建新 Session。
  一个 Session 同时只能有一个活动 Turn；并行任务使用不同 Session。
- **对比 Harness 与模型** 将同一任务交给不同 Harness 与模型，统一收集
  结果，用于评测、提示词实验或交叉检查；评分与成本估算由应用实现。
- **由 Agent 编排 Agent** 把 Muha 封装为工具或脚本，让一个 orchestrator
  Harness 调用其他 Harness、汇总结果；任务路由、规划与调度由调用方实现。
- **集成应用与脚本** 构建 Chat、调研写作、代码审查或批量文件处理工具，
  复用相同的执行接口。

**使用边界** Muha 不内置工作流调度器或 Orchestrator。Session 固定绑定
Harness 与 workspace，切换 Harness 需要创建新的 Session，不会自动迁移会话历史。
可选功能通过能力声明查询；统一接口不表示各家拥有相同的能力或输出。

## 安装

```sh
npm install @muha-sdk/muha
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
import { createMuhaRuntime, codexAdapter } from "@muha-sdk/muha";

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

## 示例

在[示例索引](examples/README.zh-CN.md)中查看可运行场景；每个示例拥有独立
的源码目录与运行说明，便于后续持续扩充。

两个示例都要求完整安装 `@muha-sdk/muha`，但不要求安装全部原生 CLI。
仅提供本地已安装的 Harness 选项；Pi SDK 随 Muha 安装，其他 Harness
需要对应原生命令在 `PATH` 上可执行。

| 项目 | 概述 | 位置 |
| --- | --- | --- |
| [多 Harness 集成 Chat](examples/local-chat/README.zh-CN.md) | 单个 TS 文件包含服务端和聊天界面，支持五种适配器、原生 model/effort、内联 Turn 事件、审批、追问和停止。选项仅在点击“新对话”后生效，不迁移上下文。 | [examples/local-chat/](examples/local-chat/) |
| [AI 热点选题与写作](examples/auto-social-media/README.zh-CN.md) | 纯命令行交互：使用 `content-strategy` 选题、`khazix-writer` 写文；引导配置两阶段的 harness/model/effort，终端仅流式展示模型回复，保留工作目录。需明确确认真实模型调用，不自动发布。 | [examples/auto-social-media/](examples/auto-social-media/) |

Examples 属于 GitHub 项目内容，不随 npm 包安装；新增示例不需要重新发布
SDK。新增场景的约定见[贡献说明](CONTRIBUTING.md#examples)。

## 选择 Agent

| Agent | 适配器 | 准备工作 |
| --- | --- | --- |
| [Codex](packages/codex-adapter/README.md) | `codexAdapter()` | 安装并登录 `codex` |
| [OpenCode](packages/opencode-adapter/README.md) | `openCodeAdapter()` | 安装并登录 `opencode` v2 |
| [Kimi Code](packages/kimi-adapter/README.md) | `kimiAdapter()` | 安装并登录 `kimi` |
| [Pi](packages/pi-adapter/README.md) | `piAdapter()` | SDK 已随 Muha 安装；配置原生认证和模型 |
| [AGY](packages/agy-adapter/README.md) | `agyAdapter()` | 安装并登录 `agy` |

通过 `createMuhaRuntime({ harnesses: [...] })` 传入所需适配器，Runtime 只
启动已配置的 Agent。Pi 和 AGY 需要显式选择支持的策略，例如
`harnessManaged`；它们不支持默认的 `interactive` 策略。

## 继续使用 API

- 保存 `session.reference`，恢复同一个原生会话。
- 使用 `runtime.getHarnessCapabilities(...)` 查询可选能力。
- 使用 `turn.interrupt()` 中断正在执行的任务。
- 为支持相应能力的 Agent 配置项目 Skills 和 MCP。

详细用法见 [API 指南](packages/core/README.md)，验证过的原生版本与限制
见 [QUALIFICATION.md](QUALIFICATION.md)。统一 API 保留各 Agent 的原生行为，
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

开发和测试步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。问题反馈请使用
[GitHub Issues](https://github.com/Gao-Sijie/muha/issues)，安全问题请参考
[SECURITY.md](SECURITY.md)。许可证为 [MIT](LICENSE)。

## 查询可用模型

```js
const models = await runtime.listModels({ harness: "codex", workspacePath: process.cwd() });
// 对已启用的 opencode、kimi、pi、agy 使用相同调用，只替换 harness。
console.log(models.map(model => ({ id: model.id, name: model.name })));
```

此接口查询 Harness 原生配置所报告的可选聊天模型。Workspace 必须存在；
查询不创建聊天会话、不调用模型推理、不修改默认模型。返回值是深度冻结、
可 JSON 序列化的数组，原生 `id` 可原样传给对应 Harness 的模型选择接口。
仅在原生目录提供时返回 `name`、`description`、`supportedEfforts` 和
`defaultEffort`；effort 保留原生含义。成功查询到空目录返回 `[]`，查询和格式
错误会明确拒绝。目录受原生配置、认证和缓存影响，不保证凭据、额度或下一次
模型调用成功。静态能力声明为 `runtime.getHarnessCapabilities(harness).model.listing`。

Codex、OpenCode、Kimi 和 Pi 可以在两次 Turn 之间调用
`await session.setModel(id)`，保留同一会话历史。切换会清除旧的显式 effort，
原生 Harness 仍可采用其默认值。AGY 目前仅支持在创建和恢复会话时选择模型。

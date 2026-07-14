# PI Desktop 与 yiTrace 结合方案审查

日期：2026-07-14

实施状态：第一阶段已完成。实现范围和回归结果见
`docs/reports/2026-07-14_yitrace-integration-implementation.md`。

## 结论

PI Desktop 很适合与 yiTrace 做第一等集成。

两者的关系应该是：

- PI Desktop 提供通用 Agent 桌面运行时、会话、模型、Skills、MCP、工具和 Electron 壳。
- yiTrace 提供 Agent 运行过程的记录、搜索、回放、对比和数据清理。

这不是把 PI Desktop 变成 yiTrace 产品，也不是把特定业务功能放进通用底座。正确做法是在 PI Desktop 中增加一个通用“运行观测层”，yiTrace 是内置实现。第一阶段不增加用户开关。

完成基础接入后，基于 PI Desktop 开发的应用可以直接获得：

- Agent、LLM、工具和 MCP 调用的完整运行记录。
- 输入、输出、状态、耗时、token 和费用统计。
- 会话内 Trace 瀑布和单步下钻。
- 按文本、工具、模型、状态和时间搜索历史运行。
- 两次运行对比。
- 本地故障排查和可导出的诊断证据。

## 当前项目已经具备的基础

PI Desktop 不是从零开始。当前已经存在下面这些通用骨架：

### 1. 稳定的运行 ID 和会话 ID

`server/src/app/chat/agent_chat.js` 每轮对话都会创建 `runId`，并写入 SQLite 的 `agent_runs`。这个 ID 可以直接作为 yiTrace 的 external trace ID，不需要再建立一套运行编号。

### 2. 统一的流事件

Agent 对话已经产生：

- `run.started`
- `run.completed`
- `run.failed`
- `run.cancelled`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `tool.output`
- message 和 usage 事件

这些事件足以生成基础 trace。

### 3. Trace 上下文骨架

`server/src/engine/trace/trace_context.js` 已经提供：

- `runWithTraceContext`
- `traceAgentCall`
- `traceToolCall`
- `recordTraceLlmCall`
- `withAgentToolLifecycle`

它还使用 `AsyncLocalStorage` 维护父子 span，避免并行工具和子 Agent 串错层级。

但是当前没有创建任何 recorder，也没有调用 `runWithTraceContext`。所以这些代码只是未接通的骨架。

### 4. LLM 和工具数据已经能拿到

`WorkspaceAgent` 已经能取得：

- 模型 ID。
- token usage。
- 工具名称、参数和结果。
- 工具错误状态。
- thinking 和回答内容。

这些数据可以直接送入统一 recorder。

### 5. 前端已有未接通的 Trace 类型

`renderer/src/api/agent.ts` 已经定义 `AgentTraceRun`、`AgentTraceDetail`、`AgentTraceSpan` 和 `getAgentSessionTraces()`。

但后端没有 `/api/agent/projects/:pid/sessions/:sid/traces` 路由，当前工作台也没有 Trace 面板。因此这个请求现在不可用。

### 6. 打包结构适合原生模块

Server 被放在 `app.asar` 外，`after-pack.cjs` 会复制生产依赖。当前已经用同样方式处理 `better-sqlite3`，可以继续把 `@yitrace/db` 和当前平台的原生 `.node` 文件带入安装包。

## 当前缺口

| 层级 | 当前状态 | 缺口 |
|---|---|---|
| 依赖 | 没有 `@yitrace/db` | 增加固定版本和平台包验证 |
| Recorder | 只有 recorder 接口调用点 | 增加通用 recorder 和 yiTrace 实现 |
| 生命周期 | 后端没有打开或关闭 yiTrace | 增加独立 worker、启动预热和退出关闭 |
| Agent 接入 | `runWithTraceContext` 未使用 | 每轮对话创建 recorder 并包住 Agent 执行 |
| 工具接入 | 工具没有统一包装 | 本地工具和 MCP 工具统一经过生命周期包装 |
| LLM 接入 | pi runtime 只把 usage 发给 UI | 把完整 LLM 调用送入 recorder |
| 查询接口 | 前端已有请求，后端没有路由 | 增加列表、详情和搜索接口 |
| 工作台 | 只有计划、工具、Skills 和产物 | 增加 Trace 瀑布和步骤详情 |
| 配置 | 没有观测配置 | 增加文本上限、保留时间和数据目录 |
| 隐私 | 工具输入输出可能含密钥和文件内容 | 记录前统一脱敏和截断 |
| 数据清理 | 当前没有 Trace 保留策略 | 第一阶段不和会话删除联动，后续统一使用 yiTrace retention |
| 打包 | 只检查 better-sqlite3 | 只增加 yiTrace 原生文件的最小加载 smoke |

## 推荐架构

```text
agent_chat
  -> createRunRecorder(runId, sessionId, projectId)
  -> runWithTraceContext(recorder)
      -> pi Agent
          -> LLM span
          -> local tool span
          -> MCP tool span
          -> child agent span
  -> recorder.finish(status)
  -> yiTrace worker ingest + flush

Renderer
  -> IPC registry
  -> trace use case
  -> yiTrace worker query
  -> session runs / waterfall / span detail / search / diff
```

### Provider 边界

PI Desktop 的 Agent 和业务代码不应该直接导入 `@yitrace/db`。

建议增加：

```text
server/src/engine/observability/
├── recorder.js              # 通用接口和 no-op 实现
├── redaction.js             # 脱敏、截断
└── context.js               # 复用现有 AsyncLocalStorage

server/src/app/observability/
├── trace_service.js         # 列表、详情和搜索用例
└── providers/
    └── yitrace/
        ├── provider.js       # 事件到 yiTrace 的转换
        └── worker.js         # 独立持有 YiTraceDB
```

这样以后可以：

- 替换为其他 provider。
- 在测试中使用内存 recorder。
- 避免 yiTrace 代码扩散到 Agent、MCP 和页面逻辑。

## 为什么要使用独立 worker

yiTrace 是原生本地数据库。打开大数据目录或做恢复时，原生调用可能占用 Node 事件循环。

PI Desktop 的后端还要处理会话、模型、审批和 Electron IPC，因此不应让 yiTrace 恢复阻塞主后端。推荐由一个独立子进程长期持有数据库：

- 后端启动后异步预热一次。
- 整个 worker 生命周期只打开一次数据库。
- 写入、搜索和详情读取都通过进程 IPC。
- worker 写入或查询失败时，不影响聊天主流程。
- 后端退出时通知 worker flush 和 close。
- worker 异常退出后，下一次请求自动重建。

## 数据职责

不要让 SQLite 和 yiTrace 变成两份会话历史。

### SQLite 继续负责

- 项目和会话。
- 用户与助手消息。
- Agent 上下文投影。
- Agent run 状态。
- 待处理审批。
- 模型、Skills、MCP 和应用设置。

### yiTrace 只负责

- 一轮 Agent run 的 span 和 log event。
- Agent、LLM、工具和 MCP 的父子关系。
- 输入输出、状态、耗时、token、费用和自定义 attrs。
- Trace 搜索、聚合、对比和保留策略。

`agent_runs.id` 与 yiTrace external trace ID 使用同一个值。SQLite 提供运行列表，yiTrace 提供详细运行证据。

即使 yiTrace 写入失败，会话和消息也不能丢失，Agent 对话仍然必须成功。这里不需要复杂的降级状态机，只需要隔离异常并记录错误。

## 配置建议

在 `app.config.json` 增加默认观测配置：

```json
{
  "observability": {
    "provider": "yitrace",
    "localOnly": true,
    "retentionDays": 30,
    "maxTextChars": 16000,
    "captureInputs": true,
    "captureOutputs": true
  }
}
```

同时在设置页允许用户：

- 查看本地数据目录和占用空间。
- 选择是否记录完整输入输出。
- 清理指定时间以前的数据。
- 导出诊断包。

默认只写本机，不上传网络。

## 隐私和安全

Trace 比普通日志更容易包含敏感内容，不能直接把所有工具参数和结果原样写入。

第一版必须具备：

- 屏蔽 `api_key`、`token`、`authorization`、`cookie`、`password`、`secret` 等字段。
- 不记录系统凭据存储返回的明文。
- 每个输入、输出和日志设置长度上限。
- 二进制内容只记录类型、大小和摘要。
- 用户关闭输入输出记录后，只保留名称、状态、耗时和 token。
- 导出诊断包前再次脱敏，并明确展示包含内容。

## UI 建议

### 会话工作台

在现有“计划、工具、Skills、产物”旁增加“Trace”：

- 当前运行状态。
- Agent、LLM、工具和 MCP 瀑布。
- 每步输入、输出、耗时、token 和错误。
- 点击工具可查看它内部的 LLM 或子工具。

### 观测页面

增加一个通用开发者页面：

- 按项目、会话、状态、工具、模型和时间筛选。
- BM25 搜索运行内容。
- 可选语义和混合搜索。
- 两次运行对比。
- 存储占用和 retention dry-run。

这个页面属于底座能力，不加入任何特定行业的 Review、Benchmark 等业务概念。

## 分阶段实施

### 第一阶段：可用的基础 Trace

1. 增加 `@yitrace/db` 固定版本。
2. 增加 provider 接口、no-op recorder、脱敏和截断。
3. 增加 yiTrace worker 和进程级生命周期。
4. 在 `agent_chat` 创建 recorder，并使用 `runWithTraceContext`。
5. 统一包装本地工具和 MCP 工具。
6. 增加 Trace 列表、详情路由。
7. 在工作台增加瀑布和步骤详情。
8. 隔离 yiTrace 异常，并增加安装包原生模块最小 smoke。

完成后，PI Desktop 的下游项目不需要自己写 Trace 基础设施。

### 第二阶段：搜索和诊断

1. 接入 BM25 搜索和 attrs 过滤。
2. 增加运行聚合和存储统计。
3. 增加运行对比。
4. 接入项目 EMBEDDING 模型，提供可选语义/混合搜索。
5. 增加诊断包导出。

### 第三阶段：Agent 工程闭环

1. 增加 annotation 和 dataset association 的通用接口。
2. 允许用户把失败运行加入 eval 数据集。
3. 提供可选的历史运行搜索工具，让 Agent 查询过去成功或失败的处理过程。
4. 增加 retention 计划、执行和审计。

第三阶段必须保持可选，不能让通用 Agent 默认读取所有历史内容。

## 第一阶段验收标准

- 接入后，一轮真实对话能写出 root、LLM、工具和 MCP span。
- 并行工具的父子关系不串。
- 成功、失败、取消和审批超时都有正确状态。
- yiTrace 写入失败时，聊天仍能完成；不实现复杂降级状态机。
- 后端退出后数据库可以重新打开，trace 能读回。
- Trace 页面不会因为数据库恢复一直卡住。
- 密钥和 Authorization 等内容不会出现在 trace 中。
- 当前平台的安装包 smoke 能加载 yiTrace 原生包；第一阶段不扩展完整打包验证矩阵。
- 自动测试覆盖真实临时数据库、worker 关闭恢复、异常隔离和最小打包 smoke。

## 最终判断

PI Desktop 与 yiTrace 的结合属于基础能力：PI Desktop 可以让所有基于 pi 的桌面 Agent 默认拥有可观测能力。

当前代码已经保留了大部分调用骨架，但链路没有接通。最合适的下一步是完成第一阶段，把 yiTrace 做成 PI Desktop 的内置观测 provider。第一阶段不做关闭开关、会话删除联动和完整打包验证，只保留异常隔离与当前平台最小 smoke。

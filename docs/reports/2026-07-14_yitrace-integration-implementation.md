# yiTrace 第一阶段接入报告

日期：2026-07-14

## 结论

PI Desktop 已把 yiTrace 接入通用 Agent 主链路，可以作为本地 Agent Trace 的基础案例。

现在每轮对话都会自动记录：

- Agent run。
- LLM 输入、输出、模型、耗时和 token。
- 本地工具和 MCP 工具的输入、输出、状态和耗时。
- 成功、失败和取消状态。
- Agent、LLM、工具之间的父子关系。

Trace 保存在本机 yiTrace 数据目录中。SQLite 仍是项目、会话、消息和运行状态的唯一数据源，yiTrace 不保存另一份会话历史。

## 已完成

### 后端

- 固定使用 `@yitrace/db@0.1.3`。
- 增加通用 recorder 和 no-op recorder。
- 增加输入输出脱敏、长度限制和二进制摘要。
- 使用独立 worker 打开、写入、查询和关闭 YiTraceDB。
- 后端启动时异步预热，退出时 flush 和 close。
- worker 退出后，下一次调用会重新创建。
- `agent_runs.id` 直接作为 yiTrace external trace ID。
- `agent_chat` 使用 AsyncLocalStorage 传递 trace 上下文。
- 本地工具和 MCP 工具统一经过 trace 包装。
- pi Agent 每个 turn 记录 LLM span 和 usage。
- 增加会话 Trace 查询路由：
  `GET /api/agent/projects/:pid/sessions/:sid/traces`。

### 前端

Agent 工作台增加 Trace 区域，显示最近一次运行的：

- span 类型、名称、状态和耗时。
- 父子层级。
- 模型和输入/输出 token。
- 单步输入和输出详情。

### 安全

写入 yiTrace 前会遮盖常见敏感字段，包括：

- `api_key`
- `authorization`
- `cookie`
- `password`
- `secret`
- access、refresh 和 session token

默认每段文本最多保存 16000 个字符。二进制内容只保存大小，不保存原始数据。

### 打包

- staging 和最终安装目录都会检查 `@yitrace/db`。
- 最终安装目录必须存在当前平台的 yiTrace `.node` 文件。
- 安装目录 smoke 会真实完成 Agent 对话、读取 Trace、重启后端并再次读取 Trace。

## 异常边界

yiTrace 写入或查询失败不会改变会话和 Agent run 的结果。失败只写入后端日志，不增加复杂的降级状态机。

worker 不继承父进程的 `-e`、`--input-type` 等启动参数，避免嵌入式启动时重复执行父脚本。

## 已验证

| 检查 | 结果 |
|---|---|
| yiTrace 真实临时数据库写入和读取 | 通过 |
| Agent、LLM、工具 span | 通过 |
| token 统计 | 通过 |
| 敏感信息遮盖 | 通过 |
| yiTrace 存储失败不影响 Agent | 通过 |
| Server 全量测试 | 39/39 通过 |
| Renderer typecheck 和 lint | 通过 |
| Node 静态检查 | 通过 |
| Electron 测试 | 10/10 通过 |
| Renderer 生产构建 | 通过 |
| macOS arm64 目录包 | 通过 |
| macOS arm64 安装目录 smoke | 通过 |

Server 全量测试使用项目要求的 Node 22.19.0。系统默认 Node 26 与当前 `better-sqlite3` ABI 不匹配，不能用于这组测试。

## 本阶段没有做

- 用户关闭 Trace 的开关。
- 会话删除时联动删除 Trace。
- retention 自动清理。
- 全局 Trace 搜索页面。
- BM25、语义和混合搜索界面。
- 两次运行对比。
- annotation、数据集关联和 eval 闭环。
- 三平台安装包矩阵、签名、公证和 Release。

这些属于后续阶段，不应描述为当前已经具备的能力。

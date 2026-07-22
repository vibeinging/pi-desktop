# YiW 动态 UI 模块规格

日期：2026-07-20

状态：MVP 已实现

关联设计：[动态 UI 模块运行方案](../design/2026-07-20_dynamic-ui-module-runtime.md)

## 第一版范围

第一版交付一个可运行、可测试的页面描述模块系统：

- 本地 SQLite 保存模块、不可变版本、草稿、权限、Provider 绑定、状态和审计记录。
- Renderer 从模块接口读取动态侧边栏入口。
- `ModuleHost` 使用允许的内置组件渲染 JSON 页面描述。
- 模块支持创建草稿、检查、预览、安装、停用、启用和退回。
- 模块动作统一经过后端权限检查；支持模块状态读写和 MCP Provider 调用。
- Provider 读取动作只允许调用明确标记为只读且非破坏性的 MCP 工具。
- WorkspaceAgent 可以通过受控产品工具创建、检查、预览和安装模块。
- 安装、停用和退回后，当前对话通过工作区事件刷新模块 UI。

第一版不包含：

- 任意 React/JavaScript 代码模块。
- 在线模块市场和跨设备同步。
- 券商交易、下单、转账等高风险能力。
- 核心 App 安装包的自动更新发布链路。

## 页面描述组件

第一版允许：

```text
Stack
Grid
Tabs
Toolbar
Heading
Text
Button
SearchInput
MetricCard
DataTable
LineChart
CandlestickChart
MarketOverview
EmptyState
```

未知组件、过深页面树、过多节点、未知动作和未声明权限必须被后端拒绝。

## 模块状态

```text
草稿：editing → ready → installing → installed
模块：active | disabled | error | incompatible
版本：installed | blocked
```

安装新版本时不修改旧版本。退回只切换 `current_version_id`。

退回、启用、停用和删除必须在同一个数据库事务内同时更新模块状态、侧边栏总修订号和审计事件。退回时按目标版本恢复权限，动作授权必须与当前 `version_id` 一致。

## 安全边界

- 安装必须提交同一次预览返回的 `expected_revision`、`validation_hash` 和 `preview_token`。
- 更新已有模块时只确认新增权限；如果当前模块版本已经变化，旧草稿必须重新基于最新版本生成。
- Renderer 执行动作必须提交固定 `request_id` 和正在显示的 `version_id`；版本变化时拒绝执行旧页面动作。
- MCP 工具未明确标记为只读时默认拒绝；用户可以在 Provider 绑定里逐项确认未标记工具，明确标记为破坏性的工具始终拒绝。
- 动作结果先隐藏常见凭证字段并限制大小，再同时写入审计记录和返回 Renderer，保证幂等重放结果一致。
- `minAppVersion` 在检查、安装、启用和退回时生效；不兼容模块不进入动态侧边栏。

## 任务

- [x] 数据库迁移和事务入口
- [x] 模块检查、存储和动作网关
- [x] 模块 transport 路由和 Renderer API
- [x] Agent 产品工具和模块工作区事件
- [x] 动态侧边栏和 ModuleHost
- [x] JSON 页面渲染和基础组件
- [x] 后端单元测试
- [x] Renderer 测试、类型检查和生产构建
- [ ] Electron 中通过真实模型对话生成一个模块并完成整条人工验收

## 已实现位置

- 数据库迁移和同步事务：`server/src/db.js`
- 模块检查：`server/src/engine/modules/module_validator.js`
- 模块注册、版本、权限和动作：`server/src/engine/modules/module_registry.js`
- HTTP/IPC 共用接口：`server/src/app/modules/index.js`、`server/src/transport/registry.ui_modules.js`
- Agent 工具：`server/src/engine/agents/product_tool_catalog.js`、`server/src/engine/agents/product_tools.js`
- 动态模块事件：`server/src/engine/agents/workspace_agent.js`
- Renderer API 和页面运行器：`renderer/src/api/uiModules.ts`、`renderer/src/modules/ModuleHost.tsx`
- 固定组件渲染器：`renderer/src/modules/SchemaRenderer.tsx`
- 动态侧边栏：`renderer/src/views/agent/YiWNav.tsx`、`renderer/src/views/agent/YiWShell.tsx`

侧边栏在模块事件到达后立即刷新，同时在窗口重新获得焦点、从后台恢复和前台每 15 秒检查一次。当前模块版本变化时，`ModuleHost` 会重新读取不可变版本，不需要重启 App。

## 当前验证证据

- 后端模块测试：11 项通过。覆盖未知组件拒绝、脚本字段拒绝、权限声明、预览令牌、安装、动作版本与幂等、输出限制、跨版本权限恢复、App 版本兼容、MCP 只读工具判断和异常分页保护。
- Renderer 完整测试：40 项通过；动态模块测试覆盖模块绑定读取、初始预览数据和嵌套结果写入。
- Renderer TypeScript：通过。
- Renderer 生产构建：通过；构建仍会报告仓库已有的中英文文案重复键警告，与本功能无关。
- 真实 HTTP 路由：已用临时 SQLite 完成 `builtin-login → 创建草稿 → 检查 → 获取预览令牌 → 按同一哈希安装 → 列表出现股票模块`，安装版本为 1.0.0，列表总修订号从 0 变为 1；临时数据库及 WAL/SHM 文件已删除。

## 验收

必须证明：

1. 创建并安装一个模块后，不重启 App，侧边栏出现入口。
2. 点击入口可以显示页面描述生成的界面。
3. 未知组件和未授权动作不能运行。
4. 模块停用后从侧边栏消失。
5. 新版本安装后可以退回旧版本。
6. 模块页面失败不会影响对话和设置。
7. Agent 安装模块前会经过现有治理确认。

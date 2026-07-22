# QueryAgent 当前工具与执行逻辑

## 工具注册

QueryAgent 每次启动前调用 `probeCapabilities`，根据当前项目的数据源和配置动态注册工具。

| 条件 | 模型可见工具 | 用途 |
|---|---|---|
| 始终存在 | `update_plan` | 多步任务公布和更新计划 |
| 始终存在 | `format_result` | 把已有中间结果展示成图表或大表，不负责取数 |
| 始终存在 | `ask_user` | 无法自行消歧时暂停任务并等待用户选择 |
| 有数据库、表格或文档 | `read/grep/ls/find/write/edit/bash` | 搜索和读取项目文件，编写代码并执行数据处理 |
| 有数据库或表格数据 | `execute_sql` | 按 `source_id` 执行只读 SQL，结果自动写入中间库 |
| 有网络搜索配置 | `web_search_operator` | 搜索网络内容 |

## 主循环

```text
用户问题
  → 加载主模型和项目提示词
  → 建立会话级中间 DuckDB
  → 检查项目能力并注册工具
  → pi-agent 原生函数调用循环（工具串行执行）
      → 需要计划：update_plan
      → 读取本轮内存数据源/文档清单
      → 搜索和读取：read / grep / ls / find
      → 编写和执行：write / edit / bash
      → 结构化数据：execute_sql(source_id, sql, question)
      → 网络：web_search_operator
      → 多源结果：写入中间表，再用 execute_sql(source_id=session_intermediate) 关联或聚合
      → 需要展示：format_result
      → 有歧义：ask_user 暂停
  → 模型停止调用工具并输出可见文本
  → QueryAgent 按自然结束返回最终答案
```

## 结果处理

- `execute_sql` 和网络搜索属于数据工具，结果统一落到会话级中间 DuckDB。
- 结果不超过 30 行时，完整数据返回给模型；超过 30 行时只返回字段和少量样例，后续计算必须继续查询中间表。
- 代码工作区工具可以读取和修改项目文件、执行命令；写入与执行沿用 WorkspaceAgent 审批。
- 所有工具串行执行，避免多个工具同时写中间表造成顺序不确定。
- `format_result` 不结束任务。模型仍需继续输出文字结论。
- `ask_user` 是特殊暂停工具，返回 `terminate=true`，等用户选择后从会话继续。
- 普通完成不需要完成工具。模型最终返回可见文本后，pi-agent 原生循环结束。

## 当前问题

1. `web_search_operator` 仍带有 `operator`，与新的工具命名不一致。
2. MCP 数据源会让 `has_any=true`，但能力对象没有保存 `has_mcp`，QueryAgent 也没有 MCP 查询工具。只有 MCP 数据源时会进入 QueryAgent，却无法查询 MCP。

## 2026-07-16 精简

QueryAgent 已取消 `metric_view_query`、`align_metric`、`align_value`：

- 不再注册这三个模型工具。
- 不再探测指标和指标视图配置，它们也不再让 QueryAgent 判定为“有可查询能力”。
- 移除 `align_value` 专用的消歧记忆读写钩子；普通 `ask_user` 暂停和恢复不受影响。
- 旧工具实现暂时保留，供旧工作流兼容，但不会进入 QueryAgent 的运行时工具列表。

## 是否继续压平 SQL 和文档查询

可以，而且更符合当前架构。QueryAgent 本身已经是 WorkspaceAgent 调用的专用 Agent，继续通过 `sql_scan_operator` 启动 NL2SQLLeafAgent、通过 `query_documents` 启动 DocAgent，会形成三层模型循环：

```text
WorkspaceAgent
  → QueryAgent
      → NL2SQLLeafAgent / DocAgent
```

现已改成两层：

```text
WorkspaceAgent
  → QueryAgent
      → read / grep / ls / find / write / edit / bash
      → execute_sql
      → web_search
      → format_result / ask_user
```

这样 QueryAgent 可以像 Codex、Claude Code 一样，在一个循环里直接搜索、读取、执行、看错误并修正，不再把同一个问题交给另一个模型循环。

这不是简单删除两个包装工具。压平时必须保留以下代码能力：

1. QueryAgent 的工作目录必须绑定当前项目，Schema 和文档路径来自当前项目清单。
2. `execute_sql` 仍只允许单条只读 `SELECT/WITH`，保留重复 SQL 拦截和最大重试次数。
3. SQL 结果仍由 QueryAgent 的 AnalysisSession 自动落入中间 DuckDB，并返回稳定的表名和 handle。
4. `grep` 返回真实文件和行号，`read` 读取完整上下文；复杂处理可编写并运行脚本。
5. `execute_sql` 使用 `source_id`，解决一个项目有多个数据库时的连接选择问题。
6. QueryAgent 运行时已删除 `sql_scan_operator`、`query_documents` 和两个叶子 Agent 调用；旧实现文件只保留兼容用途。

主要代价是 QueryAgent 的上下文会包含 Schema、SQL 错误和文档原文。需要继续限制 grep 数量、读取行数和 SQL 结果预览，避免主循环上下文过大。整体上，这个代价小于多层 Agent 带来的额外模型调用、状态传递和完成语义复杂度。

## 代码工作区与数据库绑定

QueryAgent 使用通用代码工作区工具直接搜索 Schema 和 Markdown，不再需要分别提供 `grep_schema`、`read_schema`、`grep_documents`、`read_document`。文件目录仍必须和真实数据源使用同一个稳定标识，避免模型读了 A 库的 Schema，却把 SQL 发给 B 库。

建议为每次运行生成数据源清单：

```text
workspace/
  SOURCES.md
  databases/
    db_01/schema.sql
    db_02/schema.sql
  documents/
    docs_01/*.md
```

`SOURCES.md` 只包含当前项目已授权的数据源：

```markdown
| source_id | name | type | dialect | path |
|---|---|---|---|---|
| db_01 | 销售数据库 | database | postgresql | databases/db_01/schema.sql |
| db_02 | 客户数据库 | database | mysql | databases/db_02/schema.sql |
| docs_01 | 合同资料 | documents | - | documents/docs_01/ |
```

`execute_sql` 使用明确的数据源参数：

```json
{
  "source_id": "db_01",
  "sql": "SELECT ..."
}
```

约束：

1. `source_id` 来自运行时生成的授权清单，不允许传连接字符串或任意文件路径。
2. `SOURCES.md` 把每个 Schema 文件路径与唯一的 `source_id` 放在同一行，模型搜索后可以直接复制给 `execute_sql`。
3. 有多个数据库时 `source_id` 必填；只有一个数据库时运行时可以自动补齐，但工具结果仍显示实际使用的数据源。
4. `execute_sql` 校验 `source_id` 是否属于当前项目，再选择真实连接并执行只读 SQL。
5. 中间 DuckDB 也使用固定的会话级 `source_id`，例如 `session_intermediate`，跨源结果只能先落表再查询。

最终模型工具为 `read/grep/ls/find/write/edit/bash`、`execute_sql`、`web_search`、`format_result`、`ask_user` 和 `update_plan`。文件工具和 Bash 负责发现、阅读和计算，`execute_sql` 负责受控数据库查询和结果落表。

## 2026-07-17 实施结果（已被 2026-07-20 调整）

- 2026-07-17 曾注册 `bash_readonly`；2026-07-20 已替换为完整代码工作区工具和 `execute_sql`。
- 数据源与文档清单在内存中生成并注入本轮上下文，不写 `SOURCES.md` 或 `DOCUMENTS.md`。
- `write/edit/bash` 使用与 WorkspaceAgent 相同的审批规则和确认回调。
- `execute_sql` 使用稳定的 `source_id` 选择连接；多个数据库时必须明确指定，只有一个数据库时允许自动补齐。
- SQL 仍执行单条只读校验、外部文件访问拦截、重复 SQL 拦截和最多 8 次尝试。
- SQL 结果仍自动写入 AnalysisSession 的中间 DuckDB；跨源计算使用 `source_id=session_intermediate`。
- QueryAgent 服务不再把全量 Profile 注入模型上下文，Schema 只通过项目目录中的 SQL 文件按需搜索。
- `relationship_metadata` 中的表关系已经写入 Schema SQL，关系变化也会触发 Schema 文件刷新。
- 旧 NL2SQLLeafAgent、DocAgent 和包装工具保留为兼容代码，但 QueryAgent 不再调用它们。

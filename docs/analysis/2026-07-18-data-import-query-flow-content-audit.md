# 数据导入与问数流程内容审查

- 初次审查：2026-07-18
- 系统复查：2026-07-20
- 状态：DONE_WITH_CONCERNS（审查完成，发现会影响稳定性的内容缺口）

> 后续决策：不再区分 SQL、文档或混合任务的专用完成工具。`complete_sql` 已从新方案删除，统一使用 pi-agent 原生停止和最终消息；工具调用、SQL、中间表和文档引用作为证据记录，不作为终止开关。详见 [离线数据准备与在线问答边界](../specs/2026-07-18_offline-data-preparation-and-online-query.md)。

## 结论

模型能力不是当前主要问题。

现在的原始数据导入基本完整，QueryAgent 也已经能通过文件工具、代码执行、`execute_sql` 和循环修正查询。真正的问题是：系统虽然保存了数据、元数据、Schema 文件、Markdown 和规则，但没有一个统一的“内容已经准备好”的标准，也没有把这些内容完整、稳定地交给 QueryAgent。

可以把根因概括成一句话：

> 导入流程产生了多份内容，但没有统一清单和统一完成点；QueryAgent 看到的是一份有缺项的投影，而不是项目已经保存的全部事实。

这会产生三个直接后果：

1. 系统提示“可以问数”时，Schema 描述、关系或规则可能还没有准备好。
2. 数据库里已有的信息，到了 QueryAgent 工作区可能丢失。
3. 为了补这些缺口，Prompt 和结果校验里逐渐加入了题型规则，形成了不该有的硬编码。

## 2026-07-20：50 题后的系统复查

本节基于最新 50 题结果、实际运行库和代表性 trace，覆盖并更新下文较早的判断。当前已经完成的改动包括：移除 `complete_sql`、在线只读检查 Schema/Markdown、结构化后台任务续跑和失败收口、纯文档导入边界修复。因此，下文提到这些旧问题时，应以本节为准。

### 总结判断

当前准确率低，不是“元数据问题”或“Prompt 问题”二选一，而是四层问题叠加：

1. **可用性层**：50 题中只有 24 题进入答案列评分，另外 26 题被模型、CDP、会话等待或流式超时吞掉。正式 `3/50` 不能直接理解为 SQL 只有 6% 正确。
2. **内容和工具层**：50 题运行时文档只允许 `rg/sed/head/tail/wc`，导致跨文档抽取和文档与数据库关联无法计算。2026-07-20 已改为完整代码工作区，仍需重新评测确认收益。
3. **元数据层**：元数据本应只增强、持久化和解释真实来源，但当前仍会被同步覆盖、被重新导入删除，而且外键目标关系没有持久化。
4. **交接和完成层**：WorkspaceAgent 到 QueryAgent 的回答要求是可选自由文本；QueryAgent 只要以 `stop` 输出非空文字就算完成，不检查证据和输出合同。

Prompt 确实有可优化之处，但它排在工具、元数据写入规则和运行合同之后。只改 Prompt 不会补回丢失的关系、不会让文档可计算，也不能阻止离线模型任务抢占在线模型。

### 50 题数据应该怎样解读

- 正式通过：`3/50`，平均 score `0.067332`，平均 recall `0.073332`。
- 修复纯文档导入后，进入列评分的任务为 `24/50`。
- 可评分子集通过：`3/24`，即 `12.5%`。
- 另外 `26/50` 没有形成可评分答案，主要是 21 个 CDP 超时、3 个 assistant 等待超时和 2 个流式超时。

因此要把评测拆成四个独立指标：

| 指标 | 要回答的问题 |
|---|---|
| 可用率 | 请求是否走完整条链路并拿到最终结果 |
| 证据率 | 数据库问题是否真的执行 SQL，文档问题是否真的读取文件 |
| 内容准确率 | 结果值、行集合、去重、聚合和关联是否正确 |
| 展示准确率 | 最终列、顺序、表格和格式是否符合用户要求 |

现在的总分把四层压成一个数字，无法判断模型、Prompt、工具和运行环境各自贡献了多少失败。

### 代表性 trace 证明了什么

#### task_75：值正确，但交接合同丢失

QueryAgent 执行 1 条 SQL，正确得到 `Räikkönen`。但 WorkspaceAgent 调用 `query_project_data` 时没有传 `answer_requirements`，QueryAgent 最后返回普通句子而不是用户明确要求的 Markdown 表格，评测得到 0 列、0 分。

这不是 NL2SQL 错，也不是元数据错，是任务包没有可靠保留输出合同。当前 `answer_requirements` 和 `presentation_hint` 都是可选自由文本，见 `server/src/engine/skills/services/query_agent_service.js:26-40`。

#### task_86：值大体正确，但结果集合没有收口

QueryAgent 找到了 Alex Yoong 对应的比赛，前 16 行与 gold 一致，但最终多了重复的 `Japanese Grand Prix`。模型自然停止后，运行时直接标为完成，没有检查重复行和用户要求的结果集合。

这说明自然停止可以作为循环结束方式，但不能等于“答案已验证”。当前实现只检查最后一条 assistant 消息是否 `stop + 非空文本`，见 `server/src/engine/agents/query_agent.js:114-117`、`server/src/engine/agents/query_agent.js:540-566`。

#### task_418：有文档证据，却误判必须接数据库

项目只有 `Patient.md` 和 `Laboratory.md`。QueryAgent 已经通过 `rg` 找到 creatinine 内容，但随后调用没有注册的 `execute_sql`，最后要求用户接入数据库。修复纯文档导入后仍为 0 分。

这里 Prompt 有影响：规则强调数据库问题必须执行 SQL，但没有明确说明“工具列表中没有 `execute_sql` 时，这就是文档任务”。同时，约 2500 行的两份文档需要按患者 ID 关联、计算年龄和计数，只靠 grep/read 很脆弱。

#### task_420：当前工具无法完成 Codex 类跨来源计算

题目需要把 SQLite `cards` 表和 500 多行 `legalities.md` 中的 `legality id -> cards_id -> format/status` 信息关联，再计算 `hasContentWarning=0` 的占比。

QueryAgent 能 grep 文档、读 Schema、执行单个数据库 SQL，但不能把 Markdown 解析成临时表，也不能运行脚本或组合管道。最后它把 `leadershipSkills.commander` 当成 `format=commander` 的替代字段，虽然碰巧算出 `100%`，证据链是错的，最终又把两个中间计数混进表格而被判 0 分。

这证明当时的 `bash_readonly` 与 Codex 工具模型存在核心差距：命令白名单只有 `pwd/ls/rg/sed/head/tail/wc`，并禁止脚本、管道和重定向。

#### 2026-07-20 修复：QueryAgent 使用完整代码工作区

本次已删除 `bash_readonly` 特例，QueryAgent 直接复用 WorkspaceAgent 同源的 `read/grep/ls/find/write/edit/bash`：

- 可以编写和修改代码、生成中间文件、运行脚本，并读取真实输出。
- `write/edit/bash` 接入现有审批；嵌套 QueryAgent 继承父层的 `approval` 和 `awaitDecision`。
- Schema、Markdown 和数据源清单仍视为离线准备的事实来源，不会在问答时自动重建；需要明确修改时走正常写入审批。
- 每个代码工具调用都会进入 QueryAgent 的工具历史和 trace，证据统计区分文件读取、文件写入和命令执行。

这修复了“工具本身无法完成跨来源计算”的能力缺口，但不会自动修复 task_420 的口径判断、结果合同和元数据缺失。需要重新运行相关案例，分别判断工具可用率和答案准确率。

### 元数据当前违反了“只增强和持久化”

#### 1. 结构化文件重新导入会删除列元数据

同一文档重新导入时，代码保留表 ID，但把这张表的全部 `column_metadata` 软删除，再为所有列生成新 ID：

- `server/src/app/docs/structured.js:116-149`

结果是用户维护的字段描述、关键词、高召回标记和其他语义信息会随重新导入丢失。正确做法应按稳定键做差量合并，只删除真实消失的列。

#### 2. 数据库 Schema 同步会覆盖表描述

字段同步已经只更新结构字段，能保留字段描述：

- `server/src/app/datasource/connections.js:190-224`

但表同步仍把 `description: tbl.description || ""` 写回已有记录：

- `server/src/app/datasource/connections.js:262-284`

当数据库内省没有表描述时，已有用户描述会被空字符串覆盖。表和字段的写入规则不一致。

#### 3. 外键只有布尔标记，没有目标关系

50 题运行库中：

| 内容 | 数量 |
|---|---:|
| 表 | 125 |
| 字段 | 1338 |
| 有描述的表 | 79 |
| 有描述的字段 | 760 |
| 有示例值的字段 | 1299 |
| `is_foreign_key=1` 的字段 | 84 |
| `relationship_metadata` | 0 |

SQLite 插件读取了 `PRAGMA foreign_key_list`，但只保留 `is_foreign_key`，没有把目标表、目标字段和约束名放进统一结构。Schema SQL 只有在 `relationship_metadata` 已有记录时才输出关系，见 `server/src/engine/semantic/schema_file_service.js:63-77`、`server/src/engine/semantic/schema_file_service.js:103-114`。

“字段是外键”对 Agent 不够；它需要 `orders.customer_id -> customers.id` 这样的完整边。

#### 4. 后台不等于真正离线

结构化文件导入后会立即启动 `structured_connection_enrichment`：

- `server/src/app/docs/structured.js:261-277`
- `server/src/engine/semantic/enrichment_job_service.js:47-51`

该任务会生成字段和表描述。描述调用没有指定副模型，`chat()` 默认使用 `primary`：

- `server/src/engine/semantic/column_description.js:72-81`
- `server/src/engine/core/llm.js:1890-1910`

运行库时间线确认后台增强与在线问答重叠：

- `task_287`：增强 `10:53:03 -> 10:56:33`，问答 `10:53:04 -> 10:57:37`；第一次 QueryAgent 调用在 120 秒超时，第二次重试完成。
- `task_350`：增强 `11:18:29 -> 11:20:05`，问答 `11:18:33 -> 11:21:00`。
- `task_74`、`task_75`、`task_86` 也都在增强运行期间开始问答。

这能确认资源重叠，但还不能单独证明全部超时都由增强引起。要做关闭增强、独立模型或独立队列的 A/B 对照后才能确认因果关系。

### 正确的元数据合同

原始数据库、原始文件是事实来源；元数据是它们的持久化投影和可编辑增强，不能反过来遮挡或改写事实。

建议把字段所有权写死为以下规则，而不是靠调用方自觉：

| 类型 | 例子 | 所有者 | 同步规则 |
|---|---|---|---|
| 结构事实 | 表名、字段名、类型、空值、主键、真实外键 | 数据源内省 | 每次同步更新 |
| 来源事实 | 文件路径、大小、校验值、导入时间、原始页码 | 导入器 | 根据原始来源更新 |
| 自动增强 | 示例值、枚举、模型描述、候选关系 | 后台任务 | 只补空值或写独立版本 |
| 用户语义 | 用户描述、别名、业务规则、确认关系 | 用户 | 任何同步都不能覆盖 |

`table_metadata`、`column_metadata` 仍可作为统一持久层，但至少要区分 `source_*`、`generated_*` 和 `user_*`，最终有效值按 `user > source > generated` 合并。每条增强还需要 `origin/model/version/updated_at`，否则无法判断内容是谁写的、是否过期。

当前每个数据库连接一份 `<connection_id>.sql` 的方向可以保留。它是给 Agent 读取的渲染产物，不是第二份真相：

```text
原始来源
  -> 结构内省/文档转换
  -> 稳定的元数据与来源记录
  -> 渲染 schema.sql / document.md
  -> QueryAgent grep/read/execute
```

表描述和字段描述保存在元数据中，再渲染为 SQL 注释；真实外键渲染为关系注释。库特别大时再增加 manifest 和按表拆分文件，本次不需要引入向量、FTS 或召回服务。

### 应该参考 Codex 的是什么

不是照搬 Codex 的 Prompt，而是照搬它的工作方式：

1. 先看到真实目录和稳定文件。
2. 用 list/grep/read 缩小范围。
3. 用可组合、可复现的工具处理数据。
4. 根据真实错误继续修改命令或 SQL。
5. 最终回答附带执行证据，不靠隐藏召回结果。

当前 QueryAgent 已具备第 1、2、4 步的一部分，但缺第 3 步。对混合数据和文档计算，需要一个真正隔离的 `workspace_exec`：

- Schema、Markdown 和原始只读数据挂载为只读；
- 会话 scratch 目录可写；
- 禁止网络；
- 允许 `rg`、`sed`、`awk`、`jq` 和受控的 Python/Node 脚本；
- 脚本输出或临时表可以继续交给 `execute_sql(source_id="session_intermediate")`；
- 所有命令、输入文件、输出文件和退出码进入 trace。

这比继续增加 `document_query_operator`、`semantic_join_operator` 或题型规则更通用，也更接近模型本身擅长的循环方式。

### 完成方式：保留自然停止，但增加通用核验

不应恢复 `complete_sql`。工具负责产生证据，pi-agent 自然停止负责结束循环，这个方向正确。

问题是当前把“循环停止”和“答案已满足要求”合成了一个状态。建议拆成：

```text
execution_status: completed | failed | needs_input
evidence_status: sufficient | insufficient
answer_contract_status: satisfied | needs_repair
```

WorkspaceAgent 仍然自己决定委派内容，服务层不能用当前用户原文覆盖它。但任务包应使用通用结构，而不是可选的自由文本：

- `question`：WorkspaceAgent 判断后的完整任务；
- `resolved_context`：已经确认的指代和口径；
- `expected_evidence`：`sql`、`documents`、`mixed` 或 `none`；
- `output_schema`：需要的字段、顺序、去重和排序；
- `presentation`：表格、文字或图表。

QueryAgent 自然停止后做确定性检查：

- 要求 SQL 证据但没有成功 SQL，标记 `insufficient`；
- 要求文档证据但没有成功文件读取，标记 `insufficient`；
- 要求表格或字段列表但最终输出不符合，使用已有证据只做一次“结果修复轮”，不重新查数据；
- 不根据“多少、最高、最低”等关键词写题型正则。

这不是新的完成工具，也不限制模型推理，只是防止 task_75、task_86、task_418 这种明显未满足合同的结果被当成成功。

### 修复顺序

#### P0：先把评测拆开

1. 增加 QueryAgent 直跑模式，绕过 Electron/CDP 和 WorkspaceAgent，测纯工具循环准确率。
2. 保留端到端模式测真实产品可用率。
3. 分别记录导入、Workspace 委派、QueryAgent、输出合同和评测提取失败。

#### P0：停止离线任务抢在线资源

1. 结构化导入只生成基础 Schema 和本地示例值，立即进入 `queryable_raw`。
2. 模型描述改为用户触发或低优先级队列。
3. 必须使用独立副模型/独立并发池；没有副模型时直接跳过，不能回退抢占主模型。

#### P0：修复元数据持久化

1. 结构化重新导入改为按 `(connection, schema, table, column)` 差量合并。
2. 表同步与字段同步统一为“只更新结构字段”。
3. 持久化真实外键目标关系。
4. 为用户描述、来源描述和模型描述增加来源优先级与回归测试。

#### P0：补齐 Codex 类计算工具

在只读来源 + 可写 scratch + 无网络的沙箱中提供可组合执行能力。不要继续为每种文档题增加一个 operator。

#### P1：把任务包和答案合同结构化

保留 WorkspaceAgent 的委派权，增加证据类型和输出结构；自然停止后做通用核验和一次结果修复。

#### P2：最后精简 Prompt

Prompt 只保留策略：优先真实文件和执行证据、没有注册的工具不能调用、文档存在时不能因为没有数据库就拒答、不能用近似字段替代用户口径。不要在 Prompt 中补题型规则。

## 真实数据验证

本次使用本机 KDD task 25 的实际导入结果核对，不只看代码。

- 项目：`9f8ee42a-ce8e-4338-8bc4-3a66c504d462`
- 结构化数据源：`2c88fade-22b9-4440-b3c5-5a1882468211`
- 数据库连接：`f4a4c33a-55fc-48f8-a309-d319f38b1821`
- QueryAgent 使用的业务数据源 ID：`5bd52831-a533-4583-ba41-e499a2a2c7eb`

DuckDB 中的实际行数：

| 表 | 行数 |
|---|---:|
| `budget` | 52 |
| `event` | 42 |
| `expense` | 32 |

三个导入文档均为 `completed / 100%`，对应 `chunk_count` 也是 52、42、32。当前元数据有 3 张表、21 个字段，表和字段都已有描述，21 个字段都有示例值。

因此，这个案例不是“原始行丢了”。缺的是更上层的内容：

- `relationship_metadata` 为 0；
- `structured_documents.file_size` 都为空；
- `knowledge.md` 没有通过普通导入流程成为项目规则，而是 eval 单独塞进 QueryAgent 配置；
- 模型最后靠字段名、描述、示例值和多轮 SQL 自己推断了关联。

最新 task 25 结果是 1/1 通过，但耗时约 277.9 秒，产生 30 个 block、673 个 trace event，并经历多次 SQL 修正。它证明模型能解决问题，也证明当前内容交付不够直接。

## 一、数据导入流程的内容缺口

### P0：导入完成得太早

结构化文件在写入 DuckDB 和基础元数据后，马上被标记为 `completed`：

- `server/src/app/docs/structured.js:246-252`

字段示例、枚举、字段描述、表描述和 Schema SQL 在之后的后台任务中生成：

- `server/src/app/docs/structured.js:259-280`
- `server/src/engine/semantic/enrich.js:41-65`

而 `enrichConnection` 会把每一步错误放进返回值，不会抛出。外层因此仍可能把后台任务标成 `completed`。这意味着：

- 原始数据可查询；
- 但模型需要的说明内容可能缺失；
- UI 和 WorkspaceAgent 仍会认为项目已经可以正常问数。

实际本地库中有 6 个 `structured_connection_enrichment` 任务从 2026-07-17 起一直停在 `running / 5%`，另有 8 个完成。当前只有非结构化文档有重启续跑：

- `server/src/engine/datasources/unstructured/document_processing_service.js:128-151`

没有看到结构化富化任务的重启续跑或中断收口。

同时，WorkspaceAgent 把 `structured_import` / `database_file_import` 的返回直接映射为 `project_ready_for_query`：

- `server/src/engine/agents/workspace_agent.js:252-273`

所以“数据能查”和“问数上下文完整”被当成了同一个状态。

### P0：去向量的改造没有做完

结构化数据源的后端仍然解析并保存 embedding model：

- `server/src/app/datasource/datasources.js:11-35`
- `server/src/app/datasource/datasources.js:60-80`

前端创建结构化数据源时仍把 embedding model 设为必填项：

- `renderer/src/views/project/settings/components/StructuredDataSourceListView.tsx:57-72`
- `renderer/src/views/project/settings/components/StructuredDataSourceListView.tsx:108-125`
- `renderer/src/views/project/settings/components/StructuredDataSourceListView.tsx:161-173`
- `renderer/src/views/project/settings/components/StructuredDataSourceListView.tsx:415-426`

非结构化任务状态也仍用 `embedding_status` 判断文档是否可用：

- `server/src/engine/agents/product_tools.js:417-445`

但文档列表没有提供这个字段，新的处理流程又明确把 embedding 设为 `null`。因此一个已经生成 Markdown 的文档仍可能被错误上报为 `needs_embedding`。

### P1：Schema SQL 是对的方向，但内容还不完整

当前 `.sql` 是“每个数据库连接一份”，这个粒度是合理的。它由 `table_metadata`、`column_metadata` 和 `relationship_metadata` 生成：

- `server/src/engine/semantic/schema_file_service.js:20-24`
- `server/src/engine/semantic/schema_file_service.js:82-125`

表描述和字段描述写在 SQL 注释中，结构信息写成 `CREATE TABLE`，这个统一方法也是合理的。

缺少的内容有：

- 数据库连接的 `description` 和 `business_rules`；
- 表的 `row_count`；
- 该表来自哪个导入文件/文档；
- 文件大小、校验值、更新时间等来源信息；
- 真实的外键目标关系；
- 当前 Schema 是否仍在生成、生成失败还是已经完整。

数据库连接的同步只写了表和字段，没有写 `relationship_metadata`：

- `server/src/app/datasource/connections.js:227-295`
- `server/src/app/datasource/connections.js:316-327`

多个数据库插件虽然能知道“这个字段是外键”，但没有把目标表和目标字段完整保存下来。于是 Schema 文件只有在 `relationship_metadata` 已有记录时才会输出关系：

- `server/src/engine/semantic/schema_file_service.js:63-78`
- `server/src/engine/semantic/schema_file_service.js:103-114`

本次 KDD 的三表关系就是 0 条，模型只能自己猜。

### P1：业务规则有保存入口，但没有进入 QueryAgent

`database_connections.business_rules` 目前只有增删改查，没有被 Schema 文件或 QueryAgent 工作区读取。

QueryAgent 的动态规则来自 `agents.rules`，不是数据库连接里的 `business_rules`。项目 `AGENTS.md` 会进入 WorkspaceAgent 上下文，但 QueryAgent 的工作区只明确读取 `SOURCES.md` 和 `DOCUMENTS.md`。

这造成三套规则入口：

1. 项目 `AGENTS.md`；
2. `agents.rules`；
3. `database_connections.business_rules`。

它们没有统一来源，也没有明确优先级。eval 又有第四种方式：直接把 `knowledge.md` 塞进 `agents.rules`。这能让题目通过，但不是用户正常导入数据时会走的路径。

### P1：非结构化 Markdown 丢了来源锚点

非结构化主流程已经不依赖向量，方向正确：

- 文本或文件转换成 Markdown；
- Markdown 落盘；
- 文本块 embedding 固定为空；
- 图片使用项目副模型。

代码位置：

- `server/src/engine/datasources/unstructured/document_processing_service.js:35-107`
- `server/src/engine/datasources/unstructured/document_loaders.js:89-113`

但转换后的 Markdown 没有统一的头部信息，也没有保留可靠的原始位置：

- PDF 只提取纯文本，没有稳定页码标记；
- DOCX 使用 `extractRawText`，标题、表格和图片结构会丢；
- HTML 用正则去标签，链接和表格关系会丢；
- 分块只按字符数和分隔符，没有保存标题路径、页码、行号范围。

代码位置：

- `server/src/engine/datasources/unstructured/document_loaders.js:25-80`
- `server/src/engine/datasources/unstructured/text_splitter.js:1-56`
- `server/src/engine/datasources/unstructured/document_processing_service.js:66-84`

因此 QueryAgent 虽然可以引用“生成后的 Markdown 第几行”，但不能稳定回答“原 PDF 第几页、哪个章节”。

### P1：工作区会静默隐藏失败或未完成文档

`prepareQueryWorkspace` 只把已经找到 Markdown 文件的文档放进 `DOCUMENTS.md`。没有 Markdown 的文档会直接 `continue`：

- `server/src/engine/agents/query_workspace_tools.js:61-89`

QueryAgent 无法区分下面四种情况：

- 这个项目没有文档；
- 文档还在处理；
- 文档解析失败；
- 数据库里有文档记录，但 Markdown 文件丢了。

这会让模型在缺内容时误以为“没有相关资料”。

## 二、问数流程的内容缺口

### P0：WorkspaceAgent 的决定应保留，但交接内容太薄

当前 WorkspaceAgent 自己决定是否调用 QueryAgent，也自己决定传入的 `question`。这是正确的，不应该在服务层强行改回“原始用户问题”。

代码也已经按这个方向实现：

- `server/src/engine/skills/services/query_agent_service.js:46-76`
- `server/src/engine/skills/services/query_agent_service.js:233-243`

问题在于交接只有一个自由文本 `question`。WorkspaceAgent 一旦只传了简短任务，下面这些内容就可能丢失：

- 当前轮已经解析出的指代；
- 用户要求的列、格式、排序和并列规则；
- 已知的数据源；
- 需要沿用的业务口径；
- 哪些是用户明确要求，哪些只是 WorkspaceAgent 的推断。

task 25 的 trace 里，WorkspaceAgent 只交接了 `Which event has the lowest cost?`，外层题目中的输出要求没有一起传入。模型最后仍然答对，是因为 `complete_sql` 的结果渲染和硬编码校验替它补了一部分。

正确方向不是把原始问题写死，而是让 WorkspaceAgent 仍然掌握决定权，同时交接一个小而明确的任务包，例如：

- `task`：本次要解决什么；
- `resolved_context`：历史对话中已经确认的指代和口径；
- `answer_contract`：最终要返回哪些列、格式和并列规则；
- `known_sources`：WorkspaceAgent 已经确认的数据源，可为空。

### P0：完成条件按“项目有没有数据库”判断，不是按“本次任务是什么”判断

QueryAgent 当前使用：

```js
const requiresSqlCompletion = Boolean(capabilities?.has_structured);
```

代码位置：

- `server/src/engine/agents/query_agent.js:226-235`
- `server/src/engine/agents/query_agent.js:562-587`

这会导致混合项目中的纯文档问题失败：只要项目里有一个结构化数据源，即使本次问题只查 PDF，QueryAgent 直接输出带引用的文档答案也会被判为 `complete_sql_required`。

同样，项目里有数据库时，纯网络问题也会被误伤。

“SQL 查询只有调用 `complete_sql` 才算完成”这个要求本身没有问题。问题是系统把“项目具备 SQL 能力”误当成“本次任务是 SQL 查询”。完成条件应该由本次实际计划和使用的证据类型决定。

### P0：同一个 System Prompt 内存在相反要求

配置 Prompt 明确写着：

> 完成后直接输出自然语言答案；不需要完成工具。

位置：

- `server/config/agent_configs.zh.json:86-90`

运行时又追加：

> 只有 `complete_sql` 成功才算任务完成。

位置：

- `server/src/engine/agents/query_agent.js:166-174`
- `server/src/engine/agents/query_agent.js:311-320`

这不是模型能力问题，是系统给了相反指令。

### P1：工作区内容太薄

QueryAgent 当前拿到的 `SOURCES.md` 只有：

- `source_id`
- 名称
- 类型
- 方言
- Schema/文档路径
- 简短 note

`DOCUMENTS.md` 只有：

- `source_id`
- 文档 ID
- 标题
- 描述
- Markdown 路径

代码位置：

- `server/src/engine/agents/query_workspace_tools.js:32-124`

没有：

- 来源是否准备完成；
- 失败原因；
- 原始文件路径/文件名/大小/更新时间；
- Schema 生成时间；
- 业务规则路径；
- 表关系是否完整；
- 文档原始页码/章节；
- 本次可查询的表数、文档数。

模型有 `rg` 能力，但 `rg` 只能搜索已经写进工作区的内容。没有投影进来的事实，模型再强也搜不到。

### P1：硬编码正在替代缺失内容

当前 QueryAgent 运行时 Prompt 有 KDD 化学题示例、计数主语、最低/最高、姓名列等题型规则：

- `server/src/engine/agents/query_agent.js:150-164`

`complete_sql` 还有英文/中文关键词正则：

- `server/src/engine/agents/query_tool_adapter.js:45-67`

这些规则能修正个别 eval，但不是全工作场景的稳定方法。项目后面会有 PDF 工作台和更多任务类型，继续添加题型词会让行为越来越难解释。

应先补齐 Schema、规则、来源、状态和任务交接，再删除只为某套题服务的规则。模型可以基于完整内容自己规划和自检。

## 三、建议的统一内容模型

不引入向量和全文检索。它们不在本次范围。

建议每个数据源都有一份权威清单。可以是机器读取的 JSON，加一份给模型和用户看的 Markdown；也可以先用一份结构固定的 Markdown。关键不是格式，而是它必须成为唯一的完成依据。

最少包含：

```text
source_id
source_type
original_files
query_target
schema_path / documents_path
rules_path
status
raw_content_ready
context_ready
tables / rows / documents
relationships_status
generated_at
errors
```

状态至少分开：

1. `importing`：原始内容未完成；
2. `queryable_raw`：数据已经能查，但说明/关系可能未完整；
3. `context_ready`：QueryAgent 所需文件已生成并通过检查；
4. `failed`：明确给出哪一步失败。

QueryAgent 应先读项目总清单，再 `rg` 具体 `.sql` 或 `.md`。这样模型知道自己拿到的内容是否完整，也知道缺失时应该等待、说明还是继续用原始结构查询。

## 四、建议的修改顺序

### 第一阶段：先消除错误状态和相反指令

1. 删除结构化数据源前后端的 embedding 配置。
2. 删除非结构化 `job_status` 中的 embedding 判断和提示。
3. 拆开 `queryable_raw` 与 `context_ready`，不要导入一返回就发 `project_ready_for_query`。
4. 给结构化富化任务增加重启续跑或中断标记。
5. 统一 QueryAgent 的完成说明，删除“无需完成工具”和“必须完成工具”的冲突。
6. 按本次任务判断完成方式，不按项目有没有结构化数据判断。

### 第二阶段：补齐模型可搜索的内容

1. 建立每个数据源的权威清单和项目总清单。
2. Schema SQL 加入连接说明、业务规则、行数和文件来源。
3. 数据库内省保存完整外键：源表/源字段/目标表/目标字段。
4. 明确“普通文档”和“项目规则文档”的导入方式，规则只保存一次并传给 QueryAgent。
5. Markdown 加头部信息，保留原始路径、页码、Sheet、章节和转换方式。
6. `DOCUMENTS.md` 显示处理中、失败和文件缺失的文档，不再静默隐藏。

### 第三阶段：简化问数 Prompt

1. WorkspaceAgent 继续决定委派内容，但改成小型结构化任务包。
2. SQL、文档和混合任务都通过 pi-agent 原生停止完成；SQL 结果和文档引用作为可追踪证据保留，不增加专用完成工具。
3. 内容契约稳定后，删除 KDD 专用示例和关键词正则。
4. 保留通用约束：只读 SQL、真实 Schema、证据引用、失败后根据真实错误修改。

## 五、需要补的测试

本次运行现有相关测试，共 16 个，全部通过。它们验证了：

- QueryAgent 只读文件工具；
- `execute_sql` 的 source_id 和只读限制；
- `complete_sql` 渲染和终止；
- JSON 转 Markdown；
- 图片可交给副模型；
- 文本导入不需要 embedding；
- WorkspaceAgent 可以决定委派给 QueryAgent 的问题。

但还缺少以下真正能防回归的测试：

1. 导入前后行数、字段数一致；
2. 外键关系内省后完整进入 Schema SQL；
3. 业务规则进入 QueryAgent 工作区；
4. 必需内容未生成时不能标成 `context_ready`；
5. 后台富化内部某一步失败时不能整体标成完成；
6. App 重启后结构化任务能续跑或明确失败；
7. 混合项目中的纯文档问题不要求 `complete_sql`；
8. 未完成、失败和 Markdown 丢失的文档会出现在清单中；
9. WorkspaceAgent 交接时保留回答格式和已确认口径；
10. 普通导入路径和 eval 使用相同的规则加载方式。

## 最终判断

当前系统已经具备让模型解决问题的基本能力：能搜索 Schema 和 Markdown，能执行 SQL，能在循环中根据错误修正，也能由 WorkspaceAgent 决定是否调用 QueryAgent。

下一步不应继续给模型加题型提示。应先保证：

> 数据导入产生的全部有效内容，都以可检查的状态进入同一个项目工作区；WorkspaceAgent 交接的任务不丢口径；QueryAgent 的完成条件与本次任务一致。

做到这三点，准确率和速度会比继续加 hardcode 更稳定，也更适合后续 PDF 工作台和全工作场景。

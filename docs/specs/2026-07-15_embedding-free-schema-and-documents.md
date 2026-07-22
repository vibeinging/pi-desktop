# 无 Embedding 的 Schema 与文档处理

> 本文保留最初的过渡实现范围。完整的数据分层、每表 SQL、版本管理、召回和一致性设计见
> [Schema 与内容文件架构](../design/2026-07-15_schema-content-artifact-architecture.md)。
> 本文中“每个连接一个 SQL 文件”和“元数据是唯一主数据”不再作为最终架构结论。
> 大规模文档检索所需的向量、全文索引、分块、重排和存储方案不在本次需求范围。
> 离线数据准备、在线问答和 Agent 自然结束协议见
> [离线数据准备与在线问答边界](./2026-07-18_offline-data-preparation-and-online-query.md)。

## 目标

- Schema 同步后写成项目工作区里的 SQL 文件，不再依赖向量生成和向量召回。
- 普通文档统一转成 Markdown，再按 Markdown 内容做文本检索。
- 图片交给用户配置的副模型处理；没有可用副模型时给出清楚的配置错误。
- 文档是否处理成功，只看 Markdown 是否生成成功，不再看向量是否生成。

## 文件位置

每个项目继续使用 `~/.yiw/projects/<project-id>` 作为工作区：

```text
schemas/<connection-id>.sql
documents/<data-source-id>/<document-id>.md
```

每个数据库连接生成一个完整 SQL 文件，文件内包含这个连接下的全部表和字段。Schema SQL 文件是 NL2SQL 的正式输入。

`table_metadata` 和 `column_metadata` 是唯一主数据，SQL 文件只是自动生成的只读快照：

- 表描述、表关键词来自 `table_metadata`，写成表前面的 SQL 注释。
- 字段描述、字段关键词、示例值和枚举来自 `column_metadata`，写成字段旁边的 SQL 注释。
- 数据库同步、表或字段描述修改、批量字段修改和删除表后，立即重建 SQL 文件。
- NL2SQL 读取前比较元数据与文件更新时间；文件较旧时先重建，再读取。
- 不接受直接编辑 SQL 文件作为元数据修改方式，避免双向同步冲突。

## Schema 流程

1. 数据库连接完成内省。
2. 表和字段元数据照常写入本地 SQLite。
3. 立即生成完整 `schemas/<connection-id>.sql`。
4. NL2SQL 直接读取该 SQL 文件，不调用 Embedding 模型。
5. 如果旧项目没有 SQL 文件，首次使用时从现有表和字段元数据补写一份。

NL2SQL 作为上层 Query Agent 的叶子 Agent 运行。它通过 `list_schema`、`grep_schema`、`read_schema` 和 `execute_sql` 在有限循环内完成一个明确查询；执行失败时根据真实错误继续查 Schema 和修改 SQL，不把纠错工作退回给上层。结果可用后，模型直接返回最终消息，由 pi-agent 按原生循环语义结束，不再增加单独的完成工具。

SQL 文件包含表名、字段名、字段类型、主键、是否为空、默认值和已有描述。它是结构快照，不会被拿去连接或执行。

## 非结构化文档流程

1. Markdown 原样保留。
2. TXT、LOG、JSON、CSV、HTML、PDF、DOCX、XLSX 转成 Markdown。
3. PNG、JPG、JPEG、WEBP、GIF 交给项目副模型识别，要求模型输出 Markdown，并尽量保留标题、段落、表格和图片里的文字。
4. Markdown 写入项目工作区，再按段落切片写入本地 SQLite。
5. Agent 使用列文件、grep 和按行读取 Markdown，不在本次实现隐藏的文本排名服务。

文档查询由 `DocAgent` 叶子节点负责。上层调用 `query_documents(question, source_name?)` 后，DocAgent 自己执行 `list_documents`、`grep_documents` 和 `read_document` 循环，最后按 pi-agent 原生结束方式返回答案。结果包含文档名、文档 ID、行号和证据。旧的 `semantic_scan_operator`、`semantic_filter_operator`、`semantic_extract_operator`、`semantic_join_operator` 不再注册到 QueryAgent 主路径。

## 模型规则

- 普通文档不需要任何模型。
- 图片默认使用项目的 `SECONDARY` 模型。
- 图片模型需要支持 OpenAI 兼容的图片消息格式。
- 用户未提供副模型、模型不支持图片或 OCR 失败时，只让该图片处理失败，并显示真实原因。

## 兼容与迁移

- 旧的 `embedding`、`embedding_model_id` 字段暂不删表，避免破坏已有本地库；新流程不再读写这些字段。
- 旧文档可以点“重新处理”，生成 Markdown 后进入新流程。
- 以前卡在 `embedding_failed`、`embedding_partial` 的文档，启动后按新流程重新处理。
- 旧的 Schema 向量接口暂时保留地址，但实际行为改为刷新 SQL 文件，不再调用 Embedding 模型。

## 验收

- 没有 EMBEDDING 模型时，数据库同步、NL2SQL Schema 读取、PDF/DOCX/TXT 导入和文档搜索都能工作。
- Schema 同步后能在项目工作区看到 `.sql` 文件。
- 文档处理后能在项目工作区看到 `.md` 文件。
- 图片在配置副模型后能生成 Markdown；未配置时能看到明确提示。
- 后端测试、前端类型检查通过。

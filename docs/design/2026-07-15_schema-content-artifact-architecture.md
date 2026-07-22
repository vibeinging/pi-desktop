# Schema 与内容文件架构

## 结论

YiW 不再把 Embedding 当成 Schema 和文档检索的基础设施。

新的统一原则是：

1. 数据库或原始文件负责提供原始事实。
2. 用户填写的描述、别名和业务规则是另一类事实，任何自动同步都不能覆盖。
3. SQL 和 Markdown 是 Agent 真正读取的内容文件。
4. Agent 使用列文件、grep 文件、读文件这三个基础动作查找内容。SQLite 元数据只负责状态和文件清单，不参与语义召回。

这不是让一个存储取代另一个存储，而是给每一层划清职责。

## 当前实现的问题

当前改动已经让流程在没有 Embedding 模型时可以运行，但它只能作为过渡版本：

- 一个连接只有一个完整 SQL 文件。小库可用，大库会把无关表全部塞给模型，占满上下文并降低选表准确率。
- `SchemaAnalysisTool` 读取整个 SQL 文件，传入的 `schema_hint` 没有参与文件选择。
- `schema_retrieval_service`、`grep_tables` 和 `SchemaAnalysisTool` 形成了两套 Schema 召回路径，结果可能不同。
- `table_metadata` 同时保存数据库结构和用户描述，但同步代码没有按字段区分写入者。现有同步会用数据库返回的空描述覆盖表描述。
- SQL 文件没有版本清单，也没有固定会话版本。同步发生在一次问答中间时，同一任务可能看到两版 Schema。
- SQL 里没有完整表达 `relationship_metadata`，跨表查询仍缺少关键连接关系。
- 文档检索会把数据源下全部切片读进 Node.js，再逐条计算字符串分数，数据量增大后是 O(N) 扫描。
- 图片固定走“副模型”，没有独立的 OCR、视觉模型和失败回退规则。扫描版 PDF 也没有进入图片识别流程。

## 真源与写入权

不要再说“某一张表是唯一主数据”。应该按字段说明谁有写入权。

| 内容 | 真源 | 谁可以修改 | 下游产物 |
|---|---|---|---|
| 表名、字段名、类型、主键、外键 | 外部数据库内省结果 | Schema 同步 | 本地元数据、表 SQL |
| 表描述、字段描述、别名、关键词、业务规则 | 用户配置 | 用户和明确授权的生成任务 | 本地元数据、表 SQL |
| 原始文档 | 用户导入的文件 | 用户替换或删除 | Markdown |
| Markdown 正文 | 文档转换结果 | 转换任务 | Agent grep 和按行读取 |
| SQL/Markdown 文件 | 上述内容合成后的版本化产物 | 产物生成器 | Agent 上下文 |
| SQLite 文件清单 | SQL/Markdown 的派生清单 | 产物生成器 | 文件状态、版本和路径 |

`table_metadata` 和 `column_metadata` 可以继续使用，但必须遵守字段写入权：

- Schema 同步只更新结构字段。
- 用户编辑只更新语义字段。
- 自动描述任务只更新空的语义字段，除非用户明确选择覆盖。
- 删除使用软删除；重新出现的同名对象恢复原记录和用户描述。
- 表重命名无法可靠跨数据库自动判断时，不猜。先当成删除加新增，并允许用户迁移原描述。

这样可以先修正边界，不需要立即增加一套新的语义元数据表。

## Schema 文件怎么拆

每个数据库连接使用一个目录。每张表一个 SQL 文件，同时保留完整库文件用于查看和导出：

```text
~/.yiw/projects/<project-id>/schemas/<connection-id>/
├── manifest.json
├── full.sql
├── relationships.sql
└── tables/
    ├── public.orders.sql
    ├── public.order_items.sql
    └── public.customers.sql
```

### 每个文件的职责

- `tables/<schema>.<table>.sql`：Agent 的主要 Schema 输入。包含一张表的 DDL、表描述、字段描述、示例值、枚举和与该表直接相关的关系。
- `relationships.sql`：连接下所有已知外键和用户补充的连接关系。方便检查，也用于关系扩展。
- `full.sql`：同一版本所有表文件和关系的合并结果。用于用户查看、导出、小库直接读取和故障回退。
- `manifest.json`：只保存目录、版本、哈希和生成信息，不保存业务 Schema 正文。

`manifest.json` 至少包含：

```json
{
  "format_version": 1,
  "artifact_version": "20260715T120000Z-8d3a1f2c",
  "connection_id": "...",
  "dialect": "postgresql",
  "generated_at": "2026-07-15T12:00:00Z",
  "source_fingerprint": "...",
  "tables": [
    {
      "table_id": "...",
      "qualified_name": "public.orders",
      "path": "tables/public.orders.sql",
      "content_hash": "..."
    }
  ]
}
```

文件名必须编码不安全字符，实际表名仍写在 SQL 和 manifest 中。不能直接把用户或数据库提供的名字拼进路径。

## 表描述和字段描述放哪里

描述保存在 `table_metadata.description` 和 `column_metadata.description`，这是用户可编辑的语义字段。生成 SQL 时再写入注释：

```sql
-- @table-description: 订单主表，一行代表一次下单
-- @aliases: 订单, 销售订单
CREATE TABLE "public"."orders" (
  "id" bigint PRIMARY KEY,
  "customer_id" bigint NOT NULL,
  "paid_at" timestamp
);

COMMENT ON TABLE "public"."orders" IS '订单主表，一行代表一次下单';
COMMENT ON COLUMN "public"."orders"."paid_at" IS '支付完成时间，未支付时为空';

-- @relationship: orders.customer_id -> customers.id (many_to_one)
```

注释是跨数据库都能安全读取的 Agent 信息。`COMMENT ON` 便于人阅读，但文件只作为上下文，不直接在外部数据库执行，因此不要求所有方言都能执行它。

## Schema 生成流程

```text
外部数据库
    │ 内省
    ▼
结构字段归一化 ──────┐
                     │ 合并，按字段写入权
用户描述与业务规则 ──┘
          │
          ▼
生成临时版本目录
  ├─ 每表 SQL
  ├─ relationships.sql
  ├─ full.sql
  └─ manifest.json + 哈希
          │ 全部成功后一次切换
          ▼
激活 artifact_version
          │
          └─ Agent 可以立即 grep 新版本文件
```

生成必须满足：

- 先写临时版本，所有文件成功后再原子切换当前版本。
- 一次版本中的每表 SQL、关系和 manifest 必须来自同一份元数据快照。
- 修改一张表描述时只重建该表文件、完整文件和 manifest 哈希。
- 同步失败时继续使用上一版，不留下半套文件。
- 删除连接时清理工作区必须走显式资源清理流程，不能在查询时顺手删除。

## Agent 怎么用 grep 选表

“不用 Embedding”不等于“把整个库交给模型”，也不需要再造一个隐藏的召回服务。YiW 应该采用代码 Agent 已经验证过的工作方式：先列文件，再 grep，再读取命中的少量文件。

```text
用户问题
   │
   ▼
workspace_files(scope="schema")
   │ 看见有哪些连接、schema 和表文件
   ▼
workspace_grep(pattern="订单|order|销售", glob="*.sql")
   │ 返回文件、行号和少量上下文
   ▼
workspace_read(paths=[命中的表 SQL])
   │ Agent 可以换词继续 grep
   ▼
grep relationships.sql，补齐关联表
   ▼
sql_scan_operator(schema_files=[已读文件])
```

具体规则：

1. `workspace_files` 只列项目工作区内允许访问的相对路径，不能越过项目目录。
2. `workspace_grep` 内部优先调用 `rg`，不可用时才退回 Node.js 文本搜索。它必须支持 glob、大小写、固定字符串、正则、前后文和最大结果数。
3. grep 返回真实文件路径、行号和文本片段，不返回人工计算的“相似度”。Agent 能看到为什么命中。
4. 表名、字段名、用户描述、别名、关键词和关系都写进 SQL，因此同一个 grep 可以查完整语义。
5. Agent 可以根据第一次结果换同义词、缩小目录或读取文件。这种多轮查找是正常流程，不要求第一次搜索就找全。
6. `workspace_read` 只能读 manifest 中登记的当前版本文件，并限制单次行数和总字符数。
7. Agent 读过的表文件路径记录进会话，并传给 `sql_scan_operator`。NL2SQL 只加载这些文件，不能再次偷偷做一套召回。
8. 查询涉及关联时 grep `relationships.sql`，再读取补充表文件。
9. 如果整个 `full.sql` 小于上下文预算，可以直接读取。这是小库快路，不是默认行为。
10. 零命中时让 Agent 换词 grep 或询问用户，不能用空 Schema 继续生成 SQL。

为了兼容现有问数工具，第一步可以保留 `grep_tables` 和 `grep_columns` 名字，但它们内部必须改为 grep SQL 文件。稳定后统一成工作区级工具：

```text
workspace_files  列出 SQL、Markdown、PDF 产物等文件
workspace_grep   在允许的文件中用 rg 搜索
workspace_read   按路径和行号读取内容
```

这三个工具以后可以直接复用于 PDF 工作台、文档工作台和其他工作场景，不需要每种工作台再建一套召回服务。

## NL2SQL 唯一执行链

NL2SQL 是上层 Query Agent 的叶子 Agent。上层负责拆分业务问题，NL2SQL 只负责解决一个明确的数据查询问题。它不能继续拆任务或调用其他 Agent，但可以在受限循环中多次 grep Schema、读取 Schema、执行 SQL 和修正 SQL。

```text
父 Query Agent
   │ question + database
   ▼
NL2SQL 叶子 Agent
   ├─ list_schema
   ├─ grep_schema      ───────┐
   ├─ read_schema             │
   ├─ execute_sql             │ 失败、空结果或结果不合理
   │      │                   │
   │      └───────────────────┘
   └─ 返回最终消息，按 pi-agent 原生语义结束
          │
          ▼
SQL + 真实查询结果返回父 Agent
```

叶子 Agent 的约束：

- 只允许读取当前 Schema 版本登记的 SQL 文件，不能越过项目目录。
- grep 返回真实文件、行号和文本，不返回相似度。
- 只允许单条 `SELECT` 或 `WITH`，拒绝写操作、多语句和外部文件/网络读取函数。
- 每条 SQL 必须真实执行。执行错误作为工具结果返回，Agent 根据错误继续查 Schema 和修改 SQL。
- 相同失败 SQL 不能原样重试，SQL 尝试次数和模型轮数都有上限。
- 不增加额外的完成工具。模型不再调用工具并返回最终消息时，pi-agent 原生循环结束。
- 循环结束时，最后一次 `execute_sql` 必须成功；不能用更早的成功结果掩盖后续失败。
- 叶子 Agent 已经执行过的 SQL，外层不能再重复执行一次。
- 父任务停止时，叶子 Agent 必须同时收到中止信号。

`schema_retrieval_service` 不再负责按问题“猜”相关表，只保留 Schema 文件生成和关系信息。原来的单次 `SQLGenerationAgent` 不再是 NL2SQL 主路径。

同一次 NL2SQL 任务固定一个 `artifact_version`。同步完成后只影响下一次任务，避免问答过程中 Schema 改变。

## 非结构化文件架构

结构化和非结构化使用同一套产物思想：

```text
原始文件
   │ source_hash
   ▼
Extractor
   ├─ 文本类：本地转换
   ├─ 图片：OCR 或视觉模型
   └─ 扫描 PDF：逐页转图片后走 OCR/视觉模型
   │
   ▼
版本化 Markdown + manifest
   │
   ▼
Agent 列文件 -> grep Markdown -> 按行读取
```

文档目录调整为：

```text
documents/<data-source-id>/<document-id>/
├── source/<original-name>
├── document.md
└── manifest.json
```

文档 manifest 记录源文件哈希、转换器版本、OCR/模型标识、生成时间、Markdown 哈希和处理状态。源文件或转换器版本没有变化时不重复处理。

### 提取器配置

不要把图片处理写死成“副模型”。项目配置提供一个文档提取器：

- 本地文本提取器：TXT、Markdown、HTML、DOCX、XLSX、文本 PDF。
- OCR 提取器：适合扫描件和纯文字图片。
- 视觉模型提取器：适合表格、图表、界面截图和复杂版面。

默认选择顺序：

1. 普通文档先走本地提取。
2. 本地提取为空，或检测到扫描 PDF，再走用户配置的 OCR/视觉提取器。
3. 图片优先用用户指定的提取器。
4. 没有可用提取器时明确标记“需要配置 OCR 或视觉模型”，保留原文件，允许稍后重试。

OCR 和视觉模型输出都必须经过统一的 Markdown 清理和大小限制，不能各自直接写数据库。

## 文档 grep

文档和 Schema 使用相同的文件工具，不再维护一套向量召回或隐藏的全文排名：

- Markdown 保留稳定的标题、页码和段落结构，方便 grep 返回有意义的行号。
- `workspace_grep(scope="documents")` 只搜索当前项目已完成的 Markdown 产物。
- Agent 先 grep 标题和正文，再按行读取命中段落；需要整篇时才读取完整文件。
- 中文搜索由 Agent 主动换词解决，例如“合同金额”“价款”“总价”可以依次 grep，不伪造一个相似度分数。
- SQLite 中的文档切片可以暂时保留给现有接口，最终不再作为 Agent 召回主路径。
- 本次不设计大规模文档检索。文档达到几十万、几百万片段时，需要单独设计包含向量、全文索引、分块、重排、存储和评测的完整方案，不能只在当前流程里补一个索引。

## DocAgent 叶子节点

旧的 `semantic_scan_operator` 只负责按文件名读取全部切片。上层还要继续编排逐行过滤、抽取、关联和 SQL，文档问题被拆成很多内部步骤，且容易把同一事实的多个切片当成多条业务数据。

文档查询改为一个叶子 Agent：

```text
QueryAgent
   │ question + 可选 source_name
   ▼
DocAgent
   ├─ list_documents
   ├─ grep_documents     ───────┐
   ├─ read_document             │ 换词、补上下文、查其他文档
   │      │                     │
   │      └─────────────────────┘
   └─ 返回最终答案，按 pi-agent 原生语义结束
          │
          ▼
答案 + 文档名 + 行号 + 证据返回 QueryAgent
```

规则：

- QueryAgent 只提交完整文档问题，不替 DocAgent 选择文件、切片或关键词。
- DocAgent 可以跨当前项目的多个文档数据源列文件和 grep，也可以被 `source_name` 限制到一个数据源。
- grep 使用真实 `rg`，不可用时退回受限的 Node.js 文本搜索。
- `read_document` 只接受已登记的 `document_id`，路径必须位于该文档数据源的项目目录内。
- DocAgent 只能依据工具返回的 Markdown 回答。多份文档冲突时保留冲突，没有证据时明确说未找到。
- 不增加 `complete_doc`。模型停止调用工具并返回最终消息时，由 pi-agent 的 `stopReason=stop` 正常结束。
- 返回结果保留答案、文档 ID、文档名、行号和证据。上层可直接回答，也可把稳定 ID 交给后续 SQL 查询。
- 旧的 `semantic_scan/filter/extract/join` 文件暂时保留兼容，但不再注册到 QueryAgent 主路径。

## 失败规则

| 失败 | 系统行为 | 用户看到什么 |
|---|---|---|
| 数据库内省失败 | 保留上一版 Schema | 同步失败原因，仍可使用上一版 |
| 生成一张表 SQL 失败 | 整版不激活 | 文件生成失败和具体表名 |
| manifest 与文件哈希不符 | 回退上一版并提示重建 | Schema 文件损坏，可一键重建 |
| 召回没有候选表 | 不调用空 Schema 的 NL2SQL | 提示先补充表名或选择数据源 |
| 关系指向已删除表 | 忽略失效关系并记录诊断 | 查询可继续，设置页显示待修关系 |
| 文档本地提取为空 | 尝试 OCR/视觉提取器 | 显示正在识别或配置要求 |
| OCR/视觉模型超时 | 保留原文件，可重试 | 真实错误、重试按钮 |
| grep 工具不可用 | 从 `rg` 退回受限的 Node.js 搜索 | 搜索变慢，但文件仍可读取 |

## 测试图

```text
SCHEMA
├─ 全量同步
│  ├─ 新表、新列、删除表、删除列
│  ├─ 结构更新不覆盖用户描述
│  └─ 一次生成完整且同版本的文件集
├─ 增量语义编辑
│  ├─ 表描述写入对应表 SQL
│  ├─ 字段描述写入对应表 SQL
│  └─ 关系写入表 SQL 和 relationships.sql
├─ 召回
│  ├─ 已读 schema_files 直接使用
│  ├─ grep 名称、描述、别名命中
│  ├─ Agent 换词再次 grep
│  ├─ grep 关系并补读关联表
│  ├─ 上下文预算截断
│  ├─ 小库 full.sql 快路
│  └─ 零候选时明确失败
└─ 一致性
   ├─ 生成中断继续使用上一版
   ├─ 哈希错误回退
   └─ 同一任务固定版本

DOCUMENT
├─ 本地转换：md/txt/html/pdf/docx/xlsx
├─ 图片：OCR 成功、视觉模型成功、未配置、超时
├─ 扫描 PDF：逐页识别和部分页失败
├─ 版本：源文件未变跳过、源文件变化重建
├─ grep：新增、更新、删除、中文换词、结果截断
└─ 用户流程：导入、后台处理、查看 Markdown、失败重试、删除
```

LLM 生成 SQL 和图片转 Markdown 都需要固定案例集。单元测试只能证明流程跑通，不能证明生成内容可用。

## 实施顺序

### 第一阶段：先修正数据边界

- 修复 Schema 同步覆盖表描述的问题。
- 把结构字段和语义字段的写入规则写进同步测试。
- SQL 加入关系信息。
- 当前完整 SQL 文件继续保留，保证已有流程不退化。

### 第二阶段：版本化的每表 Schema 文件

- 把单文件改为连接目录、每表文件、关系文件、完整文件和 manifest。
- 原子生成和激活版本。
- 增加哈希检查和旧项目迁移。

### 第三阶段：让 Agent 用 grep 找 Schema

- 增加 `workspace_files`、`workspace_grep` 和 `workspace_read` 三个受限文件工具。
- 先让现有 `grep_tables`、`grep_columns` 改读 SQL 文件，再迁移到通用工作区工具。
- Agent 已读文件、关系文件和 `SchemaContextService` 统一进入 NL2SQL。
- 增加上下文预算和任务版本固定。

### 第四阶段：文档提取器和 grep

- 抽出本地、OCR、视觉三类提取器。
- 补扫描 PDF 流程。
- 文档使用版本 manifest。
- 让文档工具直接 grep 和按行读取 Markdown，删除 Node.js 全量切片扫描。

### 第五阶段：删除旧 Embedding 痕迹

- 真实调用链、前端配置和测试都不再依赖后，删除向量服务调用和旧接口。
- 数据库中的旧字段先停止读写，再做单独迁移删除。
- 用 Schema 召回案例和文档检索案例比较迁移前后结果。

## 不在本轮范围

- 不讨论或引入向量、全文索引、重排服务和大规模知识库检索。它们属于另一套完整方案，不在本次需求范围。
- 不为几十万、几百万文档片段做容量设计。本次只覆盖项目工作区内 SQL 和 Markdown 文件的 Agent grep、读取与使用。
- 不支持用户直接编辑生成后的 SQL 或 Markdown 再反向写元数据。双向同步会制造冲突。
- 不自动猜测所有表重命名。没有稳定对象 ID 时，猜错比提示用户迁移描述更危险。
- 不删除历史 Embedding 字段。先停用并证明新路径稳定，再做数据库迁移。
- 不把 SQL 文件直接执行到用户数据库。它们是 Agent 上下文和导出产物。

## 验收标准

- 没有 Embedding 模型时，数据库同步、选表、NL2SQL、文档导入和文档检索完整可用。
- 1000 张表的连接不会把完整 Schema 无条件塞入模型。
- 数据库再次同步不会覆盖用户填写的表和字段描述。
- Agent 读取的是召回到的每表 SQL，且日志能看到使用了哪个 artifact 版本和哪些表。
- 关系表能被自动扩展进上下文。
- 文档搜索不再把全部切片加载到 Node.js 内存，Agent 直接 grep Markdown 文件。
- 图片和扫描 PDF 可以使用用户配置的 OCR 或视觉模型，没有配置时错误可理解、可重试。
- 任何生成失败都保留上一版可用文件，不产生半更新状态。

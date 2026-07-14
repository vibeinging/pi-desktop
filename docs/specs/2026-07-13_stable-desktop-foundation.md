# PI Desktop 稳定桌面底座产品规格

- 状态：代码实施完成，等待远端三平台首跑
- 创建日期：2026-07-13
- 目标版本：`0.1.0`
- 适用范围：PI Desktop 桌面端、内置 Server、Renderer、构建与 GitHub 仓库

## 1. 背景

PI Desktop 已经可以作为 pi-agent 桌面底座的技术预览使用，基础能力包括 Electron、React、本地 Server、SQLite、模型、Skills、MCP、附件、工具调用和会话历史。

当前剩余问题主要不是业务清理，而是底座能力没有形成稳定约定：部分界面选项没有真实执行、会话上下文有两套数据源、后端异常后界面可能一直等待、密钥仍明文落盘、版本和发布流程不统一、开源仓库的安全与二次开发入口不完整。

本规格把这些问题合并为一个稳定化项目，避免在多份文档中重复维护结论。

## 2. 产品目标

完成后，开发者应能：

1. 从仓库创建自己的桌面 Agent，不会遇到“界面显示支持但运行时没有实现”的能力。
2. 明确知道 Skill 可以使用哪些工具，并且白名单由代码强制执行。
3. 重启、恢复、删除和导出会话时得到一致的数据。
4. 在后端退出、卡住或重启时看到明确错误和恢复状态，而不是一直等待。
5. 安全保存模型和 MCP 密钥，数据库泄露时不会直接得到明文。
6. 使用一个版本号生成 macOS、Windows 和 Linux 安装包。
7. 通过自动检查、签名、公证、校验和和 GitHub Release 发布版本。
8. 集中修改名称、App ID、协议、数据目录、图标和默认提示词。

## 3. 不在本轮范围

- 不实现云端账号、团队同步和远程数据库。
- 不实现 Skill 市场。
- 不承诺 Service Skill 和 Workflow Skill 的执行协议；本轮先移除未实现入口。
- 不强制实现 MCP Streamable HTTP；当前继续以本地 `stdio` 为稳定基线。
- 不自动购买或配置 Apple、Microsoft 的签名账号；流程支持签名，真实证书由维护者提供。

## 4. 实施顺序

| 顺序 | 工作包 | 原因 | 状态 |
| --- | --- | --- | --- |
| 1 | Skill 真权限 | 先收紧 Agent 能力边界 | 已完成 |
| 2 | 会话双表示一致性 | 后续恢复和升级都依赖可靠历史 | 已完成 |
| 3 | 后端异常恢复 | 保证桌面主流程不会永久等待 | 已完成 |
| 4 | 系统凭据存储 | 在正式打包前解决密钥落盘 | 已完成 |
| 5 | 统一版本 | 为安装包和 Release 提供唯一版本 | 已完成 |
| 6 | 三平台发布流程 | 生成并验证可分发产物 | 已完成，待 CI 首跑 |
| 7 | GitHub 安全 | 为公开仓库增加自动保护 | 已完成 |
| 8 | 统一应用配置与开发体验 | 降低二次开发成本 | 已完成 |

## 5. 工作包 1：Skill 工具白名单与类型约束

### 5.1 现状

- 界面可以选择 Prompt、Service、Workflow。
- 运行时只读取 Prompt Skill，另外两类会被跳过。
- `allowed_tools` 只出现在提示词中，没有在工具执行前检查。
- Skill 索引提示模型调用 `use_skill`，但 Workspace Agent 没有注册这个工具。
- Agent 启动时会把全部启用 Skill 的完整指令同时放进系统提示词，无法判断当前是哪一个 Skill 在生效。

### 5.2 产品决定

1. 当前稳定类型只有 `prompt`。
2. Renderer 不再提供 Service、Workflow 选项。
3. Server 创建或更新 Skill 时拒绝非 `prompt` 类型，并返回清楚的错误。
4. Agent 的系统提示词只放 Skill 索引，不直接放全部完整指令。
5. 增加 `use_skill(name)` 工具。调用成功后返回该 Skill 的完整指令，并把它设为当前激活 Skill。
6. 激活 Skill 后，普通本地工具和 MCP 工具都必须经过白名单检查。

### 5.3 白名单规则

- `use_skill`、`update_plan` 属于控制工具，始终可用。
- 未激活 Skill 时，使用项目原有工具权限。
- 激活 Skill 且 `allowed_tools` 非空时，只允许名单内工具。
- 激活 Skill 且 `allowed_tools` 为空时，表示不额外限制。
- MCP 工具使用完整工具名匹配，同时支持 `mcp_*` 通配项。
- 再次调用 `use_skill` 会替换当前 Skill 和白名单。
- 被拦截的工具返回明确原因，不能只依赖提示词自觉。

### 5.4 任务

- [x] 增加 Prompt runtime 的 Server 校验。
- [x] 移除 Renderer 中未实现的运行类型。
- [x] 创建 `use_skill` 工具和激活状态。
- [x] 在 `beforeToolCall` 中强制执行白名单。
- [x] 为未激活、空白名单、普通工具、MCP 工具、切换 Skill 增加测试。
- [x] 更新 README 和架构说明。

### 5.5 验收标准

- API 无法保存 `service` 或 `workflow`。
- 界面只能创建 Prompt Skill。
- 白名单为 `read` 的 Skill 无法执行 `write`、`bash` 或 MCP 工具。
- 白名单为空的 Skill 保持原有权限。
- 测试可以证明拦截发生在代码执行层。

实施结果：Server 31 个测试全部通过，其中新增 6 个 Skill 权限测试；Renderer typecheck 和无错误 lint 通过。

## 6. 工作包 2：SQLite 会话双表示一致性

### 6.1 现状

- `session_messages` 用于界面历史。
- `~/.pi-desktop/agent-sessions/*.jsonl` 用于模型上下文。
- JSONL 写入失败会被忽略。
- JSONL 文件存在时，恢复不会检查它是否比 SQLite 更新。
- 删除会话只软删 SQLite 记录，不处理 JSONL。

### 6.2 产品决定

SQLite 是唯一正式存储。会话允许有两种用途不同的读取结果，但只有一份权威历史：

- `session_messages` 是人类查看、恢复和删除会话时的权威历史；
- Agent transcript 是模型使用的可重建投影，保留工具调用和压缩上下文；
- `agent_transcript_state` 用权威历史序号和投影版本检查两者是否一致。

JSONL 不再参与日常读写，只保留为：

1. 老版本数据的一次迁移来源；
2. 用户主动导出的文件格式。

### 6.3 数据设计

新增 `agent_transcript_messages`：

| 字段 | 说明 |
| --- | --- |
| `session_id` | 所属会话，带外键 |
| `seq` | 会话内严格递增序号 |
| `message` | 原始 AgentMessage JSON |
| `created_at` | 写入时间 |

新增 `agent_transcript_state`：

| 字段 | 说明 |
| --- | --- |
| `session_id` | 所属会话，主键和外键 |
| `source_sequence_number` | 投影已包含的权威历史序号 |
| `revision` | 投影每次追加或重写后递增的版本 |
| `updated_at` | 最近同步时间 |

约束：`(session_id, seq)` 唯一；追加、重写和同步基线使用事务。同一会话的 Agent、压缩、删除和迁移必须串行。

### 6.4 迁移与恢复

- 首次读取老会话且 SQLite transcript 为空时，尝试导入同名 JSONL。
- 跳过损坏的尾行，但记录导入警告和有效/无效条数。
- 导入成功后把原文件改名为 `.migrated`，避免重复导入。
- SQLite transcript 为空且没有 JSONL 时，才从界面消息重建最小上下文。
- 权威历史序号超过投影基线时，从权威历史重建 Agent 投影；这覆盖后端在两次写入之间退出的情况。
- 数据库写入失败必须让本轮运行失败并显示错误，不能静默丢失。

### 6.5 任务

- [x] 增加 schema、迁移和索引。
- [x] 把 sessionStore 改为 SQLite store。
- [x] 增加一次 JSONL 导入器。
- [x] 补 transcript 清理、导出和恢复接口。
- [x] 增加投影版本基线和退出后的自动重建。
- [x] 增加会话锁，串行执行 Agent、压缩和删除。
- [x] 覆盖追加、失败回滚、损坏 JSONL、完整删除、投影修复和压缩并发测试。
- [x] 更新数据目录与备份说明。

### 6.6 验收标准

- 同一会话只有 `session_messages` 一份权威历史，Agent transcript 必须能核对和重建。
- 重启后模型上下文与界面历史一致。
- 删除会话后不存在消息、运行、待处理输入或 transcript 残留。
- 写入失败会报告错误，事务不会留下半轮数据。
- 老 JSONL 可以安全导入一次。

实施结果：数据库迁移版本升到 4；`session_messages` 是权威历史，Agent transcript 使用序号基线和 revision 作为可重建投影；Agent 正常完成时运行状态和投影基线一起提交，发现投影落后时自动从权威历史恢复。同一会话的 Agent、压缩和删除由会话锁串行执行；删除会清理界面消息、运行、待处理输入、投影和旧 JSONL。新增 JSONL 导出接口，37 个 Server 测试通过。

## 7. 工作包 3：后端退出与 IPC 恢复

### 7.1 现状

- 后端进程退出时只清空引用。
- 等待中的普通 IPC 请求没有统一超时。
- 后端不可用时发送可能静默失败。
- Renderer 没有明确的恢复状态。

### 7.2 状态机

`starting → ready → unhealthy → restarting → ready`

超过重试上限后进入 `failed`。应用退出时进入 `stopping`，不再重启。

### 7.3 行为

- 每个请求有默认 30 秒超时，流式 Agent 请求使用单独的空闲超时。
- 后端退出时立即拒绝全部等待请求，错误码为 `BACKEND_EXITED`。
- 启动后必须完成 ready 握手才接收业务请求。
- 意外退出使用退避重启：1 秒、2 秒、5 秒，最多 3 次。
- 重启期间 Renderer 显示正在恢复；恢复后允许重试只读请求。
- 写请求不自动重放，避免重复创建或重复执行工具。

### 7.4 任务

- [x] 抽出 BackendProcessManager。
- [x] 增加 pending request 注册、超时和统一拒绝。
- [x] 增加 ready 握手与有限重启。
- [x] 通过 preload 暴露只读后端状态订阅。
- [x] 增加 Renderer 恢复提示和重试入口。
- [x] 测试退出、超时、连续失败、恢复和应用正常退出。

### 7.5 验收标准

- 后端被杀死后，没有 Promise 永久等待。
- 3 次以内的临时退出可以自动恢复。
- 多次启动失败会给出可操作错误。
- 正常退出应用不会触发重启。

实施结果：普通 IPC 请求默认 30 秒超时，流请求默认 5 分钟无数据超时；Server 完成 IPC 注册后发送 ready；意外退出立即以结构化错误结束全部等待项，并按 1/2/5 秒重启，最多 3 次；Renderer 顶部提示恢复或失败状态。生命周期 4 个测试、主进程语法检查、Renderer typecheck 和 lint 已通过。

## 8. 工作包 4：系统凭据存储

### 8.1 目标

模型 API Key 和 MCP 敏感环境变量不再明文保存在 SQLite。

### 8.2 设计

- Electron 使用 `safeStorage` 调用 macOS Keychain、Windows DPAPI 和 Linux Secret Service。
- SQLite 只保存凭据引用，例如 `credential:model:<id>`、`credential:mcp:<provider>:<key>`。
- Electron 主进程是凭据代理；Renderer 永远拿不到明文。
- Server 只在实际连接模型或 MCP 时请求所需明文，并只保存在进程内存中。
- 日志、错误、trace 和导出文件都必须继续脱敏。
- Linux 检测到不安全的 `basic_text` 后拒绝保存，并提示安装 Secret Service。

### 8.3 迁移

- 启动时发现旧明文后，由 Electron 写入系统凭据存储。
- 成功后同一事务把数据库字段替换为引用。
- 失败时保留原值并提示用户，不得先清空。
- 提供迁移状态和重试入口。

### 8.4 任务

- [x] 增加 Electron 凭据代理和 Server 请求协议。
- [x] 定义凭据引用格式与脱敏规则。
- [x] 改造模型和 MCP 创建、更新、删除、调用流程。
- [x] 增加旧数据迁移和失败恢复。
- [x] 增加安全存储和 Linux 不安全后端测试替身。
- [x] 更新安全文档。

### 8.5 验收标准

- 新保存的密钥不会以明文出现在数据库、日志和 API 返回中。
- 删除模型或 MCP Provider 时同步删除凭据。
- 旧数据库升级后密钥仍可使用。
- 系统凭据服务不可用时给出明确错误，不静默降级为明文。

实施结果：Electron `safeStorage` 负责加解密，密文文件权限收紧到当前用户；SQLite 只保存带版本的 `credential:*` 引用；Server 使用私有子进程消息按需取值；模型与 MCP 的创建、更新和删除会同步维护凭据。启动迁移、状态和重试接口已补齐，迁移失败会保留旧值。当前完整回归包含 37 个 Server 测试和 2 个凭据存储测试。

## 9. 工作包 5：统一版本

### 9.1 产品决定

- 根 `package.json` 是唯一版本来源。
- 首个稳定化版本统一为 `0.1.0`。
- Electron、Server、Renderer 的 package 版本由脚本检查并同步。
- Git tag 使用 `v<version>`。

### 9.2 任务

- [x] 增加 `scripts/version.mjs` 的 check/set 命令。
- [x] 同步四个 package 和 lockfile 根条目。
- [x] CI 运行版本一致性检查。
- [x] 增加 `CHANGELOG.md` 和发布说明模板。
- [x] 定义 SemVer、数据库迁移和扩展废弃规则。

### 9.3 验收标准

- 开发界面、安装包文件名、`app.getVersion()`、tag 和 Release 显示同一版本。
- 任一子项目版本不一致时 CI 失败。

实施结果：根项目、Server、Renderer、Electron 和三个 lockfile 已统一为 `0.1.0`；根 `check` 首步执行版本检查；Server 运行时从自己的 package 读取版本；增加 CHANGELOG 和 GitHub Release 分类模板。兼容规则见发布手册。

## 10. 工作包 6：三平台安装包与 Release

### 10.1 产物

- macOS：arm64、x64 的 DMG/ZIP，签名并公证。
- Windows：x64 NSIS 安装包，签名。
- Linux：x64 AppImage 和 deb。
- 每个产物生成 SHA-256；Release 附带生产依赖许可证清单和 SBOM。

### 10.2 流程

1. 发布改动通过 PR 合并到 `main`。
2. `main` push CI：源码检查、单测、三平台 unpacked 打包、启动探针。
3. 人工完成关键桌面场景回归。
4. 在已经通过回归的 `main` 提交上创建 tag。
5. tag CI 先验证提交属于 `main`、同一提交的 push CI 成功、tag 与 package 版本一致。
6. 门禁通过后重新构建正式产物并签名。
7. 上传 GitHub Release，先生成 draft；所有安装 smoke 通过后再公开。

### 10.3 任务

- [x] 扩展 electron-builder 三平台 target。
- [x] 增加打包矩阵和启动探针。
- [x] 增加签名、公证环境变量检查。
- [x] 增加 Release workflow、合并与回归门禁、checksum、SBOM 和许可证清单。
- [x] 增加发布手册和回滚步骤。

### 10.4 验收标准

- 三平台都能从空 checkout 生成产物。
- unpacked 应用能加载 Renderer 与 preload，通过 IPC 读写 SQLite，并在后端重启后恢复会话和完成删除。
- 正式 Release 不接受未签名的 macOS/Windows 产物。
- Release 页面可以验证版本、校验和和第三方许可证。

实施结果：electron-builder 已配置 DMG/ZIP、NSIS、AppImage/deb；PR 和 main push CI 构建 unpacked 应用，并通过真实 Electron 与本机假模型检查 Renderer、preload、pi Agent 首轮流式对话、Server IPC、SQLite 写入、模型/Prompt Skill/MCP 配置、文本附件、后端重启恢复和删除；tag workflow 先确认提交已合并到 main 且同一提交回归成功，再强制签名输入、验证 macOS 签名与公证、验证 Windows Authenticode，并创建带校验和、SBOM 和许可证的 Draft Release。配置文件语法已通过本地检查，四个平台产物需要合并后由 GitHub Actions 首跑确认。

## 11. 工作包 7：GitHub 安全

### 11.1 仓库设置

- 开启 Private vulnerability reporting。
- 开启 Dependabot alerts 和 security updates。
- 开启 Secret Scanning 与 Push Protection。
- 开启 CodeQL default setup 或仓库 workflow。

### 11.2 代码设置

- Actions 固定到完整 commit SHA，并在注释中保留版本名。
- Dependabot 增加 `github-actions`。
- CodeQL 覆盖 JavaScript/TypeScript。
- `SECURITY.md` 写入长期有效的报告入口。

### 11.3 降级处理

GitHub 免费计划或仓库设置不支持某项能力时，记录 API 返回和替代措施，不能在文档中宣称已经开启。

### 11.4 验收标准

- 仓库 Security 页面可以私密报告漏洞。
- 测试密钥提交会被 Push Protection 拦截。
- CodeQL 在 PR 上产生检查结果。
- Actions 不再只引用浮动大版本标签。

### 11.5 实施结果

GitHub API 已确认开启 Secret Scanning、Push Protection、Dependabot alerts、安全更新和 Private Vulnerability Reporting；CodeQL default setup 已为 JavaScript/TypeScript 开启并生成首次运行。现有 `Protect main` ruleset 会阻止删除、强推和非 PR 修改，并要求三平台 CI。仓库内所有 Actions 已固定到完整 commit SHA，Dependabot 也会检查 Actions。非 Provider patterns 和 validity checks 在当前仓库仍显示不可用，不把它们记为已开启。

## 12. 工作包 8：统一应用配置、示例和静态检查

### 12.1 统一应用配置

新增根级应用清单，至少包含：

- 产品名、短名称、描述；
- App ID、URL 协议、数据目录名；
- 默认语言、主题和图标；
- 默认系统提示词和默认工具；
- 仓库、文档和问题反馈地址。

构建脚本生成 Electron、Renderer 和 Server 可读取的配置，避免运行时各自硬编码。

### 12.2 完整扩展示例

增加一个最小“项目笔记助手”示例，覆盖：

1. 新增 Server 用例和路由；
2. Renderer API 与页面；
3. Prompt Skill 和工具白名单；
4. 本地 `stdio` MCP；
5. IPC 错误、取消和权限；
6. 数据库迁移和测试。

### 12.3 静态检查

- Renderer：保留 TypeScript、ESLint。
- Server：对 `src/`、`scripts/`、`test/` 增加 ESLint 或 JS typecheck。
- Electron：检查 main、preload 和打包脚本。
- 根 `npm run check` 必须覆盖全部区域。

### 12.4 验收标准

- 修改一份应用清单即可完成常见改名。
- 新开发者可以按示例完成一个端到端功能。
- Server 或 Electron 中的未定义变量、错误 import 和常见 Promise 错误会让 CI 失败。

### 12.5 实施结果

新增 `app.config.json`，生成 Electron、Server、Renderer 配置和 Renderer 启动页；electron-builder 直接读取生成配置。新增“项目笔记助手”完整示例，包含用例、路由、迁移、测试、页面、Prompt Skill 和 stdio MCP。根检查新增 Node ESLint 规则，覆盖 Server、Electron、根脚本和示例；示例 2 个测试、Renderer typecheck 和 lint 已通过。

## 13. 总体验收

- [ ] `npm run setup` 在空 checkout 成功。（等待远端 CI 首跑）
- [x] `npm run check` 成功且覆盖 Renderer、Server、Electron、构建脚本。
- [ ] 三平台 unpacked 打包和启动探针成功。
- [x] 数据库从旧版本安全迁移到 `user_version=4`，已有项目、会话、消息、模型、Skill 和 MCP 不丢失。
- [x] Skill 白名单、会话恢复、后端重启和凭据迁移都有失败路径测试。
- [x] GitHub 主分支保护、安全扫描和 Release 流程状态与文档一致。
- [x] README、ARCHITECTURE、SECURITY、CONTRIBUTING、CHANGELOG 与实现一致。

本机验证：`npm run check` 通过；37 个 Server、15 个 Renderer、10 个 Electron、2 个示例测试通过；macOS arm64 unpacked 应用完成 Renderer、preload、pi Agent 首轮流式对话、Server IPC、SQLite 写入、模型/Prompt Skill/MCP 配置、文本附件、后端重启恢复和删除探针；三个 SBOM 可生成。macOS x64、Windows、Linux 的打包和 smoke 只能在提交后由 GitHub runner 验证，当前不提前勾选。

## 14. 主要风险

| 风险 | 处理方式 |
| --- | --- |
| 会话迁移损坏旧数据 | 导入前不删除 JSONL；事务成功后才改名 |
| 凭据迁移失败导致密钥丢失 | 先写系统存储并验证，再替换数据库字段 |
| 后端自动重启重复写操作 | 不自动重放写请求，只提示用户重试 |
| 三平台原生模块 ABI 不一致 | 每个平台在 Electron 版本下重编并启动测试 |
| GitHub 安全能力受计划限制 | 保存真实 API 结果并提供替代 workflow |
| 集中配置造成循环依赖 | 构建时生成各层只读配置，不让 Renderer 读取 Node 文件 |

## 15. 文档维护规则

- 本文是稳定化项目的唯一主计划。
- 每完成一个工作包，更新状态、任务勾选和真实验证结果。
- 具体调试记录只进入 `docs/reports/`，不重复复制产品决定。
- 对外 README 只写已经实现的能力，未完成项继续放在“当前限制”。

<p align="center">
  <img src="renderer/src/assets/yiw-logo.svg" width="88" alt="YiW logo" />
</p>

<h1 align="center">YiW</h1>

<p align="center">
  <strong>基于 pi Agent 的通用底座，让 Agent 通过小程序持续长出新能力。</strong>
</p>

<p align="center">
  <a href="https://github.com/vibeinging/yiWork/actions/workflows/ci.yml"><img src="https://github.com/vibeinging/yiWork/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/status-developer%20preview-f59e0b" alt="Developer Preview" />
</p>

YiW 不是一个写死业务的桌面工具。它首先是一个基于 **pi Agent** 的通用 Agent 应用底座，提供模型接入、会话、上下文、工具调用、Skill、MCP、权限、状态和运行记录等基础能力。

在这个底座上，YiW 增加了一套**自进化 Agent 框架**：用户只需要描述需求，主 Agent 就可以设计功能、生成实现、完成检查与预览，再把新能力安装进 App。后续修改作为新版本升级，出现问题时可以退回旧版本。

这些新能力最终以**小程序**承载。小程序把用户需求、页面、后端逻辑、数据、状态和权限固定成可以长期使用的产品；Skill 可以作为需求模板或执行能力接入，但不是生成小程序的前提。

> [!IMPORTANT]
> YiW 目前是开发者预览版。接口、数据库结构和小程序协议仍可能变化，请勿用它保存重要数据的唯一副本。

## 三层产品结构

| 层级 | 解决什么问题 | 核心内容 |
| --- | --- | --- |
| pi Agent 通用底座 | Agent 怎么稳定运行 | 模型、消息循环、上下文、会话、工具、Skill、MCP、权限和运行记录 |
| 自进化 Agent 框架 | App 怎么根据需求长出新能力 | 需求理解、方案生成、开发、检查、预览、安装、升级和回滚 |
| 小程序产品层 | 新能力怎么被用户长期使用 | 页面、交互、后端逻辑、数据、状态、权限和独立版本 |

> **一句话定义：小程序是 App 的可安装功能单元，也是 YiW 自我生长的基本单位。**

这里的“自进化”不是让 Agent 静默修改核心 App。核心底座保持稳定，新功能通过受控的小程序包进入系统，并经过检查、权限确认、版本管理和用户确认。

## 一个具体例子

用户可以直接告诉主 Agent：

> 帮我在侧边栏添加一个股票模块，信息结构和交互方式参考成熟的股票软件。

YiW 的目标流程是：

1. 主 Agent 使用 pi Agent 底座理解需求，澄清行情、持仓、自选股、数据源和权限。
2. 自进化框架使用现有 Skill 作为可选需求模板，或直接从对话生成产品方案。
3. 框架生成小程序的页面、后端逻辑、数据结构、状态和权限声明。
4. 小程序经过检查与预览，由用户确认后安装到侧边栏。
5. 用户可以长期使用它；主 Agent 也可以打开它，并调用用户明确发布给 Agent 的能力。
6. 后续需求形成新的小程序版本，可以升级，也可以退回旧版本。

这里的“参考”是指借鉴公开的信息结构和交互方式，不复制第三方的商标、素材或私有代码。

## 底座、主 Agent、小程序和 Skill

| 概念 | 它是什么 | 在 YiW 中的作用 |
| --- | --- | --- |
| pi Agent 底座 | 通用 Agent 运行环境 | 提供模型、会话、上下文、工具调用和执行循环 |
| 主 Agent | App 的智能入口 | 理解需求、使用底座能力、开发和管理小程序 |
| 小程序 | App 的可安装功能单元 | 固定页面、交互、后端、数据、状态和权限，可独立升级或回滚 |
| Skill | Agent 可复用的说明和能力合同 | 约束一类任务怎么完成，也可以作为小程序的需求模板或对外能力 |

小程序和 Skill 不是一一对应的：

- 用户需求不需要先写成 Skill，也可以直接生成小程序。
- Skill 可以直接运行，不一定要做成小程序。
- 小程序可以参考 Skill，也可以由用户和主 Agent 从零开发。
- 普通小程序可以独立供用户使用；只有把能力明确发布为 Skill 后，主 Agent 才能调用它内部的业务命令。

## 工作流程

```mermaid
flowchart LR
    FOUNDATION["pi Agent 通用底座"] --> AGENT["主 Agent"]
    USER["用户需求"] --> AGENT
    SKILL["可选 Skill"] -. "需求模板" .-> EVOLUTION["自进化框架"]
    AGENT --> EVOLUTION
    EVOLUTION --> PACKAGE["小程序包\n页面 + 后端 + 数据 + 状态 + 权限"]
    PACKAGE --> CHECK["检查 + 预览 + 用户确认"]
    CHECK --> RUNTIME["小程序运行时"]
    RUNTIME --> APP["App 侧边栏与工作台"]
    RUNTIME -. "明确发布能力" .-> EXPORTED["Agent Skill"]
    EXPORTED --> AGENT
```

## 当前能力

- **pi Agent 通用底座**：模型、项目、会话、上下文、附件、流式回复、工具调用、Skill、MCP、权限和运行记录。
- **自进化开发流程**：主 Agent 可以从用户需求或可选 Skill 生成产品方案和小程序草稿，再经过检查、预览和确认完成安装。
- **动态小程序**：包含页面、后端能力、数据、状态和权限，支持安装、启用、停用、升级和回滚。
- **Agent 与小程序协作**：主 Agent 可以列出和打开小程序；小程序明确发布为 Skill 的业务能力也可以被主 Agent 调用。
- **Skill 产品化**：Skill 可以被固定为带页面和长期状态的小产品；成熟小程序也可以选择把能力发布为 Agent Skill。
- **数据工作台**：结构化数据、文档、自然语言问数、报告和 Trace 优化。
- **扩展接入**：按项目安装外部 Skill，并通过 MCP 接入外部工具。

### 三种更新路径

| 更新对象 | 适合放什么 | 更新方式 |
| --- | --- | --- |
| YiW 核心应用 | pi Agent 底座、账号、安全和系统运行时 | 通过正式版本发布；自动更新仍在规划中 |
| 小程序 | App 持续长出的独立功能 | 运行时安装、升级、停用和回滚，不必重装整个应用 |
| Skill | 需求模板和 Agent 执行能力 | 按版本安装或更新，需要时固化为小程序，或由小程序明确发布 |

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `electron/` | Electron 主进程、窗口、预加载和本地系统能力 |
| `renderer/` | React 18、TypeScript 和 Vite 前端 |
| `server/` | 本地 API、SQLite、Agent、Skills、MCP 和小程序运行时 |
| `eval/` | 自动测试、桌面端评测和可选外部数据集适配 |
| `docs/` | 设计、规格、调研和测试报告 |

桌面主链路通过 Electron 进程通信连接本地后端。HTTP 入口只用于开发和评测，并绑定本机地址。

## 快速开始

环境要求：

- Node.js `>= 26.3.0`
- npm `>= 11.16.0`
- macOS、Linux 或 Windows；目前完整验证以 macOS arm64 为主

```bash
git clone https://github.com/vibeinging/yiWork.git
cd yiWork
npm run setup
npm run dev
```

`npm run setup` 会安装 Server、Renderer 和 Electron 的锁定依赖，并构建项目内置的 pi Agent 运行时。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run setup` | 安装三个子项目并构建 pi |
| `npm run dev` | 启动 YiW 桌面应用 |
| `npm run typecheck` | 检查前端 TypeScript |
| `npm run test:renderer` | 运行前端测试 |
| `npm run test:server` | 运行小程序与模块运行时测试 |
| `npm run build:renderer` | 构建桌面 Renderer |
| `npm run check` | 运行当前开源基线检查 |

## 设计文档

- [Agent 小程序运行时](docs/design/2026-07-22_agent-miniapp-runtime.md)
- [动态 UI 模块运行时](docs/design/2026-07-20_dynamic-ui-module-runtime.md)
- [Skill 产品固化](docs/design/2026-07-22_skill-product-solidification.md)
- [动态 UI 模块规格](docs/specs/2026-07-20_dynamic-ui-modules.md)
- [外部 Skill 产品化测试](docs/reports/2026-07-22_external-skill-product-test.md)

## 数据与安全

- 默认本地数据目录为 `~/.yiw/`。
- 不要提交 `.env`、模型密钥、数据库、日志、构建产物或个人配置。
- `server/scripts/init_local_db.mjs` 是可选的数据迁移脚本，连接信息只通过 `SRC_DB_*` 环境变量提供。
- 公开仓库不分发 VexDB 本地扩展二进制；未提供扩展时，相关检索会降级为关键词路径。
- KDD 等外部评测数据不进入仓库，需要通过 `YIW_KDD_ROOT` 指向用户有权使用的数据集。

安全问题请不要创建公开 Issue，请按 [SECURITY.md](SECURITY.md) 私下报告。

## 路线图

- [ ] 小程序包签名、来源校验和公开仓库。
- [ ] YiW 核心应用的正式打包与自动更新。
- [ ] 更丰富的小程序界面组件和稳定协议。
- [ ] 更严格的后端隔离、权限审计和资源限制。
- [ ] macOS、Windows 和 Linux 的完整发布验证。

## 参与开发

欢迎提交 Issue 和 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；重要的设计、规格和评测结果应同步写入 `docs/`。

## 许可证

除单独说明的第三方内容外，YiW 使用 [MIT License](LICENSE)。第三方代码和资源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

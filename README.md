# PI Desktop

[![CI](https://github.com/vibeinging/pi-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/vibeinging/pi-desktop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Upstream: earendil-works/pi](https://img.shields.io/badge/upstream-earendil--works%2Fpi-24292f?logo=github)](https://github.com/earendil-works/pi)

一个基于 [earendil-works/pi](https://github.com/earendil-works/pi) 的本地优先桌面 Agent 底座。

PI Desktop 把 Electron、React、本地 Node.js 后端、SQLite、模型配置、Skills、MCP 和本地工具放在同一个仓库里。你可以直接 fork 这个项目开发代码助手、文件助手或其他桌面 Agent，不必重新搭建窗口管理、进程通信、会话存储、工具审批和桌面打包。

> [!IMPORTANT]
> PI Desktop 是独立的社区项目，不是 `earendil-works/pi` 的官方桌面客户端。当前仍是开发者预览版：本地开发、核心 Agent 链路和 macOS arm64 目录打包已经验证，但还没有公开的正式安装包和自动升级。

## 与 pi 的关系

[pi](https://github.com/earendil-works/pi) 提供统一模型接口、Agent runtime、coding-agent 和工具调用基础。PI Desktop 在这些能力之上增加 Electron 桌面壳、React 界面、本地 SQLite 持久化、IPC、安全边界和桌面打包流程。

仓库固定使用 pi `v0.80.6`，来源 commit、本地修改和更新方法记录在 [Vendored pi 说明](server/vendor/README.md) 与 [第三方代码说明](THIRD_PARTY_NOTICES.md) 中。升级 pi 时会继续保留上游版权和 MIT 许可证。

## 已有能力

- 本地优先：桌面主链路不开放 HTTP，界面通过 Electron IPC 访问本地后端。
- 进程恢复：后端异常退出会立即结束等待请求，并按有限次数自动重启；界面会显示恢复状态。
- Agent 会话：支持流式回复、附件、上下文压缩、停止运行和历史恢复。
- 本地工作区：提供文件读取、搜索、编辑和 Shell 工具；写入与执行操作受确认控制。
- 模型配置：支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 及常见兼容接口；本地无鉴权接口可以不填 API Key。
- Skills 和 MCP：可以创建 Prompt Skill、接入使用 `stdio` 的 MCP Server，并按项目启用；Agent 通过 `use_skill` 激活 Skill，工具白名单由代码强制执行。
- 数据持久化：保留 `better-sqlite3`，用于项目、会话、消息、模型、Skills、MCP 和 Agent 运行记录。
- 桌面安全边界：启用 Electron sandbox、CSP、导航限制、IPC 来源校验和 Markdown/HTML 清洗。
- 可重复构建：提供统一 setup、检查、pi 构建和 Electron 隔离打包脚本。

## 当前验证状态

截至 2026-07-14，本机已通过：

- 37 个 Server 测试、15 个 Renderer 测试、10 个 Electron 测试和 2 个扩展示例测试。
- `npm run check`，包含配置与版本同步、Node/Renderer 静态检查、类型检查、全部测试和构建。
- macOS arm64 未签名目录包构建。
- 真实打包应用 smoke：加载 Renderer 和 preload，通过进程 IPC 启动本地 Server，使用本机假模型完成 pi Agent 首轮流式对话，并验证 SQLite、模型、Prompt Skill、MCP 配置、文本附件、后端重启恢复和删除清理。

Windows、Linux 和 macOS x64 的流程已经写入 GitHub Actions，但仍要以当前改动合并后的首次远端 CI 结果为准。

## 适合什么项目

PI Desktop 适合开发代码助手、文件助手、知识工作助手、内部工具 Agent，以及需要本地文件或命令能力的桌面应用。

它目前不是多用户服务端框架，也不适合直接暴露到公网。HTTP 入口只用于本机评测、CI 和明确开启的浏览器调试。

## 架构

```mermaid
flowchart LR
    UI["React 界面"] --> PRELOAD["Preload 白名单"]
    PRELOAD --> MAIN["Electron 主进程"]
    MAIN -->|进程 IPC| SERVER["本地 Node.js 后端"]
    SERVER --> APP["项目 / 会话 / 模型 / Skills / MCP"]
    APP --> AGENT["pi-agent 运行时"]
    APP --> DB["SQLite"]
    AGENT --> MODEL["模型服务"]
    AGENT --> TOOLS["本地工具 / MCP"]
    EVAL["Eval / CI"] -. 本机 HTTP .-> SERVER
```

IPC 和本机 HTTP 共用同一套路由和用例。桌面应用默认只启动 IPC；HTTP 仅监听 `127.0.0.1`。

更完整的进程、数据和打包说明见[架构文档](ARCHITECTURE.md)。

## 快速开始

环境要求：

- Node.js `>= 22.19.0`
- npm `>= 11.0.0`（CI 固定使用 `11.16.0`）
- macOS、Linux 或 Windows；当前完整打包验证以 macOS arm64 为主

```bash
git clone https://github.com/vibeinging/pi-desktop.git
cd pi-desktop
npm run setup
npm run dev
```

`npm run setup` 会分别安装 Server、Renderer 和 Electron 的锁定依赖，并构建缺失的 pi 运行文件。根目录不需要执行 `npm install`。

建议使用仓库 `.nvmrc` 或 `.node-version` 指定的 Node.js 版本。切换 Node 主版本后请重新运行 `npm run setup`，避免复用不兼容的 `better-sqlite3` 原生文件。

应用启动后：

1. 打开“设置 → 模型设置”，添加并测试一个主模型。
2. 新建对话，或创建工作区后开始任务。
3. 按需在设置中创建 Skills、接入 MCP Server。
4. 涉及文件修改或命令执行时，在确认窗口中检查操作内容。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run setup` | 安装三个子项目的依赖并准备 pi 运行文件 |
| `npm run dev` | 启动 Renderer、Electron 和本地后端 |
| `npm run test` | 运行 Server、Renderer、Electron 和扩展示例测试 |
| `npm run lint` | 检查 Renderer、Server、Electron、脚本和示例代码 |
| `npm run typecheck` | 运行 TypeScript 检查 |
| `npm run build` | 构建 vendored pi 和 Renderer |
| `npm run check` | 检查配置和版本同步，再运行 lint、类型检查、测试和构建 |
| `npm run package:dir` | 生成当前平台的未签名 Electron 应用目录 |
| `npm run smoke:package` | 启动当前平台目录包并运行完整 smoke |
| `npm run package` | 生成当前平台正式格式的安装包；签名由环境变量决定 |
| `npm run release:verify` | 检查版本、许可证、产物和发布前条件 |
| `npm run release:sbom` | 生成 Server、Renderer 和 Electron 的 SBOM |

依赖由 `server/package-lock.json`、`renderer/package-lock.json` 和 `electron/package-lock.json` 分别固定。修改依赖后，请提交对应 lockfile。

## 打包桌面应用

```bash
npm run setup
npm run package:dir
```

打包脚本会：

1. 构建 Renderer 和 vendored pi。
2. 在一次性的 `staging/` 中安装 Server 生产依赖。
3. 使用 `@electron/rebuild` 为当前 Electron ABI 重编 `better-sqlite3`。
4. 将应用目录写入 `release/`。

它不会修改开发目录里的 `server/node_modules`，因此系统 Node.js 和 Electron 可以分别使用正确的原生模块。

PR 合并到 `main` 后，push CI 会在 macOS、Windows 和 Linux 生成 unpacked 应用，并通过真实 Electron 和本机假模型验证 Renderer、preload、pi Agent 首轮流式对话、内置 Server IPC、SQLite 写入、模型/Prompt Skill/MCP 配置、文本附件、后端重启恢复和删除清理。只能在同一提交回归成功后打 tag；正式 tag workflow 会再次检查合并与回归结果，再生成签名安装包、校验和、SBOM 和 Draft Release。密钥要求与回滚方法见 [发布手册](docs/reports/2026-07-13_release-guide.md)。

正常发布顺序固定为：合并到 `main` → 三平台回归 → 人工回归 → 打 tag → 出包 → 安装验收 → 公开 Release。不要先打 tag 再补回归。

## 在底座上开发

| 扩展内容 | 推荐位置 |
| --- | --- |
| 后端用例 | `server/src/app/` |
| API 注册 | `server/src/transport/registry*.js` |
| Agent、工具和运行时组合 | `server/src/engine/` |
| 页面 | `renderer/src/views/` |
| 公共组件 | `renderer/src/components/` |
| 路由 | `renderer/src/router/routes.tsx` |
| 通用外部工具 | MCP |
| 提示词和流程能力 | Skills |

产品名、App ID、URL 协议、数据目录、图标、默认语言、主题、系统提示词和默认工具统一写在 [`app.config.json`](app.config.json)。修改后运行 `npm run config:generate`，CI 会检查 Electron、Server、Renderer 和启动页生成文件是否同步。

如果只是开发一个自己的桌面 Agent，建议先修改 `app.config.json` 完成品牌和默认能力配置，再从项目笔记助手示例复制一个最小业务模块。这样可以保留底座的进程恢复、SQLite、权限和发布流程，减少直接修改核心层的范围。

业务逻辑不要直接写进 IPC 或 HTTP 层。新增文件、Shell 或 MCP 能力时，需要说明权限范围、取消方式和输出上限，并增加对应测试。

当前稳定版本只支持 Prompt Skill。Service 和 Workflow 尚未定义可靠的执行协议，Server 会拒绝保存这两种类型。Skill 的 `allowed_tools` 会在工具执行前检查；空名单表示不增加限制，`mcp_*` 表示允许当前项目启用的全部 MCP 工具。

`server/vendor/pi/` 固定了当前使用的 pi 版本。不要直接覆盖该目录；升级步骤和本地修改见 [server/vendor/README.md](server/vendor/README.md)。

新增一个后端能力时，最短流程是：

1. 在 `server/src/app/<feature>/` 编写不依赖 IPC 或 HTTP 的用例。
2. 在 `server/src/transport/registry.<feature>.js` 注册方法和路径，再合并到 `registry.js`。
3. 在 `server/test/` 增加成功、失败和取消场景测试；Renderer 通过 API 适配层调用。

完整的 Server、路由、SQLite 迁移、Renderer 页面、Prompt Skill、stdio MCP 和测试可以直接参考 [项目笔记助手示例](examples/project-notes-assistant/README.md)。

## 数据与安全

默认本地数据：

```text
~/.pi-desktop/local.db   项目、会话权威历史、Agent 上下文投影和配置
~/.pi-desktop/projects/  工作区文件
```

Electron 的窗口设置、网络设置和加密凭据文件保存在操作系统分配的应用数据目录。模型密钥和 MCP 敏感环境变量不会写入 `local.db`。

`session_messages` 是会话权威历史，供用户查看；Agent transcript 是带版本基线、可以从权威历史恢复的上下文投影，供模型保留工具调用和压缩结果。同一会话的 Agent、压缩和删除会串行执行。老版本的 `~/.pi-desktop/agent-sessions/*.jsonl` 会在首次打开对应会话时导入 SQLite，并改名为 `.migrated`，运行时不再写 JSONL。会话 transcript 也可通过服务端导出接口保存为 JSONL。

测试和自动化请设置 `PI_DB_PATH`，避免读写个人数据库。

模型密钥和 MCP 环境变量通过 Electron `safeStorage` 加密后保存在本地凭据文件中，SQLite 只保存 `credential:*` 引用，Renderer 不会得到明文。旧版数据库中的明文会在桌面后端启动时迁移；Linux 必须提供 Secret Service，`basic_text` 后端会被拒绝。不要把密钥写进仓库。

安全问题请阅读 [SECURITY.md](SECURITY.md)，不要直接公开包含利用细节的 Issue。

## 浏览器调试本地 HTTP

桌面开发一般不需要 HTTP。只有独立启动后端或设置 `PI_TCP=1` 时，服务才会监听 `127.0.0.1`。浏览器访问必须同时配置允许来源和本地令牌：

```bash
PI_TCP=1 \
PI_ALLOWED_ORIGINS=http://127.0.0.1:52731 \
PI_HTTP_TOKEN=replace-with-a-long-random-value \
npm --prefix server start
```

另一个终端启动浏览器调试页：

```bash
VITE_PI_HTTP_TOKEN=replace-with-the-same-value \
npm --prefix renderer run dev
```

浏览器打开 `http://127.0.0.1:52731`。不要提交令牌，也不要把 `PI_ALLOWED_ORIGINS` 设置为任意来源。

## 当前限制

- 当前是 `0.1.0` 开发者预览版，扩展接口和数据库结构还没有进入稳定兼容期。
- MCP 当前只支持 `stdio` transport。
- Skill 当前只支持 Prompt 类型；Service 和 Workflow 会被 Server 拒绝。
- 安装包级自动测试尚未覆盖工具确认与拒绝、Skill 实际激活和真实 MCP 工具调用；发布前仍需人工回归。
- macOS、Windows 和 Linux 的打包流程已配置，但仍需在合并后的同一提交上完成首次远端验证。
- 正式安装包、代码签名和公证需要发布密钥并通过首个 tag workflow；自动升级尚未实现。
- Renderer 主包仍需继续拆分和减小体积。

## 项目目录

```text
electron/       Electron 主进程、preload 和打包配置
renderer/       React 界面
server/         本地后端、SQLite 和 Agent 运行时
server/vendor/  固定版本的 pi 源码与第三方许可
eval/           本地评测和调试工具
examples/       可运行的扩展示例
scripts/        setup、检查、打包、smoke 和发布脚本
docs/           规格、设计、发布手册和检查报告
```

## 文档

- [架构与扩展点](ARCHITECTURE.md)
- [参与开发](CONTRIBUTING.md)
- [安全说明](SECURITY.md)
- [MIT 许可证](LICENSE)
- [第三方代码说明](THIRD_PARTY_NOTICES.md)
- [发布手册](docs/reports/2026-07-13_release-guide.md)
- [公开发布检查](docs/reports/2026-07-13_public-release-check.md)

## 许可证

除单独说明的第三方内容外，PI Desktop 采用 [MIT License](LICENSE)。Vendored pi 也使用 MIT 许可证，但继续保留上游作者的版权和许可证副本；其他第三方内容见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

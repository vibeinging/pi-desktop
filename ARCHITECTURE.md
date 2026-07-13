# PI Desktop 架构

## 目标

PI Desktop 是单机、单用户的 Agent 桌面底座。桌面主路径不启动 HTTP 服务，渲染层通过 Electron IPC 调用本地 Node 后端；HTTP 只用于 eval、CI 和明确开启的浏览器调试。

## 进程和数据流

```text
React renderer
    │ electronAPI（preload 白名单）
    ▼
Electron main
    │ process IPC
    ▼
server transport/ipc_server
    │ registry → use case
    ▼
projects / sessions / models / skills / MCP / chat
    │
    ├── SQLite: ~/.pi-desktop/local.db
    ├── project files: ~/.pi-desktop/projects/
    └── pi runtime: server/vendor/pi/*
```

独立后端路径把相同的 registry 和用例包在 loopback HTTP 上：

```text
eval / CI / browser debugging
    → 127.0.0.1 HTTP
    → transport/http_server
    → same registry and use cases
```

浏览器访问需同时通过 `PI_ALLOWED_ORIGINS` 和 `PI_HTTP_TOKEN`。无 `Origin` 的本机进程请求用于 curl、eval 和 CI，不走浏览器跨域分支。

## 分层

### Electron

`electron/main.js` 管理窗口、本地后端进程、文件选择、窗口状态和网络设置。`electron/preload.js` 是渲染层能访问的原生能力边界。新增能力时应在主进程完成输入校验，只暴露最小 IPC 接口。

### Renderer

`renderer/src/` 包含 React 页面、状态和 API 适配。页面不应直接访问 Node.js。所有本地能力通过 preload 暴露的接口调用。

### Transport

`server/src/transport/registry*.js` 是接口清单。IPC 与 HTTP 共享相同的 router、输入格式、返回信封和用例，因此业务逻辑不应写进某一种传输实现。

### Application 和 Engine

`server/src/app/` 负责项目、会话、消息、模型、Skills 和 MCP 等用例。`server/src/engine/` 负责 Agent 循环、模型调用、工具组合和运行时状态。

### Storage

`server/src/db.js` 封装 `better-sqlite3`，`server/db/schema.sql` 定义新库结构。数据库使用 `PRAGMA user_version` 按顺序执行迁移；迁移失败会回滚且不推进版本。会话消息的序号分配、插入和计数更新在同一个 `BEGIN IMMEDIATE` 事务中完成。修改结构时必须同时增加新库 schema、旧库迁移和失败回滚测试。

### Vendored pi

`server/vendor/pi/` 固定 [earendil-works/pi](https://github.com/earendil-works/pi) v0.80.6 的四个包，构建产物不入 Git。`server/scripts/ensure_pi_build.mjs` 根据源码和配置时间判断是否需要重建。PI Desktop 是独立项目；来源、修改、许可证和更新步骤见 [server/vendor/README.md](server/vendor/README.md)。

## Electron 打包布局

`npm run package:dir` 先构建 renderer 和 vendored pi，再创建一次性的 `staging/server`：

```text
PI Desktop.app/Contents/Resources/
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── third_party/licenses/
├── app.asar
│   ├── electron/main.js + preload.js
│   └── renderer/dist/
└── server/
    ├── src/ + db/
    ├── node_modules/            # Electron ABI 的 better-sqlite3
    ├── vendor/pi/*/package.json + dist/
    └── vendor/licenses/ + THIRD_PARTY_NOTICES.md
```

后端放在 `app.asar` 外并从 `process.resourcesPath/server` 启动，原生模块可直接加载。Electron 壳与 renderer 留在 `app.asar`。打包过程只在 `staging/server` 安装和重编依赖，不修改开发目录的 `server/node_modules`。

`electron-builder` 默认会过滤 `extraResources` 内的 `node_modules`，因此 `electron/after-pack.cjs` 在签名前把 staging 的生产依赖补入包内，并检查 `better_sqlite3.node` 确实存在。发布内容不会复制 vendored pi 的源码、测试、示例或 DOOM 示例二进制。

## 扩展规则

### 新增后端能力

1. 在 `server/src/app/` 增加无传输依赖的用例。
2. 在相应 `registry.*.js` 注册方法、路径和处理函数。
3. 同时测试普通返回、错误和取消；流式能力使用统一事件协议。
4. Renderer 只通过 API 适配层调用。

### 新增 Agent 工具

通用外部能力优先接入 MCP；可移植的提示词和流程优先接入 Skills。必须直接增加本地工具时，要声明文件和命令权限、取消行为、输出上限与审计信息。

### 新增页面

页面放在 `renderer/src/views/`，公共组件放在 `renderer/src/components/`。路由在 `renderer/src/router/routes.tsx` 集中注册。避免让业务页面直接了解 Electron 主进程的实现细节。

## 当前边界

- 产品是单机、单用户，不是多租户服务器。
- HTTP 是调试接口，不是远程部署接口。
- 扩展接口和数据库结构尚未进入稳定兼容期。
- 已有未签名应用目录构建；尚无正式安装包、代码签名、公证和升级通道。
- 模型密钥与 MCP 环境变量尚未接入系统凭据存储。

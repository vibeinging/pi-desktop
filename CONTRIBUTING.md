# 参与开发

## 准备环境

需要 Node.js `>= 22.19.0` 和 npm `>= 11.0.0`。CI 当前固定使用 npm `11.16.0`。

```bash
npm run setup
npm run dev
```

依赖分别由 `server/package-lock.json`、`renderer/package-lock.json` 和 `electron/package-lock.json` 固定。修改依赖后要提交对应 lockfile。

仓库提供 `.nvmrc` 和 `.node-version`。切换 Node 主版本后要重新运行 `npm run setup`，避免 `better-sqlite3` 原生文件与当前 Node ABI 不一致。

## 开发原则

- 通用底座不引入具体行业业务。
- 业务用例与 IPC/HTTP 传输分开。
- Renderer 不直接访问 Node.js，只使用 preload 允许的能力。
- 先扩展 Skills 或 MCP，再考虑改 vendored pi。
- 不提交数据库、日志、模型密钥、MCP 密钥、构建产物和个人配置。
- 不在提交信息中加入工具或 AI 模型署名。

推荐分支前缀：`feature/`、`fix/`、`docs/`、`chore/`、`refactor/`。

## 贡献许可证

除单独说明的第三方内容外，本项目采用 [MIT License](LICENSE)。提交贡献表示你有权提供这些内容，并同意按 MIT 许可证分发。

## 提交前检查

```bash
npm run check
```

至少覆盖本次修改所在层。涉及 Electron IPC、数据库迁移、流式事件、取消操作或本地工具权限时，需要增加针对性的自动测试或可重复 smoke 记录。

Server、Electron、根脚本和示例使用 `npm run lint:node` 检查未定义变量、不可达代码、重复声明和常见控制流错误；Renderer 继续使用 TypeScript 和 ESLint。不要只运行 Renderer 检查。

## 修改品牌和默认能力

只修改根 [`app.config.json`](app.config.json)，然后运行：

```bash
npm run config:generate
npm run config:check
```

生成的 Electron、Server、Renderer 配置和 `renderer/index.html` 需要一起提交，不要手改生成文件。端到端扩展可参考 [项目笔记助手示例](examples/project-notes-assistant/README.md)。

## 修改数据库

- 同时考虑新数据库和已有数据库。
- 迁移必须可重复执行，失败不能留下半完成状态。
- 说明索引、唯一约束、外键和旧数据的处理方式。
- 测试升级前后的读取和写入。

## 修改 vendored pi

不要直接覆盖 `server/vendor/pi/`。先阅读 [server/vendor/README.md](server/vendor/README.md)，并对照 [earendil-works/pi](https://github.com/earendil-works/pi) 记录上游 tag、commit、本地修改和许可证变化。`server/vendor/pi/**/dist/` 是可再生文件，不进入 Git。

## 安全相关修改

涉及 Markdown/HTML、preload、文件系统、Shell、MCP、模型密钥、HTTP 调试接口或依赖来源时，请在变更说明中写清输入是否可信、权限边界和失败方式。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 文档

对架构、计划、评审和重要分析的修改，应同步更新根文档或 `docs/` 下相应记录，确保文档和当前代码一致。

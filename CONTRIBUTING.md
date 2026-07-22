# 参与开发

## 准备环境

需要 Node.js `>= 26.3.0` 和 npm `>= 11.16.0`。

```bash
npm run setup
npm run dev
```

依赖分别由 `server/package-lock.json`、`renderer/package-lock.json` 和 `electron/package-lock.json` 固定。切换 Node 主版本后请重新运行 `npm run setup`，避免复用不兼容的原生模块。

## 开发原则

- 产品逻辑放在 Server 用例和 Renderer 页面中，不直接写进 IPC 或 HTTP 层。
- 小程序必须声明权限、数据范围、页面入口和版本；安装前必须通过结构与权限检查。
- Skill 是可选需求模板，不要强制让所有小程序绑定 Skill。
- 新增可写工具、Shell、文件、MCP 或远程能力时，需要说明权限、取消方式和输出上限。
- 不提交数据库、业务评测数据、日志、模型密钥、环境文件、构建产物和个人配置。
- 不在提交信息中加入工具或 AI 模型署名。

推荐分支前缀：`feature/`、`fix/`、`docs/`、`chore/` 和 `refactor/`。

## 提交前检查

```bash
npm run check
```

至少运行本次修改所在层的测试。涉及数据库迁移、权限、流式事件、小程序升级或 Agent 工具调用时，需要增加成功、失败和取消场景。

## 文档

重要分析、设计、规格、计划和测试报告放在 `docs/` 对应目录，并保持文档与当前代码一致。

## 贡献许可证

除单独说明的第三方内容外，提交贡献表示你有权提供这些内容，并同意按项目的 MIT 许可证分发。

# PI Desktop 公开发布检查

- 更新日期：2026-07-13
- 检查范围：当前 Git 跟踪文件、构建输入和公开仓库入口

## 结论

PI Desktop 当前定位为通用的 pi-agent 桌面应用底座，保留 Electron、React、本地 Server、SQLite、模型配置、Skills、MCP、附件、工具调用和会话历史等基础能力。

项目可以作为技术预览供开发者审阅和继续开发。根许可证尚未确定，因此当前不能描述为已经完成开源授权的稳定版本。

## 已检查

- README、架构、贡献、安全和第三方代码说明只描述当前项目。
- 发布内容不包含内部计划、过程记录、本地数据库、日志、构建产物和测试输出。
- 应用名称、包名、协议、数据目录、环境变量和界面内部标识统一使用 PI Desktop 或通用 Agent 命名。
- `better-sqlite3` 继续用于项目、会话、消息、模型、Skills、MCP 和 Agent run 持久化。
- JSON Schema、模型结构化输出、MCP input schema 和 embedding 属于通用 Agent 能力，继续保留。
- vendored pi 的来源、版本、本地修改和 MIT 许可证副本已经记录。
- macOS、Windows 和 Linux CI 会从空 checkout 执行依赖安装和完整检查。

## 本地验证

```bash
npm run setup
npm run check
npm run package:dir
```

检查范围包括 Server 测试、Renderer 测试、TypeScript、ESLint、Renderer 构建和 Electron 目录打包。

## 发布前仍需完成

1. 确认仓库代码、界面和素材的权属，增加根 `LICENSE` 和版权信息。
2. 生成正式安装包，补齐签名、macOS 公证和发布验证。
3. 将模型与 MCP 密钥接入系统凭据存储。
4. 继续减少 Renderer 主包体积，并处理现有 Fast Refresh 警告。

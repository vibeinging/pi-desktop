# 更新记录

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### Added

- Skill 工具白名单在执行前由代码强制检查。
- SQLite Agent transcript、旧 JSONL 一次迁移、导出和删除清理。
- 后端 IPC 超时、失败返回、ready 握手和有限自动重启。
- 基于 Electron `safeStorage` 的模型与 MCP 凭据存储。

### Changed

- Skill 稳定运行类型收敛为 Prompt。
- 根项目、Server、Renderer 和 Electron 统一使用版本 `0.1.0`。

## [0.1.0] - 2026-07-13

- 首个可公开使用的 PI Desktop 底座版本。

[Unreleased]: https://github.com/vibeinging/pi-desktop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vibeinging/pi-desktop/releases/tag/v0.1.0

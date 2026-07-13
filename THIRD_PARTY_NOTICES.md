# 第三方代码说明

本文记录仓库中直接保存源码或二进制文件的主要第三方项目。npm 间接依赖的完整清单以各目录的 `package-lock.json` 为准。

## pi

- 项目：https://github.com/earendil-works/pi
- 版本：`v0.79.6`
- Commit：`31bfb2f16f7a1dd707876e970f0f80caa61f8435`
- 作者：Mario Zechner 及贡献者
- 许可证：MIT
- 本地位置：`server/vendor/pi/{tui,ai,agent,coding-agent}`
- 许可证副本：`server/vendor/licenses/pi-MIT.txt`

本仓库相对该 tag 的有意义修改：

1. `ai/src/providers/openai-completions.ts` 增加 OpenAI 兼容接口、DashScope 等返回格式中的缓存读写 token 解析，并增加对应测试。
2. `coding-agent/package.json` 将其直接依赖 `undici` 从 `8.3.0` 调整为 `8.7.0`。
3. 各包 changelog 增加 `Unreleased` 标题；部分文档和脚本仅清理行尾空格，不改变行为。

构建所需的上游根 `tsconfig.base.json` 复制到 `server/vendor/tsconfig.base.json`。详细更新方法见 `server/vendor/README.md`。

## doomgeneric / DOOM 示例（已排除）

上游 `pi-coding-agent` 的示例目录包含：

- `server/vendor/pi/coding-agent/examples/extensions/doom-overlay/doom/build/doom.js`
- `server/vendor/pi/coding-agent/examples/extensions/doom-overlay/doom/build/doom.wasm`

上游说明这些文件由 [doomgeneric](https://github.com/ozkl/doomgeneric) 构建。doomgeneric 使用 GPL-2.0 许可证。

本项目通过根 `.gitignore` 排除整个 `doom-overlay` 示例和对应图片，打包脚本也不会复制 vendor 示例、测试或源码。因此这些文件不进入本项目 Git 提交或安装包。

如果以后需要恢复该示例，必须先补齐对应源码、版权声明和 GPL-2.0 许可证，并重新审查分发方式。

DOOM WAD 不在本项目中。

## 说明

本文件不是法律意见。添加、升级或移除第三方代码时，应同步更新本文件并重新检查许可证。

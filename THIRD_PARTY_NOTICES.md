# 第三方代码说明

本文记录仓库中直接保存源码或二进制文件的主要第三方项目。npm 间接依赖的完整清单以各目录的 `package-lock.json` 为准。

由 PI Desktop contributors 持有版权的内容使用根目录的 [MIT License](LICENSE)。第三方内容继续保留各自的版权和许可证。项目基于 [earendil-works/pi](https://github.com/earendil-works/pi) 构建，但不是其官方桌面客户端。

## pi

- 上游项目：https://github.com/earendil-works/pi
- 版本：`v0.80.6`
- Commit：`2b3fda9921b5590f285165287bd442a25817f17b`
- 作者：Mario Zechner 及贡献者
- 许可证：MIT
- 本地位置：`server/vendor/pi/{tui,ai,agent,coding-agent}`
- 许可证副本：`server/vendor/licenses/pi-MIT.txt`

本仓库相对该 tag 的有意义修改：

1. `ai/src/api/openai-completions.ts` 增加 OpenAI compatible、DashScope 等返回格式中的缓存读写 token 解析，并增加对应测试；上游新增的 reasoning token 统计保持不变。
2. `coding-agent/package.json` 将其直接依赖 `undici` 从上游 `8.5.0` 调整为 `8.7.0`，对应 shrinkwrap 同步更新。

构建所需的上游根 `tsconfig.base.json` 复制到 `server/vendor/tsconfig.base.json`。详细更新方法见 `server/vendor/README.md`。

## vue-element-admin 资源

- 上游项目：https://github.com/PanJiaChen/vue-element-admin
- 核对 Commit：`6858a9ad67483025f6a9432a926beb9327037be3`
- 版权：Copyright (c) 2017-present PanJiaChen
- 许可证：MIT
- 本地位置：`renderer/src/assets/401_images/`、`renderer/src/assets/404_images/`，以及 `renderer/src/icons/common/`、`renderer/src/icons/nav-bar/` 中从上游复制或改名的 SVG
- 许可证副本：`third_party/licenses/vue-element-admin-MIT.txt`

这些资源用于通用错误页和界面图标。即使文件经过改名，分发时也必须保留上游版权声明和 MIT 许可证。

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

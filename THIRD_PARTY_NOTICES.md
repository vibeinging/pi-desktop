# 第三方代码说明

本文记录仓库中直接保存源码或资源的主要第三方项目。npm 依赖的完整清单以各目录的 `package-lock.json` 为准。

## earendil-works/pi

- 上游项目：https://github.com/earendil-works/pi
- 版本：`v0.80.6`
- 作者：Mario Zechner 及贡献者
- 许可证：MIT
- 本地位置：`server/vendor/pi/{tui,ai,agent,coding-agent}`
- 许可证副本：`server/vendor/licenses/pi-MIT.txt`

YiW 对 vendored pi 有本地适配。升级时需要保留上游版权、许可证和本地改动说明。

## vue-element-admin 资源

- 上游项目：https://github.com/PanJiaChen/vue-element-admin
- 版权：Copyright (c) 2017-present PanJiaChen
- 许可证：MIT
- 本地位置：`renderer/src/assets/401_images/`、`renderer/src/assets/404_images/` 和部分通用 SVG 图标
- 许可证副本：`third_party/licenses/vue-element-admin-MIT.txt`

## 未随公开源码分发的内容

- VexDB 本地扩展二进制没有进入公开仓库。用户只能在确认自己拥有使用和分发权后，通过 `VEXDB_EXT_PATH` 自行提供。
- vendored pi 中的 `doom-overlay` 示例和相关图片没有进入公开仓库，避免把 GPL 示例混入默认 MIT 源码快照。
- KDD 和证券业务评测数据没有进入公开仓库，需要由使用者自行提供有权使用的数据集。

本文不是法律意见。增加或升级第三方代码时，应同步更新本文件。

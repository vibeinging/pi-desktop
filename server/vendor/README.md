# Vendored pi

PI Desktop 保存 pi 源码，是为了让桌面运行时可固定版本、可审查，并允许少量必须的 provider 兼容修改。构建产物 `server/vendor/pi/**/dist/` 不进入 Git。

## 当前来源

- 上游：https://github.com/earendil-works/pi
- Tag：`v0.80.6`
- Commit：`2b3fda9921b5590f285165287bd442a25817f17b`
- 包：`tui`、`ai`、`agent`、`coding-agent`
- 许可证：MIT，副本位于 `server/vendor/licenses/pi-MIT.txt`

上游仓库根目录的 `tsconfig.base.json` 被复制为 `server/vendor/tsconfig.base.json`。四个包的 `tsconfig.build.json` 通过 `../../tsconfig.base.json` 读取它。

## 本地修改

语义修改只有两组：

1. `pi/ai/src/api/openai-completions.ts` 扩展 OpenAI compatible、DashScope 等接口的缓存读写 token 兼容字段，并增加测试。补丁保留上游的 reasoning token 统计。
2. `pi/coding-agent/package.json` 的 `undici` 版本从上游 `8.5.0` 调整为 `8.7.0`，对应 `npm-shrinkwrap.json` 同步更新。

完整说明见根目录 `THIRD_PARTY_NOTICES.md`。

## 更新步骤

1. 在临时目录检出明确的上游 tag，并记录 commit：

   ```bash
   git clone https://github.com/earendil-works/pi.git /tmp/pi-upstream
   git -C /tmp/pi-upstream checkout <tag>
   git -C /tmp/pi-upstream rev-parse HEAD
   ```

2. 检查上游 `LICENSE`、四个包的依赖和示例中附带的二进制文件。特别检查 `coding-agent/examples/extensions/doom-overlay/`。

3. 复制 `packages/{tui,ai,agent,coding-agent}` 和根 `tsconfig.base.json`，排除 `.git`、`node_modules` 和 `dist`。

4. 重新应用并复查本地语义修改。缓存补丁位于 `ai/src/api/openai-completions.ts`；不要只按文件整体覆盖，否则会静默丢失 provider 兼容逻辑或上游新增的 reasoning 统计。

5. 更新本文件、`THIRD_PARTY_NOTICES.md`、pi MIT 许可证副本、server lockfile 和 coding-agent shrinkwrap。

6. 比较源码：

   ```bash
   for package in tui ai agent coding-agent; do
     diff -qr --exclude dist --exclude node_modules \
       /tmp/pi-upstream/packages/$package server/vendor/pi/$package
   done
   ```

7. 从无 `dist` 的状态验证：

   ```bash
   npm --prefix server ci
   npm --prefix server run ensure:pi
   npm --prefix server test
   ```

8. 在根目录运行 `npm run check`。

升级时不要提交生成的 `dist`，也不要在未完成许可证检查时删除或忽略第三方文件。

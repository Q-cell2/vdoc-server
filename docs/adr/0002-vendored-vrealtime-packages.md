# ADR 0002：在 npm 发布前固定使用 vendored 的 vRealTime 包

状态：已废弃（2026-10-17）。`@vrealtime/*@0.1.0` 已发布到 npm（vRT 标签 `v0.1.0`，包含 PR #21），依赖改为 npm 上的固定版本，`vendor/` 已删除（#6）。

## 背景

`@vrealtime/*` 还没有发布到 npm。vdoc-server 需要的鉴权（`authenticate`/`configure`）、客户端工具的 `turnId` 等能力在 austinchennn/vRT 的 PR #21 中。CI 访问不到本地文件夹。

## 决定

把 vRT 构建出的 tarball 放进 `vendor/vrealtime/`，只有用到它的包用 `file:` 依赖引用，传递依赖通过根 `package.json` 的 `overrides` 指向同一批 tarball。来源提交记录在 `vendor/vrealtime/README.md`。

## 结果

- 构建可复现，CI 不依赖外部仓库。
- 只有 `adapter-vrt` 和应用入口依赖 vRT；领域层和应用层完全不知道 vRT。
- 升级时需要重新打包并替换 tarball；npm 发布后改成普通版本号依赖即可。

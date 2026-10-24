# ADR 0001：整洁架构 + 领域驱动设计，按层分包

状态：已采纳（2026-10-16）

## 背景

vdoc-server 要长期演进：模型供应商会变（Boson、OpenAI、cascade），运行环境不止一个（Node、Cloudflare Workers），鉴权方式会从 API key 发展到用户登录，策略规则会越来越多。

## 决定

- 领域模型按四个限界上下文组织（Access、Voice Session、Agent Profile、Tool Governance），零依赖。
- 用例放在应用层，只通过端口接口访问外部世界。
- 每个外部技术一个适配器包，适配器之间互不依赖。
- 一个组合根包负责装配，各运行时只提供差异部分（存储、socket）。
- 依赖方向由包清单和 `scripts/check-architecture.mjs` 在 CI 中强制执行。

## 结果

- 领域和用例可以在没有网络、没有 vRT 的情况下完整测试。
- 换模型、换存储、换运行时都是新增适配器，不改核心。
- 代价是包的数量较多；每个包都很小，职责单一。

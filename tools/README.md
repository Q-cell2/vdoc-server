# Document tools

24 个 vRT 客户端工具，按 reading、text、formatting、blocks、tables、history 分类。
每个文件独立提供工具工厂、模型参数 Schema 和 run；index.ts 提供批量组装。

```ts
import { createDocumentTools } from './tools';

const tools = createDocumentTools(host);
const session = await connect(realtimeUrl, { auth, tools });
```

host 实现 core.ts 的 DocumentToolHost；将读取、操作提交和撤销接入真实编辑器。
此目录提供可执行的工具适配层，不包含编辑器，也不自动注册到当前 server。

- 写操作要求 expectedSessionId 和 expectedRevision；target 必须显式指定，不能依赖变化中的选区。
- 文本、格式、移动和表格工具转换为 vdoc 已有 operation；applyOperations 收到 id=callId、版本和单个 operation。
- searchText/listOutline/duplicateBlock 也是独立 host 能力：vdoc 没有对应 operation。replace_all 映射到 text.findReplace（作用于全文，target 仅为满足显式 target 要求）。
- insertBlock/deleteBlock 是独立 host 能力：当前相邻 vdoc operation schema 没有 block.insert/block.delete，不能伪造这两种 operation。
- host 必须原子校验版本、在提交前检查 signal，并按 callId 去重；context.turnId 用于撤销归组。
- applyOperations 可在 host 内调用 editor.executeAgent(request, { actor, turnId: context.turnId })，actor 由宿主的可信身份提供，不能让模型填写。
- undoTurn 必须校验调用方只能撤销自己的修改。
- 工具保留 host 的错误结果，不自动重试有副作用的写入。
- 样式工具提供常用样式字段；参数 Schema 和本地校验保持一致。
- 当前服务端白名单、风险规则未改；接入新名称前需要另行配置授权和风险等级。

验证：

```sh
npx vitest run --config tools/vitest.config.ts
npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --skipLibCheck tools/index.ts tools/tools.test.ts
```

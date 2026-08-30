# 第三方开源组件引用登记（THIRD-PARTY-NOTICES）

> 开源引用礼仪：本插件打包了以下 MIT 许可的第三方组件（源码级内联进
> `dist/index.js` 单文件 bundle），在此逐一登记署名与许可全文位置。
> 8/30 re18b 引入（3D 知识图谱，对齐 QwenPaw 2.2 知识库同款引擎与版本）。

## 组件清单

| 组件 | 版本 | 许可 | 版权 | 用途 |
|------|------|------|------|------|
| three.js | 0.185.1 | MIT | © 2010-2026 three.js authors | WebGL 渲染（3D 图场景/相机/光照/雾效） |
| 3d-force-graph | 1.80.0 | MIT | © 2017 Vasco Asturiano | 3D 力导向布局 + orbit 交互（缩放/拖拽/旋转） |
| three-spritetext | 1.10.0 | MIT | © 2018 Vasco Asturiano | 3D 节点文字标注（SpriteText） |
| lucide（图标路径） | 2026-08 快照 | ISC | © lucide contributors | 工具执行安全四模式图标（Ban/AlertTriangle/Shield/CircleCheck，路径内联 SVG，零运行时依赖，5.0.0-beta.4 引入） |

版本与 QwenPaw 2.2 官方控制台 `console/package.json` 完全一致
（行为对齐基准），上游源码：
- https://github.com/mrdoob/three.js
- https://github.com/vasturiano/3d-force-graph
- https://github.com/vasturiano/three-spritetext

## 许可文本

三个组件均为 MIT License，完整许可文本见各自 node_modules 包内
`LICENSE` 文件（构建环境留存）；MIT 许可核心条款（授权+免责声明）
与 three.js LICENSE 首段一致，此处不重复全文。

## 说明

- 上述代码以编译产物形式内联于 `dist/index.js`，非独立分发文件。
- 3D 图谱 UI 在卡片内标注引擎出处（「引擎：3d-force-graph (MIT) +
  three.js (MIT)」）。
- 2D 图谱为插件自研 SVG 力导向实现，无第三方依赖。
- 工具执行安全四模式图标 = QwenPaw 官方控制台 ToolExecutionLevelCard
  同款 lucide 图标（官方用 lucide-react 组件，本插件内联等价 SVG 路径，
  ISC 许可，上游 https://github.com/lucide-icons/lucide）。
- 5.0.0-beta.2 知识图谱详情面板（已索引文件/未解析链接/分类根 状态徽章
  + 出链 · n / 入链 · n 可跳转列表 + 打开 Markdown + 节点 description）：
  交互结构移植自 QwenPaw 开源项目（https://github.com/agentscope-ai/QwenPaw）
  files-workspace 的 MemoryGraphView 详情面板
  （console/src/features/files-workspace/MemoryGraphView.tsx）；
  数据源为插件自有 /kb/{agent}/graph 后端，非 QwenPaw 运行时依赖。

# 第三方开源组件引用登记（THIRD-PARTY-NOTICES）

> 开源引用礼仪：本插件将以下第三方组件**源码级内联**进 `dist/index.js`
> 单文件 bundle 一并分发，在此逐一登记版本、版权与许可，并附许可全文。
>
> 组件清单经 2026-08-30 构建依赖全量核验（`frontend/package.json`
> dependencies × bundle 内联标记 × 前端源码 import 面三方交叉）。

## 组件清单

| 组件 | 版本 | 许可 | 版权 | 用途 | 上游 |
|------|------|------|------|------|------|
| three.js | 0.185.1 | MIT | © 2010-2026 three.js authors | WebGL 渲染（3D 知识图谱场景/相机/光照/雾效） | [mrdoob/three.js](https://github.com/mrdoob/three.js) |
| 3d-force-graph | 1.80.0 | MIT | © 2017 Vasco Asturiano | 3D 力导向布局 + orbit 交互（缩放/拖拽/旋转） | [vasturiano/3d-force-graph](https://github.com/vasturiano/3d-force-graph) |
| three-spritetext | 1.10.0 | MIT | © 2018 Vasco Asturiano | 3D 节点文字标注（SpriteText） | [vasturiano/three-spritetext](https://github.com/vasturiano/three-spritetext) |
| fflate | 0.8.3 | MIT | © 2026 Arjun Barrett | xlsx 文件预览（zlib inflate 解包，替代 400KB 级 SheetJS 重依赖） | [nodeca/fflate](https://github.com/nodeca/fflate) |
| lucide（图标路径数据） | 2026-08 快照 | ISC | © lucide contributors | 工具执行安全四档图标（Ban / AlertTriangle / Shield / CircleCheck，SVG 路径数据内联，零运行时依赖） | [lucide-icons/lucide](https://github.com/lucide-icons/lucide) |

**版本对齐说明**：three.js / 3d-force-graph / three-spritetext 三件与
QwenPaw 2.2 官方控制台 `console/package.json` 完全一致（3D 知识图谱行为
对齐基准，上游为 [agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw)）。

## 分发形态说明

- 上述代码以**编译产物**（minified）形式内联于 `dist/index.js`，非独立
  分发文件。宿主 blob-URL 加载环境不支持动态 import，故静态内联。
- 3D 图谱界面在卡片内标注引擎出处（「引擎：3d-force-graph (MIT) +
  three.js (MIT)」）。
- 2D 知识图谱为自研 SVG 力导向实现，无第三方依赖。
- lucide 仅取 SVG 路径数据（等价于官方 lucide-react 组件渲染结果），
  未引入其运行时。
- 注意：当前已发布的 0.5.0-beta.8 bundle 因构建期 minify 剥离了第三方
  license 头注释，版权与许可以本文件为准（下一版本起构建保留 license
  头于 bundle 尾部）。

## 许可全文

### MIT License

three.js / 3d-force-graph / three-spritetext / fflate 四个组件均为
MIT 许可，版权人分别为上表所列。MIT 许可全文（各组件通用）：

```
The MIT License (MIT)

Copyright (c) <see copyright column above, per component>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### ISC License

lucide 图标路径数据为 ISC 许可，全文：

```
Copyright (c) lucide contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH ALL IMPLIED WARRANTIES INCLUDING MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

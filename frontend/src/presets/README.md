# Coding CLI 场景 Preset（六开发场景 × team 映射）

> 来源：`方案与设计/AgentTeams/CodingAgent对接-20261003/QwenCode管理面-P4场景preset-20261009.md`（2026-10-10 勘误后机械生成）。
> 定案：**preset = workbench 插件内 JSON 模板**（不建中心服务）→ 一键 PUT `/api/coding-cli/{cli}/settings`（经 P2 代理）+ 生成 MCP 绑定建议清单（走现有 McpSelector 链，零新接口）。
> 状态：**备 P3**（P3「场景模板」tab 未建；本目录 JSON 即其模板文件，P3 开发时直接消费）。

## 三层内容（与 #1344 四层法对齐）

| 层 | preset 管什么 | 落点 |
|---|---|---|
| ① 工具链 | 场景 SDK/CLI 装在哪、怎么进容器（共享卷 path-reachable） | 文档 + worker env（CR 层，preset 只生成建议，不自动改 CR） |
| ② 模型/版本 | settings.json 的 `model.name`（不 pin，用户自选 tag） | `PUT /api/coding-cli/{cli}/settings`（P2） |
| ③ 知识/文件共享 | MCP 绑定清单 + 共享卷路径约定 | 现有 MCP 链（dashboard 目录 + McpSelector） |
| ④ 产物流 | HAP/APK/Web 包 → MinIO → 工作台审批 | 文档约定（preset 生成目录模板） |

**preset 只自动写 ②**（settings 合并写，密钥 `ENC:` 保留）；①③④ 生成建议清单由人确认（工具链动 CR、MCP 动绑定——团队级决策，不静默执行）。

## 六模板

| 文件 | 场景 | team 映射 | 产物 |
|---|---|---|---|
| `p-harmony.json` | 鸿蒙 AI 开发（v3 worked example） | sysdev（harmony-dev 试点）/ embedded | HAP |
| `p-web.json` | 网站开发 | sysdev | dist 包/静态站 |
| `p-android.json` | Android 开发 | sysdev 扩展 | APK/AAB |
| `p-ios.json` | iOS 开发（Linux 侧代码+文档级，构建回 macOS） | sysdev 扩展（受限） | 工程快照（.ipa macOS 侧） |
| `p-embedded.json` | MCU/embedded | embedded（现成） | .bin/.elf |
| `p-gencode.json` | 通用 coding（最小形态） | 任意 | 任意代码产物 |

**同一 worker 同一时刻一个 preset**（settings 单文件，后写覆盖前写的 preset 字段）；切换 = 再套另一模板（merge 语义保留非 preset 字段如密钥）。

## 已知边界

1. preset 不自动改 CR（env/工具链/MCP 绑定）——团队级决策留人确认（权限纪律：L2 不写团队级资源先例）。
2. preset 不 pin 版本（用户自选 tag，变更必重跑 verify）。
3. iOS 在 Linux worker 的构建边界（macOS 侧回补）与鸿蒙模拟器降级同构，写死不藏着。
4. 模型清单（`QWENCODE_MODEL_OPTIONS`）是 CR env 渲染进 settings 的，preset 只写 `model.name`，不越权改清单。
5. **P-Embedded arm64 勘误（2026-10-10）**：原设计稿的 `tools.useBuiltinRipgrep:false` 为字段语义误用（源码核实：该字段只切 bundled rg → 系统级 rg，且仅 `useRipgrep=true` 时生效）。实际行为 = qwen 0.25.0 在 16K 页系统自动优雅降级 built-in grep，**无需任何配置字段**；如需手动钉死用 `tools.useRipgrep:false`。详见 `p-embedded.json` 的 `arch_note`。

## 验收门

1. 每模板 settings 补丁过 P2 PUT 契约测试（P2 = #1360 合入后）。
2. P-Harmony 按鸿蒙 v3 方案 L0/L1 验证门。
3. P-Embedded Pi arm64 降级 = 10/8 Pi 实测既有证据（bundled ripgrep 崩溃 → 优雅降级 built-in grep），无需重跑。

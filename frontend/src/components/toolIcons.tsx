/**
 * 工具类型图标（16.31）——QwenPaw console 同款 lucide 图标，内联进插件。
 *
 * 来源：lucide-react@0.562.0（ISC），只提取
 * toolPresentation.ts 实际用到的 27 个图标的 __iconNode 节点数组
 * （code-2→code-xml、file-plus-2→file-plus-corner 转发目标），
 * 节点属性（d/cx/cy/r/x/y/width/height/x1/x2/y1/y2/key）逐字照抄。
 * 渲染与 lucide Icon.js 等价：svg viewBox 0 0 24 24 + fill none +
 * stroke currentColor + strokeWidth 2 + round 端点/连接，children =
 * 每个节点 createElement(tag, attrs)（attrs 自带 React key）。
 * 许可：ISC（THIRD-PARTY-NOTICES.md 已登记）。
 *
 * 运行时分层：RUNTIME_TOOL_ICONS 每运行时一张「工具名 → 图标名」表。
 * qwenpaw = 现行内置工具集（表 = QwenPaw toolPresentation.ts 的
 * TOOL_PRESENTATION 图标列）；其它运行时（openclaw/hermes/
 * deepseek-harness…）以后按同一结构补一张表，toolIconFor 即按
 * worker.runtime 解析。runtime 空/未收录 / 工具名未收录 → null
 * （调用方回退到通用图标：后端 emoji / 组兜底）。
 */
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

/** 单个 lucide 节点：[标签, 属性]（属性含 React key，透传 createElement）。 */
export type IconNode = readonly [string, Record<string, string | number>];

/** lucide 图标节点表（仅 toolPresentation.ts 用到的 27 个）。 */
const ICON_NODES: Record<string, IconNode[]> = {
  terminal: [
    ["path", { d: "M12 19h8", key: "baeox8" }],
    ["path", { d: "m4 17 6-6-6-6", key: "1yngyt" }],
  ],
  blocks: [
    [
      "path",
      {
        d: "M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2",
        key: "1ah6g2",
      },
    ],
    ["rect", { x: "14", y: "2", width: "8", height: "8", rx: "1", key: "88lufb" }],
  ],
  bot: [
    ["path", { d: "M12 8V4H8", key: "hb8ula" }],
    ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2", key: "enze0r" }],
    ["path", { d: "M2 14h2", key: "vft8re" }],
    ["path", { d: "M20 14h2", key: "4cs60a" }],
    ["path", { d: "M15 13v2", key: "1xurst" }],
    ["path", { d: "M9 13v2", key: "rq6x2g" }],
  ],
  "check-check": [
    ["path", { d: "M18 6 7 17l-5-5", key: "116fxf" }],
    ["path", { d: "m22 10-7.5 7.5L13 16", key: "ke71qq" }],
  ],
  clock: [
    ["path", { d: "M12 6v6l4 2", key: "mmk7yg" }],
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ],
  "code-2": [
    ["path", { d: "m18 16 4-4-4-4", key: "1inbqp" }],
    ["path", { d: "m6 8-4 4 4 4", key: "15zrgr" }],
    ["path", { d: "m14.5 4-5 16", key: "e7oirm" }],
  ],
  "file-pen-line": [
    [
      "path",
      {
        d: "m18.226 5.226-2.52-2.52A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-.351",
        key: "1k2beg",
      },
    ],
    [
      "path",
      {
        d: "M21.378 12.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z",
        key: "2t3380",
      },
    ],
    ["path", { d: "M8 18h1", key: "13wk12" }],
  ],
  "file-plus-2": [
    [
      "path",
      {
        d: "M11.35 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5.35",
        key: "17jvcc",
      },
    ],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5", key: "wfsgrz" }],
    ["path", { d: "M14 19h6", key: "bvotb8" }],
    ["path", { d: "M17 16v6", key: "18yu1i" }],
  ],
  "file-text": [
    [
      "path",
      {
        d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
        key: "1oefj6",
      },
    ],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5", key: "wfsgrz" }],
    ["path", { d: "M10 9H8", key: "b1mrlr" }],
    ["path", { d: "M16 13H8", key: "t4e002" }],
    ["path", { d: "M16 17H8", key: "z1uh3a" }],
  ],
  "folder-search": [
    [
      "path",
      {
        d: "M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1",
        key: "1bw5m7",
      },
    ],
    ["path", { d: "m21 21-1.9-1.9", key: "1g2n9r" }],
    ["circle", { cx: "17", cy: "17", r: "3", key: "18b49y" }],
  ],
  gauge: [
    ["path", { d: "m12 14 4-4", key: "9kzdfg" }],
    ["path", { d: "M3.34 19a10 10 0 1 1 17.32 0", key: "19p75a" }],
  ],
  globe: [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    [
      "path",
      { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", key: "13o1zl" },
    ],
    ["path", { d: "M2 12h20", key: "9i4pu4" }],
  ],
  image: [
    [
      "rect",
      { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2", key: "1m3agn" },
    ],
    ["circle", { cx: "9", cy: "9", r: "2", key: "af1f0g" }],
    [
      "path",
      { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21", key: "1xmnt7" },
    ],
  ],
  layers: [
    [
      "path",
      {
        d: "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",
        key: "zw3jo",
      },
    ],
    [
      "path",
      {
        d: "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12",
        key: "1wduqc",
      },
    ],
    [
      "path",
      {
        d: "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17",
        key: "kqbvx6",
      },
    ],
  ],
  "list-checks": [
    ["path", { d: "M13 5h8", key: "a7qcls" }],
    ["path", { d: "M13 12h8", key: "h98zly" }],
    ["path", { d: "M13 19h8", key: "c3s6r1" }],
    ["path", { d: "m3 17 2 2 4-4", key: "1jhpwq" }],
    ["path", { d: "m3 7 2 2 4-4", key: "1obspn" }],
  ],
  "mail-check": [
    [
      "path",
      {
        d: "M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8",
        key: "12jkf8",
      },
    ],
    [
      "path",
      { d: "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7", key: "1ocrg3" },
    ],
    ["path", { d: "m16 19 2 2 4-4", key: "1b14m6" }],
  ],
  "messages-square": [
    [
      "path",
      {
        d: "M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
        key: "1n2ejm",
      },
    ],
    [
      "path",
      {
        d: "M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1",
        key: "1qfcsi",
      },
    ],
  ],
  monitor: [
    [
      "rect",
      { width: "20", height: "14", x: "2", y: "3", rx: "2", key: "48i651" },
    ],
    ["line", { x1: "8", x2: "16", y1: "21", y2: "21", key: "1svkeh" }],
    ["line", { x1: "12", x2: "12", y1: "17", y2: "21", key: "vw1qmm" }],
  ],
  "panels-top-left": [
    [
      "rect",
      { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" },
    ],
    ["path", { d: "M3 9h18", key: "1pudct" }],
    ["path", { d: "M9 21V9", key: "1oto5p" }],
  ],
  "refresh-cw": [
    [
      "path",
      { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", key: "v9h5vc" },
    ],
    ["path", { d: "M21 3v5h-5", key: "1q7to0" }],
    [
      "path",
      {
        d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
        key: "3uifl3",
      },
    ],
    ["path", { d: "M8 16H3v5", key: "1cv678" }],
  ],
  "scan-search": [
    ["path", { d: "M3 7V5a2 2 0 0 1 2-2h2", key: "aa7l1z" }],
    ["path", { d: "M17 3h2a2 2 0 0 1 2 2v2", key: "4qcy5o" }],
    ["path", { d: "M21 17v2a2 2 0 0 1-2 2h-2", key: "6vwrx8" }],
    ["path", { d: "M7 21H5a2 2 0 0 1-2-2v-2", key: "ioqczr" }],
    ["circle", { cx: "12", cy: "12", r: "3", key: "1v7zrd" }],
    ["path", { d: "m16 16-1.9-1.9", key: "1dq9hf" }],
  ],
  search: [
    ["path", { d: "m21 21-4.34-4.34", key: "14j7rj" }],
    ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }],
  ],
  send: [
    [
      "path",
      {
        d: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
        key: "1ffxy3",
      },
    ],
    ["path", { d: "m21.854 2.147-10.94 10.939", key: "12cjpa" }],
  ],
  sparkles: [
    [
      "path",
      {
        d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
        key: "1s2grr",
      },
    ],
    ["path", { d: "M20 2v4", key: "1rf3ol" }],
    ["path", { d: "M22 4h-4", key: "gwowj6" }],
    ["circle", { cx: "4", cy: "20", r: "2", key: "6kqj1y" }],
  ],
  users: [
    [
      "path",
      { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", key: "1yyitq" },
    ],
    ["path", { d: "M16 3.128a4 4 0 0 1 0 7.744", key: "16gr8j" }],
    ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87", key: "kshegd" }],
    ["circle", { cx: "9", cy: "7", r: "4", key: "nufk8" }],
  ],
  video: [
    [
      "path",
      {
        d: "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5",
        key: "ftymec",
      },
    ],
    [
      "rect",
      { x: "2", y: "6", width: "14", height: "12", rx: "2", key: "158x01" },
    ],
  ],
  workflow: [
    [
      "rect",
      { width: "8", height: "8", x: "3", y: "3", rx: "2", key: "by2w9f" },
    ],
    ["path", { d: "M7 11v4a2 2 0 0 0 2 2h4", key: "xkn7yn" }],
    [
      "rect",
      { width: "8", height: "8", x: "13", y: "13", rx: "2", key: "1cgmvn" },
    ],
  ],
};

/** QwenPaw 内置工具名 → 图标名（表 = QwenPaw toolPresentation.ts 的
 * TOOL_PRESENTATION 图标列，逐行对齐）。 */
export const QWENPAW_TOOL_ICONS: Record<string, string> = {
  execute_shell_command: "terminal",
  read_file: "file-text",
  write_file: "file-plus-2",
  edit_file: "file-pen-line",
  append_file: "file-plus-2",
  grep_search: "search",
  glob_search: "folder-search",
  ast_search: "code-2",
  desktop_screenshot: "monitor",
  view_image: "image",
  view_video: "video",
  enhance_and_generate_image: "sparkles",
  web_search: "search",
  web_fetch: "globe",
  browser: "panels-top-left",
  list_agents: "users",
  chat_with_agent: "messages-square",
  submit_to_agent: "send",
  check_agent_task: "list-checks",
  spawn_subagent: "workflow",
  delegate_external_agent: "bot",
  send_file_to_user: "send",
  get_current_time: "clock",
  set_user_timezone: "globe",
  get_token_usage: "gauge",
  materialize_skill: "blocks",
  run_tool_batch: "layers",
  activate_f1_exploration_mode: "mail-check",
  migration_compat_inspect: "scan-search",
  migration_compat_read_file: "file-text",
  migration_compat_write_file: "file-pen-line",
  migration_compat_update: "refresh-cw",
  migration_compat_finalize: "check-check",
};

/** 运行时 → 工具图标表。新增运行时补一张同结构表即可（值必须是
 * ICON_NODES 的 key，查不到图标时 ToolTypeIcon 返回 null）。 */
export const RUNTIME_TOOL_ICONS: Record<string, Record<string, string>> = {
  qwenpaw: QWENPAW_TOOL_ICONS,
};

/** 按运行时 + 工具名解析图标名；runtime 空/未收录 / 工具未收录 → null。 */
export function toolIconFor(
  runtime: string | undefined,
  toolName: string,
): string | null {
  const r = (runtime || "").trim().toLowerCase();
  if (!r) return null;
  const table = RUNTIME_TOOL_ICONS[r];
  if (!table) return null;
  return table[toolName] ?? null;
}

/** lucide 风格 SVG 渲染（属性照抄 lucide Icon.js 的默认值）；
 * 未知图标名 → null（调用方回退到通用图标）。 */
export function ToolTypeIcon({
  iconName,
  size = 16,
}: {
  iconName: string;
  size?: number;
}) {
  const nodes = ICON_NODES[iconName];
  if (!nodes) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* @types/react 18 的字符串标签重载要求 P extends DOMAttributes<T>，
       * Record<string,string|number> 索引签名不满足该约束 → 断言为
       * Attributes（attrs 自带 key，其余属性透传，运行时无差异）。 */}
      {nodes.map(([tag, attrs]) =>
        React.createElement(tag, attrs as unknown as ReactNS.Attributes),
      )}
    </svg>
  );
}

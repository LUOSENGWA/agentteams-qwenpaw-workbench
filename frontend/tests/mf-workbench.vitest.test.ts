/**
 * 千锻工作台重构（2026-11-07）——vitest 面：模块更新 body / 千锻按钮卡片 /
 * 弹窗四 tab。
 *
 * 渲染环境说明：本仓 vitest 是 node 环境，未装 jsdom/@testing-library，且本单
 * 禁止安装依赖。故沿用 tests/files-ui-1667 的先例：注入 window.QwenPaw.host
 * （真 React + 最小 antd 桩）后用 react-dom/server 的 renderToStaticMarkup 做
 * 静态渲染（effects 不跑）；需要交互的断言直接取组件返回的元素树做 props 级
 * 校验（卡片是纯展示组件，无 hooks）。
 *
 * 「autoLoad 挂载即请求」无法在静态渲染下观测（React 的 effect 不在 SSR 执行），
 * 因此该项用源码接线断言 + 渲染产物（无「载入」折叠头、三平面直出）双重把关。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThemeColors } from "../src/theme";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const BODY_SRC = join(srcDir, "components", "ModuleUpdatesBody.tsx");

const E = React.createElement;

// ── 最小 antd 桩（只覆盖本单渲染路径）──────────────────────────────
interface TabItem {
  key: string;
  label: unknown;
  children?: unknown;
}

const tabCalls: TabItem[][] = [];

const antdShim = {
  Tabs: (p: { items: TabItem[]; activeKey?: string }) => {
    // 记录 items 供断言（四 tab 结构 / 面板体），只渲染标题行——
    // 各面板体由测试单独 renderToStaticMarkup，避免拉起无关子树。
    tabCalls.push(p.items);
    return E(
      "div",
      { "data-tabs": String(p.items.length), "data-active": p.activeKey },
      p.items.map((i) => E("span", { key: i.key, "data-tab": i.key }, i.label)),
    );
  },
  Modal: Object.assign(
    (p: { open?: boolean; title?: unknown; children?: unknown; width?: number }) =>
      p.open
        ? E("div", { "data-modal": "1", "data-width": String(p.width ?? "") }, p.title, p.children)
        : null,
    { confirm: () => {} },
  ),
  Button: (p: { children?: unknown; disabled?: boolean; type?: string }) =>
    E(
      "button",
      { type: "button", "data-btn": p.type ?? "default", disabled: p.disabled },
      p.children,
    ),
  Select: (p: { value?: string; placeholder?: string }) =>
    E("div", { "data-select": "1", "data-value": p.value ?? "" }, p.value || p.placeholder || ""),
  Input: (p: { value?: string; placeholder?: string }) =>
    E("input", { "data-input": "1", value: p.value ?? "", placeholder: p.placeholder }),
  Alert: (p: { message?: unknown; description?: unknown }) =>
    E("div", { "data-alert": "1" }, p.message, p.description),
  Tag: (p: { children?: unknown }) => E("span", { "data-tag": "1" }, p.children),
  Spin: () => E("span", { "data-spin": "1" }),
  Table: (p: { columns?: { title?: unknown }[]; locale?: { emptyText?: unknown } }) =>
    E(
      "div",
      { "data-table": "1" },
      (p.columns ?? []).map((c, i) => E("span", { key: i, "data-col": "1" }, c.title)),
      p.locale?.emptyText ?? null,
    ),
  Empty: Object.assign(() => null, { PRESENTED_IMAGE_SIMPLE: null }),
  message: { success() {}, error() {}, warning() {} },
};

// window/host shim——必须在动态 import 业务模块之前就位（模块顶层读
// window.QwenPaw.host）。
(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      kind: "server",
      React,
      antd: antdShim,
      antdIcons: {},
      useLocale: () => "zh",
      useTheme: () => "light",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
      getApiUrl: (p: string) => p,
      getApiToken: () => "",
    },
  },
};
(globalThis as Record<string, unknown>).document = {
  hidden: false,
  documentElement: {},
};

// 业务模块（动态 import：等 shim 就位）
let ModuleUpdatesBody: React.FC<{ defaultTeam?: string; autoLoad?: boolean }>;
let MillforgeModal: React.FC<Record<string, unknown>>;
let MillforgeEntryCard: React.FC<{
  t: ThemeColors;
  tr: (s: string) => string;
  disabledReason?: string;
  onClick: () => void;
}>;

beforeAll(async () => {
  ({ ModuleUpdatesBody } = await import("../src/components/ModuleUpdatesBody"));
  ({ default: MillforgeModal } = await import("../src/millforge/MillforgeModal"));
  ({ default: MillforgeEntryCard } = await import("../src/manage/MillforgeEntryCard"));
});

const tr = (s: string) => s;
const fakeT = {
  mode: "light",
  text: "#111",
  textSecondary: "#888",
  border: "#eee",
  cardBg: "#fff",
  hoverBg: "#f5f5f5",
  bg: "#fff",
} as unknown as ThemeColors;

// ── ① ModuleUpdatesBody ──────────────────────────────────────────

describe("ModuleUpdatesBody（模块更新 tab 体）", () => {
  it("渲染即三平面（团队/manager/worker）+ 当前团队预选，无折叠头「载入」", () => {
    const html = renderToStaticMarkup(
      E(ModuleUpdatesBody, { defaultTeam: "team-a", autoLoad: true }),
    );
    expect(html).toContain("团队面");
    expect(html).toContain("manager 面");
    expect(html).toContain("worker 面");
    // 团队面初始目标 = defaultTeam（无管理列表时落手动输入框，value 直出）
    expect(html).toContain('value="team-a"');
    // 折叠头（标题 + 载入/关闭 + 未载入 hint）已删——tab 内即展开态
    expect(html).not.toContain("载入");
    expect(html).not.toContain("未载入");
  });

  it("autoLoad 挂载即取数（源码接线）+ 默认团队来源 defaultTeam", () => {
    const src = readFileSync(BODY_SRC, "utf8");
    // 管理列表：autoLoad 才拉（设置页折叠态不再挂载本组件）
    expect(src).toContain("if (autoLoad) void loadAdmin();");
    // 索引：autoLoad 且未拉过 → 拉一次（indexLoadedOnce 防重复）
    expect(src).toContain("if (autoLoad && !indexLoadedOnce)");
    expect(src).toContain("setIndexLoadedOnce(true);");
    expect(src).toContain("void loadIndex();");
    // 团队面初始目标
    expect(src).toContain('React.useState(defaultTeam ?? "")');
    // 旧折叠态遗留（cardBox prop / open 状态）必须清干净
    expect(src).not.toContain("cardBox?:");
    expect(src).not.toContain("setOpen");
    expect(src).not.toContain("const [open,");
  });
});

// ── ② 千锻入口卡（整卡按钮）───────────────────────────────────────

describe("MillforgeEntryCard（团队拓扑千锻卡）", () => {
  it("整卡 = 单个 button：aria-label 千锻、副标题三入口、右侧 ›", () => {
    const el = MillforgeEntryCard({
      t: fakeT,
      tr,
      disabledReason: "",
      onClick: () => {},
    }) as React.ReactElement<Record<string, unknown>>;
    expect(el.type).toBe("button");
    expect(el.props.type).toBe("button");
    expect(el.props["aria-label"]).toBe("千锻");
    expect(el.props.disabled).toBe(false);
    expect(el.props.title).toBeUndefined();
    const style = el.props.style as Record<string, unknown>;
    expect(style.width).toBe("100%");
    expect(style.minHeight).toBe(56);
    const kids = el.props.children as React.ReactElement<Record<string, unknown>>[];
    // [图标, 文本块, ›]
    expect(kids).toHaveLength(3);
    const textBlock = kids[1].props.children as React.ReactElement<Record<string, unknown>>[];
    expect(textBlock[0].props.children).toBe("千锻");
    expect(textBlock[1].props.children).toBe("注入 / 模块更新 / 历史");
    expect(kids[2].props.children).toBe("›");
  });

  it("点击调用 onOpenMillforge（onClick 透传）", () => {
    const onClick = vi.fn();
    const el = MillforgeEntryCard({
      t: fakeT,
      tr,
      disabledReason: "",
      onClick,
    }) as React.ReactElement<Record<string, unknown>>;
    (el.props.onClick as () => void)();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled：不可用原因落 title，button 置 disabled（原生吞掉点击）", () => {
    const onClick = vi.fn();
    const el = MillforgeEntryCard({
      t: fakeT,
      tr,
      disabledReason: "管理数据未就绪",
      onClick,
    }) as React.ReactElement<Record<string, unknown>>;
    expect(el.props.disabled).toBe(true);
    expect(el.props.title).toBe("管理数据未就绪");
    const html = renderToStaticMarkup(el);
    expect(html).toContain("disabled");
    expect(html).toContain('title="管理数据未就绪"');
  });
});

// ── ③ 弹窗四 tab ─────────────────────────────────────────────────

describe("MillforgeModal（顶层四 tab）", () => {
  const team = { name: "demo", workerMembers: [] };

  it("只有一个 Tabs：注入 / 自定义团队 / 模块更新 / 注入历史", () => {
    tabCalls.length = 0;
    const html = renderToStaticMarkup(
      E(MillforgeModal, {
        team,
        workers: [],
        onRefresh: () => {},
        onClose: () => {},
        t: fakeT,
      }),
    );
    // 弹窗标题与宽度
    expect(html).toContain("千锻 — demo");
    expect(html).toContain('data-width="960"');
    // 顶层仅一套 Tabs（内层 template/custom Tabs 已删）
    expect(tabCalls).toHaveLength(1);
    const items = tabCalls[0];
    expect(items.map((i) => i.key)).toEqual(["inject", "custom", "modules", "history"]);
    expect(items.map((i) => i.label)).toEqual([
      "注入",
      "自定义团队",
      "模块更新",
      "注入历史",
    ]);
  });

  it("模块更新面板 = ModuleUpdatesBody（defaultTeam=当前团队 + autoLoad）", () => {
    tabCalls.length = 0;
    renderToStaticMarkup(
      E(MillforgeModal, { team, workers: [], onRefresh: () => {}, onClose: () => {}, t: fakeT }),
    );
    const items = tabCalls[0];
    const modPane = items[2].children as React.ReactElement<Record<string, unknown>>;
    const body = modPane.props.children as React.ReactElement<{
      defaultTeam?: string;
      autoLoad?: boolean;
    }>;
    expect((body.type as { name?: string }).name).toBe("ModuleUpdatesBody");
    expect(body.props.defaultTeam).toBe("demo");
    expect(body.props.autoLoad).toBe(true);
    // 面板容器滚动约束（弹窗 body 不再整体滚）
    const paneStyle = modPane.props.style as Record<string, unknown>;
    expect(paneStyle.maxHeight).toBe("66vh");
    expect(paneStyle.overflow).toBe("auto");
  });

  it("注入历史 tab 面板渲染历史体（最近 50 条）", () => {
    tabCalls.length = 0;
    renderToStaticMarkup(
      E(MillforgeModal, { team, workers: [], onRefresh: () => {}, onClose: () => {}, t: fakeT }),
    );
    const historyPane = tabCalls[0][3].children as React.ReactElement<Record<string, unknown>>;
    const html = renderToStaticMarkup(historyPane);
    expect(html).toContain("注入历史（最近 50 条）");
    expect(html).toContain("（暂无注入记录）");
  });
});

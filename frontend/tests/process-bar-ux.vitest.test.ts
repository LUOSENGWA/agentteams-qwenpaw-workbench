// 过程折叠条交互（A1/A2 实测 UX）：
// - 子项（思考行 / 调用行 / 参数结果 pre）点击不收起父条；
// - 只有折叠头切换展开；展开区空白点击不收起；
// - 父条收起再展开后，子项展开态保留（grid 0fr 隐藏不卸载）；
// - 思考段 = 可折叠子项（BrainIcon +「思考」行，默认折叠，点开看全文，
//   与工具行交互契约一致）；图标化无 emoji。
// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

const host = {
  React,
  antd: {
    Button: (p: Record<string, unknown>) =>
      React.createElement("button", { type: "button" }, p.children as React.ReactNode),
    message: { success: () => undefined, error: () => undefined, warning: () => undefined },
  },
  antdIcons: {},
  fetch: vi.fn(async () => ({ status: 404, ok: false, text: async () => "" })),
  useLocale: () => "zh",
  useTheme: () => "light",
};
(globalThis as Record<string, unknown>).window = window;
(window as unknown as Record<string, unknown>).QwenPaw = { host };
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type BarMod = {
  ProcessCollapseBar: (props: {
    calls: unknown[];
    thoughts?: string[];
    active?: boolean;
  }) => React.ReactElement;
};

const CALL_WITH_DETAIL = {
  id: "$call1",
  name: "read_file",
  argsSummary: "ChatIR.ts",
  status: "ok",
  ts: 1000,
  detail: "文件内容摘要（完整结果）",
};
const THOUGHTS = ["先看后端 reasoning", "再定折叠口径"];

let Bar: BarMod["ProcessCollapseBar"];

beforeAll(async () => {
  const mod = (await import("../src/chat/ProcessCollapseBar")) as unknown as BarMod;
  Bar = mod.ProcessCollapseBar;
});

function mount(props: { calls: unknown[]; thoughts?: string[] }) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  flushSync(() => {
    root.render(React.createElement(Bar, props));
  });
  const bar = el.firstElementChild as HTMLElement;
  const head = bar.querySelector('[role="button"][aria-expanded]') as HTMLElement;
  const body = bar.querySelector("[data-process-body]") as HTMLElement;
  const click = (node: Element) => {
    flushSync(() => {
      node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  };
  const cleanup = () => {
    flushSync(() => root.unmount());
    el.remove();
  };
  return { bar, head, body, click, cleanup };
}

function expanded(head: HTMLElement): string | null {
  return head.getAttribute("aria-expanded");
}

function rowsStyle(body: HTMLElement): string {
  return body.style.gridTemplateRows;
}

describe("ProcessCollapseBar — 子项独立展开 / 父条只由头部切换", () => {
  it("子项点击打开详情但不收起父条；pre 内点击也不收起", () => {
    const { bar, head, body, click, cleanup } = mount({
      calls: [CALL_WITH_DETAIL],
      thoughts: THOUGHTS,
    });
    click(head); // 展开父条
    expect(expanded(head)).toBe("true");
    expect(rowsStyle(body)).toBe("1fr");

    // 点击调用行（read_file）→ 展开参数/结果详情，父条保持展开。
    const name = [...bar.querySelectorAll("span")].find(
      (s) => s.textContent === "read_file",
    ) as HTMLElement;
    const callRow = name.parentElement?.parentElement as HTMLElement;
    click(callRow);
    const detailPre = [...bar.querySelectorAll("pre")].find(
      (p) => p.textContent?.includes("完整结果") === true,
    );
    expect(detailPre).toBeTruthy();
    expect(expanded(head)).toBe("true");

    // pre 内点击（选中文本场景）不收起子项、也不收起父条。
    click(detailPre as Element);
    expect(expanded(head)).toBe("true");
    expect(
      [...bar.querySelectorAll("pre")].some((p) =>
        p.textContent?.includes("完整结果"),
      ),
    ).toBe(true);

    cleanup();
  });

  it("展开区空白点击不收起父条", () => {
    const { head, body, click, cleanup } = mount({ calls: [CALL_WITH_DETAIL] });
    click(head);
    click(body);
    expect(expanded(head)).toBe("true");
    cleanup();
  });

  it("父条收起 → 再展开：子项详情仍保留（grid 0fr 隐藏不卸载）", () => {
    const { bar, head, body, click, cleanup } = mount({
      calls: [CALL_WITH_DETAIL],
      thoughts: THOUGHTS,
    });
    click(head); // 展开
    const name = [...bar.querySelectorAll("span")].find(
      (s) => s.textContent === "read_file",
    ) as HTMLElement;
    click(name.parentElement?.parentElement as HTMLElement); // 打开子项
    expect(body.textContent).toContain("完整结果");

    click(head); // 收起父条
    expect(expanded(head)).toBe("false");
    expect(rowsStyle(body)).toBe("0fr");
    // 内容未卸载（子项状态因此保留）。
    expect(body.textContent).toContain("完整结果");

    click(head); // 再展开
    expect(expanded(head)).toBe("true");
    expect(body.textContent).toContain("完整结果");
    cleanup();
  });
});

describe("ProcessCollapseBar — 思考行（可折叠子项）", () => {
  /** 第 idx 个思考行（标签文本恰为「思考」的行的可点击外层容器）。 */
  function thoughtRow(bar: HTMLElement, idx: number): HTMLElement {
    const labels = [...bar.querySelectorAll("span")].filter(
      (s) => s.textContent === "思考",
    );
    return labels[idx].parentElement?.parentElement as HTMLElement;
  }

  it("默认折叠；点开看全文且父条保持展开；再点收起", () => {
    const { bar, head, body, click, cleanup } = mount({
      calls: [CALL_WITH_DETAIL],
      thoughts: THOUGHTS,
    });
    click(head); // 展开父条
    expect(expanded(head)).toBe("true");
    // 默认折叠：展开区 DOM 不含思考 pre（无 pre、无思考文本）。
    expect(bar.querySelector("pre")).toBeNull();
    expect(body.textContent).not.toContain(THOUGHTS[0]);

    // 点击思考行 → 展开：pre 出现且含思考文本，父条保持 open（不收起）。
    click(thoughtRow(bar, 0));
    const pre = [...bar.querySelectorAll("pre")].find(
      (p) => p.textContent === THOUGHTS[0],
    );
    expect(pre).toBeTruthy();
    expect(expanded(head)).toBe("true");

    // 再点 → 收起（pre 移除），父条仍 open。
    click(thoughtRow(bar, 0));
    expect(
      [...bar.querySelectorAll("pre")].some((p) => p.textContent === THOUGHTS[0]),
    ).toBe(false);
    expect(expanded(head)).toBe("true");
    cleanup();
  });

  it("父条收起 → 再展开：思考行 open 态保留（grid 0fr 隐藏不卸载）", () => {
    const { bar, head, body, click, cleanup } = mount({
      calls: [CALL_WITH_DETAIL],
      thoughts: THOUGHTS,
    });
    click(head); // 展开父条
    click(thoughtRow(bar, 1)); // 打开第二个思考行
    expect(body.textContent).toContain(THOUGHTS[1]);

    click(head); // 收起父条
    expect(expanded(head)).toBe("false");
    expect(rowsStyle(body)).toBe("0fr");
    // 内容未卸载（思考行状态因此保留）。
    expect(body.textContent).toContain(THOUGHTS[1]);

    click(head); // 再展开
    expect(expanded(head)).toBe("true");
    expect(body.textContent).toContain(THOUGHTS[1]);
    cleanup();
  });

  it("思考行含 BrainIcon（svg + currentColor），无 emoji，标签「思考」", () => {
    const { bar, head, click, cleanup } = mount({
      calls: [CALL_WITH_DETAIL],
      thoughts: THOUGHTS,
    });
    click(head);
    // 2 段思考 = 2 个「思考」行。
    const labels = [...bar.querySelectorAll("span")].filter(
      (s) => s.textContent === "思考",
    );
    expect(labels).toHaveLength(2);
    const row = labels[0].parentElement?.parentElement as HTMLElement;
    expect(row.querySelector("svg")).toBeTruthy();
    expect(row.querySelector("svg path[stroke='currentColor']")).toBeTruthy();
    expect(bar.textContent).not.toContain("🧠");
    cleanup();
  });
});

describe("ProcessCollapseBar — 图标化", () => {
  it("思考 = BrainIcon、工具 = WrenchIcon（SVG + currentColor），无 emoji", () => {
    const { bar, cleanup } = mount({ calls: [CALL_WITH_DETAIL], thoughts: THOUGHTS });
    expect(bar.textContent).not.toContain("🧠");
    expect(bar.textContent).not.toContain("🔧");
    expect(bar.querySelector('[data-icon="brain"] svg')).toBeTruthy();
    expect(bar.querySelector('[data-icon="wrench"] svg')).toBeTruthy();
    cleanup();
  });

  it("折叠头文案：执行过程 · 思考 N 次 · 工具 N 次（时长挂工具段尾）", () => {
    const { bar, cleanup } = mount({ calls: [CALL_WITH_DETAIL], thoughts: THOUGHTS });
    expect(bar.textContent).toContain("执行过程");
    expect(bar.textContent).toContain("·");
    expect(bar.textContent).toContain("思考 2 次");
    // 时长仍挂工具段尾（单帧 start=end → 0.0s）。
    expect(bar.textContent).toContain("工具 1 次 · 0.0s");
    cleanup();
  });

  it("头行 style 含 flex-wrap:wrap（窄宽自动换行；段为换行单元，点随段）", () => {
    const { bar, head, cleanup } = mount({ calls: [CALL_WITH_DETAIL], thoughts: THOUGHTS });
    expect(bar.querySelector('[role="button"]')).toBe(head);
    // SSR 验不了真实布局，断 style 属性即可（忽略序列化空白差异）。
    expect((head.getAttribute("style") ?? "").replace(/\s+/g, "")).toContain(
      "flex-wrap:wrap",
    );
    cleanup();
  });
});

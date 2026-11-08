/**
 * CodingCLI 设置 · QwenCode「语音（Voice）」分组（16.141）。
 *
 * 现状缺陷：voiceModel 虽在 FIELD_CATALOG 里，但顶层标量分区默认「无内容即
 * 收起」，文件未设置时整组不可见 → 用户找不到入口。
 *
 * 覆盖（任务书 5 条）：
 * ① QwenCode 设置渲染「语音模型」字段（独立卡 + 默认展开 + 双语标签 +
 *    placeholder + 说明；且不落在 vision/image 分区里）；
 * ② 输入值 → 保存 patch 含顶层 voiceModel（写盘 JSON 有该键）；
 * ③ 从未设置过 + 留空 → patch 无该键（不写空值，文件里没有该键）；
 * ④ opencode 目录无该键 → 不渲染该分组；
 * ⑤ 已有值清空 → 沿用现有「空串=清除覆盖」语义（controller settings PUT
 *    只做深合并、无删键语义，见 worker_coding_cli.go codingCliDeepMerge）。
 *
 * 渲染环境：本仓 vitest 为 node 环境、未装 jsdom/@testing-library（不新增
 * 依赖）——沿用 manage-checkpoint-card 先例：注入 window.QwenPaw.host
 * （真 React + 最小 antd 桩）后 react-dom/server 静态渲染（effects 不跑）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const E = React.createElement;

// window/host shim——必须在动态 import 业务模块之前就位（模块顶层即读
// window.QwenPaw.host / host.antd / host.React）。
function input(p: Record<string, unknown>) {
  return E("input", {
    "data-stub": "input",
    placeholder: p.placeholder as string | undefined,
    value: p.value as string | undefined,
    disabled: !!p.disabled,
    onChange: p.onChange as never,
  });
}
const Input = Object.assign(input, {
  Password: (p: Record<string, unknown>) => input({ ...p, "data-stub": "password" }),
  TextArea: (p: Record<string, unknown>) =>
    E("textarea", {
      "data-stub": "textarea",
      placeholder: p.placeholder as string | undefined,
      value: p.value as string | undefined,
      onChange: p.onChange as never,
    }),
});

(globalThis as Record<string, unknown>).window = {
  innerWidth: 1200,
  innerHeight: 900,
  QwenPaw: {
    host: {
      kind: "server",
      React,
      antd: {
        Input,
        Switch: (p: Record<string, unknown>) =>
          E("span", { "data-stub": "switch", "data-checked": !!p.checked }),
        InputNumber: (p: Record<string, unknown>) =>
          E("input", { "data-stub": "number", value: p.value as never, onChange: p.onChange as never }),
        AutoComplete: (p: Record<string, unknown>) => input(p),
        Button: (p: { children?: unknown }) => E("button", null, p.children as never),
        message: { error: () => undefined, warning: () => undefined },
      },
      antdIcons: {},
      useLocale: () => "zh",
      useTheme: () => "light",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
      getApiUrl: (p: string) => p,
      getApiToken: () => "",
    },
  },
};

type EditorMod = typeof import("../src/components/WorkerCodingCliPanelEditor");
type PresetsMod = typeof import("../src/codingCliPresets");
type SharedMod = typeof import("../src/components/WorkerCodingCliPanelShared");

let Editor: EditorMod["SettingsTreeEditor"];
let stripEmptyLeavesNotInBase: EditorMod["stripEmptyLeavesNotInBase"];
let presets: PresetsMod;
let shared: SharedMod;

beforeAll(async () => {
  const mod = await import("../src/components/WorkerCodingCliPanelEditor");
  Editor = mod.SettingsTreeEditor;
  stripEmptyLeavesNotInBase = mod.stripEmptyLeavesNotInBase;
  presets = await import("../src/codingCliPresets");
  shared = await import("../src/components/WorkerCodingCliPanelShared");
});

/** 卡片头的 aria-expanded（标题前最近一个 role=button）。 */
function expandedBefore(html: string, title: string): string {
  const i = html.indexOf(title);
  if (i < 0) return "missing";
  const before = html.slice(0, i);
  const j = before.lastIndexOf('aria-expanded="');
  if (j < 0) return "missing";
  const m = /^aria-expanded="(true|false)"/.exec(before.slice(j));
  return m ? m[1] : "invalid";
}

function renderQwen(base: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    E(Editor, {
      base,
      readOnly: false,
      busy: false,
      onSave: () => undefined,
      seed: presets.CODING_CLI_SEEDS["qwen-code"].template,
      seedSecrets: presets.CODING_CLI_SEEDS["qwen-code"].secretPaths,
      patchPlaceholder: presets.CODING_CLI_SEEDS["qwen-code"].patchPlaceholder,
      catalog: presets.FIELD_CATALOG["qwen-code"],
    }),
  );
}

/** 保存链的纯函数模拟：叶子级 diff + 空串剥离（= handleSave 的 1) 与 7)）。 */
function patchFor(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  return stripEmptyLeavesNotInBase(
    shared.diffSettings(base, draft) as never,
    base as never,
  ) as Record<string, unknown>;
}

describe("① QwenCode 设置：语音分组可见", () => {
  it("空配置（文件未设置）也渲染「语音（Voice）」卡，且默认展开", () => {
    const html = renderQwen();
    expect(html).toContain("语音（Voice）");
    // 默认展开 = 卡体渲染（输入框在静态标记里出现）
    expect(expandedBefore(html, "语音（Voice）")).toBe("true");
  });

  it("字段行 = 双语标签「语音模型」+ 键名 voiceModel + placeholder", () => {
    const html = renderQwen();
    expect(html).toContain("语音模型");
    expect(html).toContain('placeholder="留空使用 CLI 默认"');
    const voiceTitle = html.indexOf("语音（Voice）");
    // 键名与说明都在语音卡内（不在 vision/image 分区混排）
    expect(html.indexOf("voiceModel", voiceTitle)).toBeGreaterThan(voiceTitle);
    expect(html.slice(0, voiceTitle)).not.toContain("voiceModel");
    expect(html).toContain("语音/转写模型");
    expect(html).toContain("从未设置过则不写盘");
  });

  it("已有值回填（voiceModel 非 secret，明文显示）", () => {
    const html = renderQwen({ voiceModel: "qwen-voice-tts-1" });
    expect(html).toContain('value="qwen-voice-tts-1"');
    expect(expandedBefore(html, "语音（Voice）")).toBe("true");
  });

  it("英文界面：卡头 Voice / 字段 Voice model", () => {
    const host = (globalThis as Record<string, unknown>).window as {
      QwenPaw: { host: { useLocale: () => string } };
    };
    const prev = host.QwenPaw.host.useLocale;
    host.QwenPaw.host.useLocale = () => "en";
    try {
      const html = renderQwen();
      expect(html).toContain(">Voice<");
      expect(html).toContain("Voice model");
    } finally {
      host.QwenPaw.host.useLocale = prev;
    }
  });
});

describe("② 保存语义：voiceModel 落盘", () => {
  it("填写 → patch 顶层 voiceModel 字符串（写盘 JSON 含该键）", () => {
    const patch = patchFor({}, { voiceModel: "qwen-voice-tts-1" });
    expect(patch).toEqual({ voiceModel: "qwen-voice-tts-1" });
    expect(JSON.stringify(patch)).toContain('"voiceModel":"qwen-voice-tts-1"');
  });

  it("改值 → patch 只含新值", () => {
    const patch = patchFor(
      { voiceModel: "old-voice" },
      { voiceModel: "new-voice" },
    );
    expect(patch).toEqual({ voiceModel: "new-voice" });
  });

  it("无改动 → patch 空（不误写）", () => {
    expect(patchFor({}, {})).toEqual({});
    expect(patchFor({ voiceModel: "same" }, { voiceModel: "same" })).toEqual({});
  });
});

describe("③ 留空不写盘", () => {
  it("从未设置过 + 留空 → patch 无该键（文件里不会出现 voiceModel）", () => {
    const patch = patchFor({}, { voiceModel: "" });
    expect(patch).toEqual({});
    expect(JSON.stringify(patch)).not.toContain("voiceModel");
  });

  it("已有值清空 → 沿用现有空串=清除覆盖语义（controller 只深合并、无删键）", () => {
    const patch = patchFor({ voiceModel: "old-voice" }, { voiceModel: "" });
    expect(patch).toEqual({ voiceModel: "" });
  });
});

describe("④ 只对 qwen-code 生效", () => {
  it("opencode 目录无 voiceModel → 不渲染语音分组", () => {
    const html = renderToStaticMarkup(
      E(Editor, {
        base: {},
        readOnly: false,
        busy: false,
        onSave: () => undefined,
        seed: presets.CODING_CLI_SEEDS["opencode"].template,
        seedSecrets: presets.CODING_CLI_SEEDS["opencode"].secretPaths,
        patchPlaceholder: presets.CODING_CLI_SEEDS["opencode"].patchPlaceholder,
        catalog: presets.FIELD_CATALOG["opencode"],
      }),
    );
    expect(html).not.toContain("语音（Voice）");
    expect(html).not.toContain("voiceModel");
    expect(html).not.toContain("留空使用 CLI 默认");
  });

  it("qoder 目录同样无该键", () => {
    expect(presets.FIELD_CATALOG.qoder.voiceModel).toBeUndefined();
    expect(presets.FIELD_CATALOG.opencode.voiceModel).toBeUndefined();
    expect(presets.FIELD_CATALOG["qwen-code"].voiceModel).toEqual({
      zh: "语音模型",
      en: "Voice model",
      type: "text",
      hint: "留空使用 CLI 默认",
    });
    // 独立分组名（不与 vision/image 共用标题）
    expect(presets.SECTION_LABELS.voiceModel).toEqual({
      zh: "语音（Voice）",
      en: "Voice",
    });
  });
});

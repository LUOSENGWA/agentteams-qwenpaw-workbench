// ModelPicker 纯函数：provider → model 过滤与换 Provider 的模型保留规则 +
// Provider 分组（groupModelPickerProviders：无分组平铺 / 首次出现序 / 兜底组）。
import { describe, expect, it } from "vitest";

import {
  groupModelPickerProviders,
  keepModelForProvider,
  modelOptionsForProvider,
} from "../src/lib/modelPickerModel";

const providers = [
  { name: "qwen", models: ["qwen3.6-27b-fp8", "qwen3.6-72b"] },
  { name: "deepseek", models: ["deepseek-flash"] },
];

describe("modelOptionsForProvider", () => {
  it("按 provider 过滤并保持顺序", () => {
    expect(modelOptionsForProvider(providers, "qwen")).toEqual([
      "qwen3.6-27b-fp8",
      "qwen3.6-72b",
    ]);
  });

  it("provider 为空 = 全量去重", () => {
    expect(modelOptionsForProvider(providers, "")).toEqual([
      "qwen3.6-27b-fp8",
      "qwen3.6-72b",
      "deepseek-flash",
    ]);
  });

  it("provider 未声明 models = 全量（不隐藏选项）", () => {
    expect(modelOptionsForProvider([{ name: "x" }], "x")).toEqual([]);
  });
});

describe("keepModelForProvider", () => {
  it("模型属于新 provider → 保留", () => {
    expect(keepModelForProvider(providers, "qwen", "qwen3.6-72b")).toBe("qwen3.6-72b");
  });

  it("模型不属于新 provider → 清空（避免提交不成立的 pair）", () => {
    expect(keepModelForProvider(providers, "deepseek", "qwen3.6-72b")).toBe("");
  });

  it("空模型 → 空", () => {
    expect(keepModelForProvider(providers, "qwen", "")).toBe("");
  });
});

describe("groupModelPickerProviders", () => {
  it("无 group → 单个未分组列表（label \"\"，成员顺序保持）", () => {
    const out = groupModelPickerProviders([
      { name: "a" },
      { name: "b", models: ["m"] },
    ]);
    expect(out).toEqual([{ label: "", providers: [{ name: "a" }, { name: "b", models: ["m"] }] }]);
  });

  it("空列表 → 单个未分组空列表", () => {
    expect(groupModelPickerProviders([])).toEqual([{ label: "", providers: [] }]);
  });

  it("全部同一 group → 单个带标签组（仍走分组渲染）", () => {
    const out = groupModelPickerProviders([
      { name: "a", group: "g" },
      { name: "b", group: "g" },
    ]);
    expect(out.map((g) => g.label)).toEqual(["g"]);
    expect(out[0].providers.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("带 group → 首次出现序分组；组内成员顺序保持", () => {
    const out = groupModelPickerProviders([
      { name: "fw", group: "跟随模式" },
      { name: "openai", group: "可用提供商" },
      { name: "spawn", group: "跟随模式" },
      { name: "worker:qwen", group: "可用提供商" },
    ]);
    expect(out.map((g) => g.label)).toEqual(["跟随模式", "可用提供商"]);
    expect(out[0].providers.map((p) => p.name)).toEqual(["fw", "spawn"]);
    expect(out[1].providers.map((p) => p.name)).toEqual(["openai", "worker:qwen"]);
  });

  it("混排无 group 成员 → 归入 defaultGroupLabel 一个组（不并入其他组）", () => {
    const out = groupModelPickerProviders(
      [
        { name: "a", group: "g1" },
        { name: "b" },
        { name: "c", group: "g2" },
        { name: "d" },
      ],
      "其他",
    );
    expect(out.map((g) => g.label)).toEqual(["g1", "其他", "g2"]);
    expect(out[1].providers.map((p) => p.name)).toEqual(["b", "d"]);
  });

  it("defaultGroupLabel 缺省 = \"\"（稳定空标签兜底）", () => {
    const out = groupModelPickerProviders([{ name: "a", group: "g" }, { name: "b" }]);
    expect(out.map((g) => g.label)).toEqual(["g", ""]);
  });
});

// ModelPicker 纯函数：provider → model 过滤与换 Provider 的模型保留规则。
import { describe, expect, it } from "vitest";

import {
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

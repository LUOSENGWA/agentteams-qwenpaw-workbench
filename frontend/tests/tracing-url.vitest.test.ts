// Dashboard Tracing 跳转地址（tracingUrl）纯函数测试。
// Tracing 是 Dashboard 能力，插件只跳转；dashboard tracing 页不支持
// URL 参数，故 URL 不拼接 worker/筛选条件。

import { describe, expect, it } from "vitest";

import { tracingUrl } from "../src/lib/tracingUrl";

describe("tracingUrl", () => {
  it("appends the tracing hash to an http(s) base", () => {
    expect(tracingUrl("http://localhost:13000")).toBe(
      "http://localhost:13000/#/console/governance/tracing",
    );
    expect(tracingUrl("https://dash.example.com")).toBe(
      "https://dash.example.com/#/console/governance/tracing",
    );
  });

  it("trims whitespace and trailing slashes", () => {
    expect(tracingUrl("  https://dash.example.com/  ")).toBe(
      "https://dash.example.com/#/console/governance/tracing",
    );
    expect(tracingUrl("https://dash.example.com///")).toBe(
      "https://dash.example.com/#/console/governance/tracing",
    );
  });

  it("keeps a path prefix", () => {
    expect(tracingUrl("https://example.com/workbench/")).toBe(
      "https://example.com/workbench/#/console/governance/tracing",
    );
  });

  it("adds https:// when the scheme is omitted", () => {
    expect(tracingUrl("localhost:13000")).toBe(
      "https://localhost:13000/#/console/governance/tracing",
    );
    expect(tracingUrl("dash.example.com")).toBe(
      "https://dash.example.com/#/console/governance/tracing",
    );
  });

  it("accepts explicit http even without a host dot", () => {
    expect(tracingUrl("http://10.0.0.5:13000")).toBe(
      "http://10.0.0.5:13000/#/console/governance/tracing",
    );
  });

  it("ignores query/hash — the tracing page takes no URL params", () => {
    expect(tracingUrl("https://dash.example.com/?worker=w1#/other")).toBe(
      "https://dash.example.com/#/console/governance/tracing",
    );
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(tracingUrl("")).toBeNull();
    expect(tracingUrl("   ")).toBeNull();
  });

  it("returns null for unsupported or unparsable links", () => {
    expect(tracingUrl("javascript:alert(1)")).toBeNull();
    expect(tracingUrl("ftp://dash.example.com")).toBeNull();
    expect(tracingUrl("https://")).toBeNull();
  });
});

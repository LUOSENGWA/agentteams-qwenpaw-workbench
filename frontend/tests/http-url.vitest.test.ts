// 地址协议自动识别（normalizeHttpUrl）纯函数测试。

import { describe, expect, it } from "vitest";

import { normalizeHttpUrl } from "../src/lib/httpUrl";

describe("normalizeHttpUrl", () => {
  it("prepends http:// when the scheme is missing", () => {
    expect(normalizeHttpUrl("192.168.54.107:6866")).toBe(
      "http://192.168.54.107:6866",
    );
    expect(normalizeHttpUrl("node1:8090/api")).toBe("http://node1:8090/api");
    expect(normalizeHttpUrl("controller.local")).toBe("http://controller.local");
  });

  it("keeps http/https and strips trailing slashes", () => {
    expect(normalizeHttpUrl("http://h:1/")).toBe("http://h:1");
    expect(normalizeHttpUrl("https://h/path//")).toBe("https://h/path");
    expect(normalizeHttpUrl("  HTTP://H:2  ")).toBe("http://H:2");
  });

  it("leaves other schemes untouched for the validator to reject", () => {
    expect(normalizeHttpUrl("ws://h:1")).toBe("ws://h:1");
    expect(normalizeHttpUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
  });

  it("handles empty input", () => {
    expect(normalizeHttpUrl("")).toBe("");
    expect(normalizeHttpUrl("   ")).toBe("");
  });
});

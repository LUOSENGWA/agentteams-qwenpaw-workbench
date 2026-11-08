// 地址协议自动识别（normalizeHttpUrl）纯函数测试。
// N：无协议**不再**补 http://（TLS 端口收明文回 400）——原样提交，
// 由后端保存/测试时按 https 优先探测（显式协议不覆盖）。

import { describe, expect, it } from "vitest";

import { normalizeHttpUrl } from "../src/lib/httpUrl";

describe("normalizeHttpUrl", () => {
  it("keeps scheme-less host:port verbatim for backend scheme resolution", () => {
    expect(normalizeHttpUrl("192.168.54.107:6866")).toBe(
      "192.168.54.107:6866",
    );
    expect(normalizeHttpUrl("node1:8090/api")).toBe("node1:8090/api");
    expect(normalizeHttpUrl("controller.local")).toBe("controller.local");
  });

  it("trims whitespace and trailing slashes on scheme-less input", () => {
    expect(normalizeHttpUrl("  host:6866/  ")).toBe("host:6866");
    expect(normalizeHttpUrl("host:6866//")).toBe("host:6866");
  });

  it("keeps http/https and strips trailing slashes", () => {
    expect(normalizeHttpUrl("http://h:1/")).toBe("http://h:1");
    expect(normalizeHttpUrl("https://h/path//")).toBe("https://h/path");
    expect(normalizeHttpUrl("  HTTP://H:2  ")).toBe("http://H:2");
  });

  it("does not upgrade an explicit http:// (only scheme-less input is probed)", () => {
    expect(normalizeHttpUrl("http://10.0.0.5:6866")).toBe(
      "http://10.0.0.5:6866",
    );
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

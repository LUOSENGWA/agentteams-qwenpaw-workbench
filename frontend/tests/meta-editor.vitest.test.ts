// meta 编辑器纯逻辑测试：错误分类 / JSON 校验 / If-Match 头。

import { describe, expect, it } from "vitest";

import {
  MetaApiError,
  buildMetaHeaders,
  classifyMetaError,
  validateMetaJson,
} from "../src/api/domains/meta";

describe("classifyMetaError", () => {
  it("maps status codes to kinds", () => {
    expect(classifyMetaError(new MetaApiError("HTTP 405", 405))).toBe(
      "unsupported",
    );
    expect(classifyMetaError(new MetaApiError("HTTP 404", 404))).toBe(
      "not_found",
    );
    expect(classifyMetaError(new MetaApiError("HTTP 401", 401))).toBe(
      "forbidden",
    );
    expect(classifyMetaError(new MetaApiError("HTTP 403", 403))).toBe(
      "forbidden",
    );
    expect(classifyMetaError(new MetaApiError("HTTP 428", 428))).toBe("other");
  });

  it("409 is conflict unless the body code says ambiguous_task", () => {
    expect(classifyMetaError(new MetaApiError("HTTP 409", 409))).toBe(
      "conflict",
    );
    expect(
      classifyMetaError(new MetaApiError("HTTP 409", 409, "conflict")),
    ).toBe("conflict");
    expect(
      classifyMetaError(new MetaApiError("HTTP 409", 409, "ambiguous_task")),
    ).toBe("ambiguous");
  });

  it("falls back to the HTTP prefix in plain Error messages", () => {
    expect(classifyMetaError(new Error("HTTP 405: nope"))).toBe("unsupported");
    expect(classifyMetaError(new Error("boom"))).toBe("other");
  });
});

describe("validateMetaJson", () => {
  it("accepts an object and an empty object (clear semantics)", () => {
    expect(validateMetaJson('{"a":1}')).toEqual({ ok: true });
    expect(validateMetaJson("{}")).toEqual({ ok: true });
  });

  it("rejects empty / invalid JSON / non-objects", () => {
    expect(validateMetaJson("   ")).toEqual({ ok: false, error: "empty" });
    expect(validateMetaJson("{oops")).toEqual({
      ok: false,
      error: "invalid_json",
    });
    expect(validateMetaJson("[1,2]")).toEqual({
      ok: false,
      error: "not_object",
    });
    expect(validateMetaJson("42")).toEqual({ ok: false, error: "not_object" });
  });
});

describe("buildMetaHeaders", () => {
  it("PUT carries If-Match and JSON content type", () => {
    expect(buildMetaHeaders("PUT", "abc123")).toEqual({
      "Content-Type": "application/json",
      "If-Match": "abc123",
    });
  });

  it("PUT without an ETag sends no If-Match (server answers 428)", () => {
    expect(buildMetaHeaders("PUT")).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("GET has no conditional header", () => {
    expect(buildMetaHeaders("GET", "abc")).toEqual({});
  });
});

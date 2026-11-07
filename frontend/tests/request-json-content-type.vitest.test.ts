import { describe, expect, it } from "vitest";

import { withJsonContentType } from "../src/api/shared";

describe("withJsonContentType", () => {
  it("adds application/json for a string body without a content-type", () => {
    const init = withJsonContentType({ method: "POST", body: '{"a":1}' });
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("keeps an explicit content-type (case-insensitive)", () => {
    const init = withJsonContentType({
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    expect(new Headers(init?.headers).get("content-type")).toBe("text/plain");
  });

  it("leaves bodyless and non-string bodies untouched", () => {
    expect(withJsonContentType({ method: "POST" })?.headers).toBeUndefined();
    const fd = new FormData();
    const init = { method: "POST", body: fd } as RequestInit;
    expect(withJsonContentType(init)).toBe(init);
  });
});

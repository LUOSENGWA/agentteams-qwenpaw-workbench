// #1544 文件正文 ETag 缓存纯逻辑测试：
// 304 命中 / 200 更新 / 无 ETag 不缓存 / LRU 淘汰 / 非 200 原样返回。

import { describe, expect, it } from "vitest";

import {
  FileEtagCache,
  readFileThroughCache,
  type FileCacheEntry,
} from "../src/lib/fileEtagCache";

const sleep = () => Promise.resolve();

function entry(etag: string, text: string, type = "text/plain"): FileCacheEntry {
  return {
    etag,
    // 复制到独立 ArrayBuffer（encode() 的视图可能大于内容）
    bytes: new TextEncoder().encode(text).slice().buffer as ArrayBuffer,
    type,
  };
}

const notModified = (etag: string) =>
  new Response(null, { status: 304, headers: { ETag: etag } });

const ok = (text: string, etag?: string) =>
  new Response(text, {
    status: 200,
    headers: etag ? { ETag: etag } : {},
  });

describe("FileEtagCache (LRU)", () => {
  it("evicts the least recently used entry past the limit", () => {
    const cache = new FileEtagCache(2);
    cache.set("a", entry('"a"', "A"));
    cache.set("b", entry('"b"', "B"));
    // 访问 b → b 变为最近使用；再写 c → 淘汰 a
    expect(cache.get("b")).toBeDefined();
    cache.set("c", entry('"c"', "C"));
    expect(cache.keys()).toEqual(["b", "c"]);
    expect(cache.get("a")).toBeUndefined();
  });

  it("ignores entries without etag", () => {
    const cache = new FileEtagCache(2);
    cache.set("a", entry("", "A"));
    expect(cache.size).toBe(0);
  });
});

describe("readFileThroughCache", () => {
  it("reuses cached bytes on 304 and sends If-None-Match", async () => {
    const cache = new FileEtagCache(4);
    cache.set("luo:notes/a.md", entry('"v1"', "# hello", "text/markdown"));
    const seen: Array<RequestInit | undefined> = [];
    const r = await readFileThroughCache(
      "luo:notes/a.md",
      async (init) => {
        seen.push(init);
        return notModified('"v1"');
      },
      cache,
    );
    expect(seen[0]?.headers).toEqual({ "If-None-Match": '"v1"' });
    expect(r.kind).toBe("cached");
    if (r.kind !== "cached") throw new Error("unreachable");
    expect(await r.blob.text()).toBe("# hello");
    expect(r.blob.type).toBe("text/markdown");
  });

  it("updates the cache on 200 and serves 304 from it afterwards", async () => {
    const cache = new FileEtagCache(4);
    const first = await readFileThroughCache(
      "k",
      async () => ok("body-v2", '"v2"'),
      cache,
    );
    expect(first.kind).toBe("fresh");
    const stored = cache.get("k");
    expect(stored?.etag).toBe('"v2"');
    expect(new TextDecoder().decode(stored?.bytes)).toBe("body-v2");

    // 第二次：带条件头 → 304 → 缓存内容
    let secondInit: RequestInit | undefined;
    const second = await readFileThroughCache(
      "k",
      async (init) => {
        secondInit = init;
        await sleep();
        return notModified('"v2"');
      },
      cache,
    );
    expect(secondInit?.headers).toEqual({ "If-None-Match": '"v2"' });
    expect(second.kind).toBe("cached");
    if (second.kind !== "cached") throw new Error("unreachable");
    expect(await second.blob.text()).toBe("body-v2");
  });

  it("does not cache or send conditions when the response has no ETag", async () => {
    const cache = new FileEtagCache(4);
    const first = await readFileThroughCache("k", async () => ok("plain"), cache);
    expect(first.kind).toBe("fresh");
    expect(cache.size).toBe(0);

    let secondInit: RequestInit | undefined;
    await readFileThroughCache(
      "k",
      async (init) => {
        secondInit = init;
        return ok("plain");
      },
      cache,
    );
    expect(secondInit).toBeUndefined();
  });

  it("passes through non-200/304 responses unchanged (401/404 semantics)", async () => {
    const cache = new FileEtagCache(4);
    const r = await readFileThroughCache(
      "k",
      async () => new Response("nope", { status: 404 }),
      cache,
    );
    expect(r.kind).toBe("response");
    if (r.kind !== "response") throw new Error("unreachable");
    expect(r.response.status).toBe(404);
    expect(cache.size).toBe(0);
  });
});

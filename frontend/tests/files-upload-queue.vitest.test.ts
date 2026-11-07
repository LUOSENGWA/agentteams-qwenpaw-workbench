// 上传队列纯模型：并发上限（≤2）/ 失败重试 / 状态流转 / 进度汇总。
import { describe, expect, it } from "vitest";

import {
  UPLOAD_CONCURRENCY,
  makeUploadItems,
  markUploadStatus,
  retryUpload,
  startableIds,
  uploadProgress,
} from "../src/manage/files/uploadQueue";

const FILES = [
  { name: "a.txt", size: 1 },
  { name: "b.txt", size: 2 },
  { name: "c.txt", size: 3 },
];

describe("makeUploadItems — 多选入队", () => {
  it("全部 waiting，目标路径 = 目录 + 文件名", () => {
    const items = makeUploadItems(FILES, "docs", "q0-");
    expect(items.map((i) => i.status)).toEqual(["waiting", "waiting", "waiting"]);
    expect(items.map((i) => i.path)).toEqual(["docs/a.txt", "docs/b.txt", "docs/c.txt"]);
    expect(items[0].id).toBe("q0-0-a.txt");
  });

  it("根目录（dir = \"\"）→ 直接文件名", () => {
    const items = makeUploadItems([{ name: "a.txt", size: 1 }], "");
    expect(items[0].path).toBe("a.txt");
  });
});

describe("并发上限（任务书必测：并发 ≤ 2）", () => {
  it("UPLOAD_CONCURRENCY = 2；3 个 waiting → 一次只放 2 个", () => {
    expect(UPLOAD_CONCURRENCY).toBe(2);
    const items = makeUploadItems(FILES, "");
    const batch = startableIds(items);
    expect(batch).toEqual([items[0].id, items[1].id]);
  });

  it("在途 2 个 → 不能再启动；完成一个 → 补位启动第 3 个", () => {
    const items = makeUploadItems(FILES, "");
    let s = markUploadStatus(items, items[0].id, "uploading");
    s = markUploadStatus(s, items[1].id, "uploading");
    expect(startableIds(s)).toEqual([]);
    s = markUploadStatus(s, items[0].id, "success");
    expect(startableIds(s)).toEqual([items[2].id]);
  });

  it("自定义 limit = 1（仲裁按参数生效）", () => {
    const items = makeUploadItems(FILES, "");
    expect(startableIds(items, 1)).toEqual([items[0].id]);
  });
});

describe("失败重试（任务书必测）", () => {
  it("failed → retryUpload 回 waiting 并清空错误；可再次启动", () => {
    const items = makeUploadItems([{ name: "a.txt", size: 1 }], "");
    const failed = markUploadStatus(items, items[0].id, "failed", "网络错误");
    expect(failed[0].status).toBe("failed");
    expect(failed[0].error).toBe("网络错误");
    expect(startableIds(failed)).toEqual([]);

    const retried = retryUpload(failed, items[0].id);
    expect(retried[0].status).toBe("waiting");
    expect(retried[0].error).toBeUndefined();
    expect(startableIds(retried)).toEqual([items[0].id]);
  });

  it("非 failed 项重试 → 原样返回（同引用，不触发重渲染）", () => {
    const items = makeUploadItems([{ name: "a.txt", size: 1 }], "");
    expect(retryUpload(items, items[0].id)).toBe(items);
  });

  it("除 failed 外状态迁移清空 error（uploading / success）", () => {
    const items = makeUploadItems([{ name: "a.txt", size: 1 }], "");
    const failed = markUploadStatus(items, items[0].id, "failed", "boom");
    const retried = retryUpload(failed, items[0].id);
    const uploading = markUploadStatus(retried, items[0].id, "uploading");
    expect(uploading[0].status).toBe("uploading");
    expect(uploading[0].error).toBeUndefined();
    const success = markUploadStatus(uploading, items[0].id, "success");
    expect(success[0].status).toBe("success");
    expect(success[0].error).toBeUndefined();
  });

  it("状态无变化 → 原样返回（幂等）", () => {
    const items = makeUploadItems([{ name: "a.txt", size: 1 }], "");
    expect(markUploadStatus(items, items[0].id, "waiting")).toBe(items);
    expect(markUploadStatus(items, "ghost", "success")).toBe(items);
  });
});

describe("uploadProgress — 总进度", () => {
  it("完成数 = success + failed；percent 取整", () => {
    let items = makeUploadItems(FILES, "");
    items = markUploadStatus(items, items[0].id, "success");
    items = markUploadStatus(items, items[1].id, "uploading");
    items = markUploadStatus(items, items[2].id, "failed", "x");
    const p = uploadProgress(items);
    expect(p.total).toBe(3);
    expect(p.success).toBe(1);
    expect(p.failed).toBe(1);
    expect(p.uploading).toBe(1);
    expect(p.waiting).toBe(0);
    expect(p.finished).toBe(2);
    expect(p.percent).toBe(67);
  });

  it("空队列 → 0 / 0", () => {
    expect(uploadProgress([])).toMatchObject({ total: 0, finished: 0, percent: 0 });
  });
});

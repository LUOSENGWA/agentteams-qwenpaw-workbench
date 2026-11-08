// 聊天图片灯箱纯逻辑（lib/mediaGallery）：画廊分组口径 + 缩放/平移/
// 索引边界。组件侧（MediaViewer）只消费这些纯函数，规则在单点定义。

import { describe, expect, it } from "vitest";

import {
  collectGallery,
  clampPan,
  clampZoom,
  isGalleryImage,
  mediaKindOf,
  nextIndex,
  prevIndex,
  DOUBLE_CLICK_ZOOM,
  ZOOM_MAX,
  ZOOM_MIN,
  type GallerySourceMessage,
} from "../src/lib/mediaGallery";

const SENDER = "@worker:hs";
const OTHER = "@other:hs";

function im(
  id: string,
  extra: Partial<GallerySourceMessage> = {},
): GallerySourceMessage {
  return {
    event_id: id,
    sender: SENDER,
    msgtype: "m.image",
    url: `mxc://hs/${id}`,
    body: `${id}.png`,
    ...extra,
  };
}

describe("collectGallery", () => {
  it("single image → one item at index 0", () => {
    const got = collectGallery([im("$a")], "$a");
    expect(got).not.toBeNull();
    expect(got!.items.map((i) => i.eventId)).toEqual(["$a"]);
    expect(got!.index).toBe(0);
  });

  it("collects a run of consecutive images from the same sender", () => {
    const messages = [im("$a"), im("$b"), im("$c")];
    expect(collectGallery(messages, "$b")).toEqual({
      items: [
        { eventId: "$a", url: "mxc://hs/$a", name: "$a.png" },
        { eventId: "$b", url: "mxc://hs/$b", name: "$b.png" },
        { eventId: "$c", url: "mxc://hs/$c", name: "$c.png" },
      ],
      index: 1,
    });
  });

  it("any other message breaks the run", () => {
    const text: GallerySourceMessage = {
      event_id: "$t",
      sender: SENDER,
      msgtype: "m.text",
      body: "hi",
    };
    const messages = [im("$a"), text, im("$b"), im("$c")];
    expect(collectGallery(messages, "$c")!.items.map((i) => i.eventId)).toEqual([
      "$b",
      "$c",
    ]);
    expect(collectGallery(messages, "$a")!.items.map((i) => i.eventId)).toEqual([
      "$a",
    ]);
  });

  it("a different sender breaks the run", () => {
    const messages = [im("$a"), im("$b", { sender: OTHER }), im("$c")];
    expect(collectGallery(messages, "$c")!.items.map((i) => i.eventId)).toEqual([
      "$c",
    ]);
  });

  it("image-like m.file joins the gallery, non-image m.file does not", () => {
    const imageFile = im("$f", { msgtype: "m.file", mimetype: "image/png", filename: "shot.png" });
    const pdf = im("$p", { msgtype: "m.file", mimetype: "application/pdf", filename: "doc.pdf" });
    const messages = [im("$a"), imageFile, pdf];
    expect(collectGallery(messages, "$f")!.items.map((i) => i.eventId)).toEqual([
      "$a",
      "$f",
    ]);
    expect(collectGallery(messages, "$f")!.items[1].name).toBe("shot.png");
    expect(collectGallery(messages, "$p")).toBeNull();
  });

  it("redacted images and messages without url never join", () => {
    const messages = [
      im("$a"),
      im("$gone", { redacted: true }),
      im("$nourl", { url: undefined }),
      im("$b"),
    ];
    expect(collectGallery(messages, "$b")!.items.map((i) => i.eventId)).toEqual([
      "$b",
    ]);
    expect(collectGallery(messages, "$gone")).toBeNull();
  });

  it("missing event id → null", () => {
    expect(collectGallery([im("$a")], "$missing")).toBeNull();
  });

  it("isGalleryImage only accepts m.image / image m.file with url", () => {
    expect(isGalleryImage(im("$a"))).toBe(true);
    expect(isGalleryImage(im("$a", { msgtype: "m.text" }))).toBe(false);
    expect(isGalleryImage(im("$a", { url: undefined }))).toBe(false);
    expect(
      isGalleryImage(im("$a", { msgtype: "m.file", mimetype: "image/jpeg" })),
    ).toBe(true);
    expect(
      isGalleryImage(im("$a", { msgtype: "m.file", mimetype: "video/mp4" })),
    ).toBe(false);
  });
});

describe("clampZoom", () => {
  it("clamps into [0.5, 4]", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it("invalid values fall back to 1x", () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(-2)).toBe(1);
  });

  it("double-click target is inside the clamp range", () => {
    expect(clampZoom(DOUBLE_CLICK_ZOOM)).toBe(DOUBLE_CLICK_ZOOM);
  });
});

describe("nextIndex / prevIndex", () => {
  it("moves by one and stops at the ends (no wrap)", () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBe(2);
    expect(prevIndex(2, 3)).toBe(1);
    expect(prevIndex(0, 3)).toBe(0);
  });

  it("empty list → 0", () => {
    expect(nextIndex(0, 0)).toBe(0);
    expect(prevIndex(0, 0)).toBe(0);
  });

  it("out-of-range input is clamped into the list", () => {
    expect(nextIndex(-5, 3)).toBe(0);
    expect(nextIndex(99, 3)).toBe(2);
    expect(prevIndex(99, 3)).toBe(2);
    expect(prevIndex(-5, 3)).toBe(0);
  });
});

describe("clampPan", () => {
  it("no panning at 1x", () => {
    expect(clampPan({ x: 40, y: -40 }, 1, 800, 600)).toEqual({ x: 0, y: 0 });
  });

  it("keeps in-range offsets and clamps out-of-range ones", () => {
    // 2x：可视区 800x600 → 可平移 ±400 / ±300
    expect(clampPan({ x: 100, y: -100 }, 2, 800, 600)).toEqual({
      x: 100,
      y: -100,
    });
    expect(clampPan({ x: 9999, y: -9999 }, 2, 800, 600)).toEqual({
      x: 400,
      y: -300,
    });
  });

  it("uses the clamped zoom when given an out-of-range zoom", () => {
    // 0.5x 也被夹回 1x 之前的可用区间 → 不产生平移
    expect(clampPan({ x: 50, y: 50 }, 0.2, 800, 600)).toEqual({ x: 0, y: 0 });
  });
});

describe("mediaKindOf", () => {
  it("prefers mimetype", () => {
    expect(mediaKindOf({ msgtype: "m.file", mimetype: "image/webp" })).toBe("image");
    expect(mediaKindOf({ msgtype: "m.file", mimetype: "video/mp4" })).toBe("video");
    expect(mediaKindOf({ msgtype: "m.file", mimetype: "audio/mpeg" })).toBe("audio");
    expect(mediaKindOf({ msgtype: "m.file", mimetype: "application/pdf" })).toBe("file");
  });

  it("falls back to msgtype then extension", () => {
    expect(mediaKindOf({ msgtype: "m.image" })).toBe("image");
    expect(mediaKindOf({ msgtype: "m.video" })).toBe("video");
    expect(mediaKindOf({ msgtype: "m.audio" })).toBe("audio");
    expect(mediaKindOf({ msgtype: "m.file", filename: "clip.MP4" })).toBe("video");
    expect(mediaKindOf({ msgtype: "m.file", body: "voice.ogg" })).toBe("audio");
    expect(mediaKindOf({ msgtype: "m.file", filename: "notes.md" })).toBe("file");
    expect(mediaKindOf({ msgtype: "m.file" })).toBe("file");
  });
});

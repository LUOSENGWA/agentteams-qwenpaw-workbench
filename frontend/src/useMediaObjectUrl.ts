import type * as ReactNS from "react";

// v0.5.0-beta.12: React 必须取宿主的（window.QwenPaw.host.React）——全代码库唯一模式
// （各组件 `import type * as ReactNS` + `const React = host.React`）。
const React: typeof ReactNS = window.QwenPaw.host.React;

/**
 * v0.5.0-beta.12: mxc 媒体 → host.fetch blob → objectURL（供 img src / a href 使用）。
 *
 * 背景：宿主把插件路由挂在 /api + prefix 下，且 /api 需要鉴权头；
 * `<img src>` / `<a href>` 是裸导航，带不了 Authorization 头——直接指向
 * 裸插件路径会落进 SPA 兜底（index.html 壳），指向解析后的 /api 路径会 401。
 * 唯一安全路径：先经 host.fetch（自动带鉴权）取 blob，再挂 objectURL。
 *
 * v0.5.0-beta.14.17：模块级缓存 + in-flight 去重
 * （与 useAvatar 同模式）。旧版每个组件实例各自 fetch、卸载即
 * revokeObjectURL——切房/滚动重挂时同一条媒体的 blob 被反复重拉
 * （dial-stats /media 端点每 remount +1）。媒体 objectURL 页面生命周期
 * 内共享复用、不再 revoke（同头像：blob 常驻，桌面壳内存可承受；
 * 上限 300 条后新条目只取不缓存，防无界增长）。
 *
 * 无 apiPath（http 直链）时原样返回 fallbackUrl。
 */
const mediaCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const MEDIA_CACHE_CAP = 300;
// 超 cap 未入缓存的 objectURL 的实例引用计数（apiPath → 持有数）：
// 满后新 URL 不入缓存，但同 apiPath 的多组件实例经 in-flight 共享同一
// URL——卸载时引用计数归零才 revoke（过早 revoke 会裂其他实例的图；
// 不 revoke 则不可回收 blob 常驻，图片可达数 MB）。
const nonCachedOwners = new Map<string, number>();

function fetchMediaObjectUrl(apiPath: string): Promise<string> {
  const hit = mediaCache.get(apiPath);
  if (hit) return Promise.resolve(hit);
  const p = inflight.get(apiPath);
  if (p) return p;
  const fresh = (async () => {
    const host = window.QwenPaw?.host;
    if (!host || typeof host.fetch !== "function") {
      throw new Error("no host.fetch");
    }
    const resp = await host.fetch(apiPath);
    if (!resp.ok) throw new Error(String(resp.status));
    const url = URL.createObjectURL(await resp.blob());
    if (mediaCache.size < MEDIA_CACHE_CAP) mediaCache.set(apiPath, url);
    return url;
  })();
  inflight.set(apiPath, fresh);
  fresh.then(
    () => {
      inflight.delete(apiPath);
    },
    () => {
      inflight.delete(apiPath);
    },
  );
  return fresh;
}

export function useMediaObjectUrl(
  apiPath: string | undefined,
  fallbackUrl: string,
): string {
  const [obj, setObj] = React.useState<string>(() =>
    apiPath ? (mediaCache.get(apiPath) ?? "") : fallbackUrl,
  );

  React.useEffect(() => {
    if (!apiPath) {
      setObj(fallbackUrl);
      return;
    }
    // 缓存命中：首帧已由 useState 初始值回填，这里只兜异步竞态。
    const cached = mediaCache.get(apiPath);
    if (cached) {
      setObj(cached);
      return;
    }
    let alive = true;
    let ownedUrl: string | undefined;
    let share = 0; // 1 = 我持有一个未入缓存 URL 的引用（见 nonCachedOwners）
    void fetchMediaObjectUrl(apiPath)
      .then((url) => {
        ownedUrl = url;
        if (!mediaCache.has(apiPath)) {
          share = (nonCachedOwners.get(apiPath) ?? 0) + 1;
          nonCachedOwners.set(apiPath, share);
        }
        if (alive) setObj(url);
      })
      .catch(() => {
        if (alive) setObj(fallbackUrl);
      });
    return () => {
      alive = false;
      // 已入缓存的 URL 由模块缓存持有（其他实例共享），不 revoke；
      // 未入缓存（超 cap）的由引用计数归零时统一回收。
      if (share > 0 && ownedUrl !== undefined) {
        const left = (nonCachedOwners.get(apiPath) ?? share) - 1;
        if (left <= 0) {
          nonCachedOwners.delete(apiPath);
          URL.revokeObjectURL(ownedUrl);
        } else {
          nonCachedOwners.set(apiPath, left);
        }
      }
    };
  }, [apiPath, fallbackUrl]);

  return obj;
}

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
 * v0.5.0-beta.14.17（T181 审计 #29 P2）：模块级缓存 + in-flight 去重
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
    void fetchMediaObjectUrl(apiPath)
      .then((url) => {
        if (alive) setObj(url);
      })
      .catch(() => {
        if (alive) setObj(fallbackUrl);
      });
    return () => {
      // 不再 revokeObjectURL——objectURL 已入模块缓存供其他实例共享。
      alive = false;
    };
  }, [apiPath, fallbackUrl]);

  return obj;
}

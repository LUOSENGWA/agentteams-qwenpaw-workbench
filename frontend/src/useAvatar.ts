import type * as ReactNS from "react";

import { mxcToMediaUrl } from "./api";

// v0.4.87: React 必须取宿主的（window.QwenPaw.host.React）——全代码库唯一模式。
const React: typeof ReactNS = window.QwenPaw.host.React;

/**
 * v0.4.98 再版 11：头像 mxc 裂图修（8 处统一）。
 *
 * 背景：Matrix 成员头像 url 是 mxc://——浏览器 img src 直接指向 mxc://
 * 无法加载（不是合法 URL scheme），指向裸插件路径又带不了鉴权头。
 * 修法与文件媒体同源：host.fetch（自动带鉴权）经插件媒体代理取 blob →
 * objectURL 挂 img；加载中/失败返回 undefined → antd.Avatar 落首字母
 * 兜底（不再裂图）。
 *
 * 与 useMediaObjectUrl 的区别：头像同一 mxc 在消息流/成员列表/话题面板/
 * 团队页会重复出现 N 次——模块级缓存（objectURL 不 revoke，头像体积小、
 * 页面生命周期内复用）+ in-flight 去重（并发首载只发一次请求）。
 */
const avatarCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function useAvatarUrl(
  url: string | null | undefined,
): string | undefined {
  const [obj, setObj] = React.useState<string | undefined>(() =>
    url && !url.startsWith("mxc://") ? url : avatarCache.get(url || ""),
  );

  React.useEffect(() => {
    if (!url) {
      setObj(undefined);
      return;
    }
    // 非 mxc（http 直链头像等）浏览器可直载，原样返回。
    if (!url.startsWith("mxc://")) {
      setObj(url);
      return;
    }
    const hit = avatarCache.get(url);
    if (hit) {
      setObj(hit);
      return;
    }
    let alive = true;
    let p = inflight.get(url);
    if (!p) {
      p = (async () => {
        const path = mxcToMediaUrl(url);
        if (!path) throw new Error("unparseable mxc avatar");
        const host = window.QwenPaw?.host;
        if (!host || typeof host.fetch !== "function") {
          throw new Error("no host.fetch");
        }
        const resp = await host.fetch(path);
        if (!resp.ok) throw new Error(String(resp.status));
        return URL.createObjectURL(await resp.blob());
      })();
      inflight.set(url, p);
      p.then(
        (u) => {
          avatarCache.set(url, u);
          inflight.delete(url);
        },
        () => {
          inflight.delete(url);
        },
      );
    }
    p.then(
      (u) => {
        if (alive) setObj(u);
      },
      () => {
        /* 失败保持 undefined → 首字母兜底 */
      },
    );
    return () => {
      alive = false;
    };
  }, [url]);

  return obj;
}

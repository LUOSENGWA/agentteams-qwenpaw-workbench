import type * as ReactNS from "react";

// v0.4.87: React 必须取宿主的（window.QwenPaw.host.React）——全代码库唯一模式
// （各组件 `import type * as ReactNS` + `const React = host.React`）。
// v0.4.85（9fe8a4a）本文件误写 value import `import React from "react"` →
// rollup 把 react externalize → dist 带裸 `import ... from "react"` → 宿主
// blob-URL loader 无 import map 解析不了裸说明符（TypeError: Failed to
// resolve module specifier "react"）→ "0/1 plugin(s) loaded" → 侧边栏/App
// 全消失。v0.4.85 后「装了没加载」的根因即此；此前能跑是因为旧页面还活着
// v0.4.84 的自包含 bundle（dist 零 import）。
const React: typeof ReactNS = window.QwenPaw.host.React;

/**
 * v0.4.85: mxc 媒体 → host.fetch blob → objectURL（供 img src / a href 使用）。
 *
 * 背景：宿主把插件路由挂在 /api + prefix 下，且 /api 需要鉴权头；
 * `<img src>` / `<a href>` 是裸导航，带不了 Authorization 头——直接指向
 * 裸插件路径会落进 SPA 兜底（index.html 壳），指向解析后的 /api 路径会 401。
 * 唯一安全路径：先经 host.fetch（自动带鉴权）取 blob，再挂 objectURL。
 *
 * 无 apiPath（http 直链）时原样返回 fallbackUrl。
 */
export function useMediaObjectUrl(
  apiPath: string | undefined,
  fallbackUrl: string,
): string {
  const [obj, setObj] = React.useState<string>(apiPath ? "" : fallbackUrl);

  React.useEffect(() => {
    if (!apiPath) {
      setObj(fallbackUrl);
      return;
    }
    let alive = true;
    let created = "";
    void (async () => {
      try {
        const host = window.QwenPaw?.host;
        if (host && typeof host.fetch === "function") {
          const resp = await host.fetch(apiPath);
          if (resp.ok) {
            created = URL.createObjectURL(await resp.blob());
            if (alive) {
              setObj(created);
              return;
            }
          }
        }
      } catch {
        /* fall through → 直链兜底 */
      }
      if (alive) setObj(fallbackUrl);
    })();
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [apiPath, fallbackUrl]);

  return obj;
}

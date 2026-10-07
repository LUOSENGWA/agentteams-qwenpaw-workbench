// QwenPaw ≥2.2.2 宿主主题跟随（插件配色跟随宿主 Console 主题色）。
//
// 宿主接口（qwenpaw 2.2.2 源码实证，app/routers/config.py）：
// GET /config/theme → 稀疏 ThemeConfig
// { accent?, accent_hover?, accent_bg?, radius?, dark?{accent?,accent_bg?,surface?} }
// 返回 {} = 宿主使用内置默认（2.2.x 默认 accent = #FF7F16）。
// 桥 = window.QwenPaw.host.fetch（自动注 Authorization/X-Agent-Id，同源）。
// 旧宿主（<2.2.2 无 /config/theme）→ 404/异常 → null → DEFAULT_ACCENT（= 现行硬编码色，行为不变）。

import type * as ReactNS from "react";

const host = window.QwenPaw.host;

interface HostThemeDark {
  accent?: string;
  accent_bg?: string;
  surface?: string;
}

interface HostTheme {
  accent?: string;
  accent_hover?: string;
  accent_bg?: string;
  radius?: string;
  dark?: HostThemeDark;
}

/** 2.2.x 宿主内置默认主色（= 宿主 defaultConfig.theme.colorPrimary）。 */
const DEFAULT_ACCENT = "#FF7F16";

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function safeHex(v: string | undefined): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

/** 指定模式下的宿主主色（dark → dark.accent ?? accent）。非法值回退默认。 */
export function hostAccentForMode(
  theme: HostTheme | null,
  mode: "light" | "dark",
): string {
  if (!theme) return DEFAULT_ACCENT;
  const v =
    mode === "dark" ? (theme.dark?.accent ?? theme.accent) : theme.accent;
  return safeHex(v) ? v : DEFAULT_ACCENT;
}

/** 指定模式下的主色浅底（accent_bg；dark → dark.accent_bg ?? accent_bg）。 */
function hostAccentBgForMode(
  theme: HostTheme | null,
  mode: "light" | "dark",
): string | undefined {
  if (!theme) return undefined;
  const v =
    mode === "dark"
      ? (theme.dark?.accent_bg ?? theme.accent_bg)
      : theme.accent_bg;
  return safeHex(v) ? v : undefined;
}

// v0.5.0-beta.14.18：插件主题**与宿主对齐 = 页面加载读一次，
// 不跟随、不轮询**。
// 背景：宿主改主题色在部分实例/版本上是刷新页面才生效（不实时应用），
// 插件若做实时跟随会先于宿主变色，造成插件/宿主颜色失配（比不跟随更糟）。
//
// 场景矩阵（为什么不做实时跟随）：
// 宿主实时改色（含 #7741 previewTheme 链的新版，v2.2.2-beta.1+）：
// 跟随 → 同步 ✓
// 宿主仅刷新生效（旧版宿主 / 部分实例）：
// 跟随 → 插件先于宿主变色 → 插件蓝宿主橙 → **失配（比不跟随更糟）**
//
// 对齐机制：
// - fetchHostTheme()：页面生命周期内读一次（单飞 + 模块缓存）；
// - 主题对齐的主力 = **CSS 变量**（本批 accent 全面变量化）：宿主刷新时
// App.tsx 把生效主题写 :root 变量（--app-accent 等，2.2.2b4 源码实证），
// 插件页面随之重挂载，var(--app-accent, #FF7F16) 自动继承新色——
// 零 JS 重渲染、零轮询；
// - useHostTheme()：antd token 消费方，diff 门控 setState（旧宿主/取不到
// = null → 消费方回退 DEFAULT_ACCENT，与 CSS 变量 fallback 同源同值）。

// ── v0.5.0-beta.14.20：首帧同步主题（用户 14.19 验收：「每个有主题色的
// 组件加载主题色的逻辑和时间不一样」）。根因：CSS 变量组件首帧即宿主色，
// antd token 组件要等 /config/theme 网络返回 → 先闪 DEFAULT_ACCENT 再
// 变宿主色——不同组件"上色时间"不同。修法=单一事实源优先：宿主 App.tsx
// 页面加载时已把生效主题写 :root（--app-accent 等，2.2.2b4 源码实证；
// 14.18「对齐宿主刷新语义」的主力机制）——插件首渲染同步读变量，零网络
// 零闪动；/config/theme 降级为补全（radius 等细节）与旧宿主兜底。
// 模块级快照：变量只在宿主整页刷新时变（=本模块重建），读一次即可。
let _cssVarSnapshot: {
  accent: string;
  accent_hover?: string;
  accent_bg?: string;
} | null | undefined;
function readAccentFromCssVars(): {
  accent: string;
  accent_hover?: string;
  accent_bg?: string;
} | null {
  if (_cssVarSnapshot !== undefined) return _cssVarSnapshot;
  _cssVarSnapshot = null;
  try {
    if (typeof window === "undefined" || !window.getComputedStyle)
      return null;
    const vars = window.getComputedStyle(document.documentElement);
    const accent = (vars.getPropertyValue("--app-accent") || "").trim();
    if (!safeHex(accent)) return null; // 未写变量/非 hex → 走 fetch 路径
    const out: {
      accent: string;
      accent_hover?: string;
      accent_bg?: string;
    } = { accent };
    const hover = (vars.getPropertyValue("--app-accent-hover") || "").trim();
    if (safeHex(hover)) out.accent_hover = hover;
    const bg = (vars.getPropertyValue("--app-accent-bg") || "").trim();
    if (safeHex(bg)) out.accent_bg = bg;
    _cssVarSnapshot = out;
  } catch {
    /* 无 DOM → null */
  }
  return _cssVarSnapshot;
}

/** 首帧同步主题：CSS 变量可得 → 直接构造（亮/暗槽同值——:root 变量是
 * 宿主当前生效主题，模式已解析，hostAccentForMode 两种模式取同一生效色）；
 * 不可得 → null（调用方走 fetch 异步路径，行为与 14.19 及以前一致）。 */
export function syncHostTheme(): HostTheme | null {
  const v = readAccentFromCssVars();
  if (!v) return null;
  const dark: HostThemeDark = {
    accent: v.accent,
    ...(v.accent_bg ? { accent_bg: v.accent_bg } : {}),
  };
  return {
    accent: v.accent,
    ...(v.accent_hover ? { accent_hover: v.accent_hover } : {}),
    ...(v.accent_bg ? { accent_bg: v.accent_bg } : {}),
    dark,
  };
}

let _themePromise: Promise<HostTheme | null> | null = null;

/** 读宿主生效主题（稀疏）。页面生命周期内读一次（单飞缓存）。 */
function fetchHostTheme(): Promise<HostTheme | null> {
  if (!_themePromise) {
    _themePromise = (async () => {
      try {
        if (typeof host.fetch !== "function") return null;
        const res = await host.fetch("/config/theme");
        if (!res.ok) return null;
        const j: unknown = await res.json().catch(() => null);
        if (!j || typeof j !== "object" || Array.isArray(j)) return null;
        return j as HostTheme;
      } catch {
        return null;
      }
    })();
  }
  return _themePromise;
}

const React: typeof ReactNS = host.React;

/** 读宿主主题（组件内）。旧宿主/取不到 = null（消费方各自回退）。
 * 页面加载读一次（与宿主「刷新才更新」行为对齐，14.18）。 */
export function useHostTheme(): HostTheme | null {
  // v0.5.0-beta.14.20：初始态=同步 CSS 变量主题（首帧即宿主色，antd
  // token 组件不再先闪默认橙）；旧宿主/无变量 → null（与旧行为一致）。
  const [theme, setTheme] = React.useState<HostTheme | null>(() =>
    syncHostTheme(),
  );
  React.useEffect(() => {
    let alive = true;
    void fetchHostTheme().then((t) => {
      if (!alive) return;
      const sync = syncHostTheme();
      if (sync) {
        // 合并：accent 系取 :root 变量（=宿主当前生效色，首帧事实源）；
        // radius/dark.surface 等细节取 fetch 补全（sync 无这些键）。
        setTheme({
          ...(t || {}),
          ...sync,
          dark: { ...(t?.dark), ...sync.dark },
        });
      } else {
        setTheme(t);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return theme;
}

/** 解析宿主 radius："12px"/"0" → 数值；其他 → undefined（antd 默认）。 */
function parseRadius(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  const m = /^(\d+)px$/.exec(s);
  if (m) return parseInt(m[1], 10);
  if (s === "0") return 0;
  return undefined;
}

/** 当前模式的 antd token（accent 跟随宿主）。 */
function resolveAntdTokens(
  theme: HostTheme | null,
  mode: "light" | "dark",
): Record<string, string | number> {
  const out: Record<string, string | number> = {
    colorPrimary: hostAccentForMode(theme, mode),
  };
  const hover = theme?.accent_hover;
  if (safeHex(hover)) out.colorPrimaryHover = hover;
  const bg = hostAccentBgForMode(theme, mode);
  if (bg) out.colorPrimaryBg = bg;
  const r = parseRadius(theme?.radius);
  if (r !== undefined) out.borderRadius = r;
  return out;
}

/** 组件内取 antd token（响应宿主主题加载完成；dark/light 跟随 t.mode）。 */
export function useHostThemeTokens(
  mode: "light" | "dark",
): Record<string, string | number> {
  const theme = useHostTheme();
  return React.useMemo(() => resolveAntdTokens(theme, mode), [theme, mode]);
}

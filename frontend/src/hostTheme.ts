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

export interface HostThemeDark {
  accent?: string;
  accent_bg?: string;
  surface?: string;
}

export interface HostTheme {
  accent?: string;
  accent_hover?: string;
  accent_bg?: string;
  radius?: string;
  dark?: HostThemeDark;
}

/** 2.2.x 宿主内置默认主色（= 宿主 defaultConfig.theme.colorPrimary）。 */
export const DEFAULT_ACCENT = "#FF7F16";

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
export function hostAccentBgForMode(
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

let _themePromise: Promise<HostTheme | null> | null = null;

/** 读宿主生效主题（稀疏）。页面生命周期内读一次（单飞缓存）。 */
export function fetchHostTheme(): Promise<HostTheme | null> {
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
  const [theme, setTheme] = React.useState<HostTheme | null>(null);
  React.useEffect(() => {
    let alive = true;
    void fetchHostTheme().then((t) => {
      if (alive) setTheme(t);
    });
    return () => {
      alive = false;
    };
  }, []);
  return theme;
}

/** 解析宿主 radius："12px"/"0" → 数值；其他 → undefined（antd 默认）。 */
export function parseRadius(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  const m = /^(\d+)px$/.exec(s);
  if (m) return parseInt(m[1], 10);
  if (s === "0") return 0;
  return undefined;
}

/** 当前模式的 antd token（accent 跟随宿主）。 */
export function resolveAntdTokens(
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

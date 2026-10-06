// QwenPaw ≥2.2.2 宿主主题跟随（插件配色跟随宿主 Console 主题色）。
//
// 宿主接口（qwenpaw 2.2.2 源码实证，app/routers/config.py）：
//   GET /config/theme → 稀疏 ThemeConfig
//   { accent?, accent_hover?, accent_bg?, radius?, dark?{accent?,accent_bg?,surface?} }
//   返回 {} = 宿主使用内置默认（2.2.x 默认 accent = #FF7F16）。
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

// v0.5.0-beta.14.18（14.17 装验反馈「宿主改主题色插件不生效」真根因）：
// 旧版 _themePromise 单飞且永不失效——页面加载后第一次取到就永久缓存，
// 宿主改 accent 插件永不重拉（刷新才生效；宿主无主题变更事件可订阅，
// 源码实证 console/src 无 theme dispatchEvent）。
// 现改 TTL 缓存（5s）+ 模块级轮询（refcount 订阅制）：
//   - fetchHostTheme()：距上次成功拉取 < TTL 直接命中缓存；否则单飞重拉。
//   - useHostTheme()：mount 订阅 / unmount 退订；订阅期间每 5s 刷新，
//     值有 diff 才 setState（无 diff 零重渲染）。
// 成本：/config/theme 同源小 JSON（~100B），5s 一次 ≈ 0。

const _THEME_TTL_MS = 5000;

let _themeCache: HostTheme | null | undefined = undefined; // undefined=未取过
let _themeFetchedAt = 0;
let _themeInflight: Promise<HostTheme | null> | null = null;

/** 读宿主生效主题（稀疏）。TTL 5s + 单飞。 */
export function fetchHostTheme(): Promise<HostTheme | null> {
  const now = Date.now();
  if (_themeCache !== undefined && now - _themeFetchedAt < _THEME_TTL_MS) {
    return Promise.resolve(_themeCache);
  }
  if (!_themeInflight) {
    _themeInflight = (async () => {
      try {
        if (typeof host.fetch !== "function") return null;
        const res = await host.fetch("/config/theme");
        if (!res.ok) return null;
        const j: unknown = await res.json().catch(() => null);
        if (!j || typeof j !== "object" || Array.isArray(j)) return null;
        return j as HostTheme;
      } catch {
        return null;
      } finally {
        _themeInflight = null;
      }
    })().then((t) => {
      _themeCache = t;
      _themeFetchedAt = Date.now();
      return t;
    });
  }
  return _themeInflight;
}

const React: typeof ReactNS = host.React;

// v0.5.0-beta.14.18：宿主主题实时跟随（事件驱动 + 兜底轮询）。
// 宿主实证（console/src/App.tsx）：改主题 = PUT /config/theme +
// useEffect 把生效值写 :root CSS 变量（--app-accent/--app-accent-hover/
// --app-accent-soft/--app-surface/--app-radius，root.style.setProperty）。
// MutationObserver 监听 documentElement 的 style 属性 → 宿主改主题毫秒级
// 触发 → 重拉 /config/theme（拿全量配置，含非当前模式的 dark 段）→ diff
// 门控 setState。稳态零轮询请求；30s 兜底轮询防 observer 漏发/宿主版本差。

type _ThemeListener = () => void;
const _themeListeners = new Set<_ThemeListener>();
let _themeObserver: MutationObserver | null = null;
let _themeFallbackTimer: ReturnType<typeof setInterval> | null = null;

function _notifyListeners(): void {
  for (const fn of _themeListeners) {
    try {
      fn();
    } catch {
      /* 单个消费方异常不影响其余 */
    }
  }
}

function _ensureThemeWatcher(): void {
  if (_themeObserver) return;
  try {
    _themeObserver = new MutationObserver(() => {
      _themeFetchedAt = 0; // 强制下次 fetch 真拉
      void fetchHostTheme().then(() => _notifyListeners());
    });
    _themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
  } catch {
    /* 老宿主/无 MutationObserver → 纯轮询兜底 */
  }
  if (!_themeFallbackTimer) {
    _themeFallbackTimer = setInterval(() => {
      _themeFetchedAt = 0;
      void fetchHostTheme().then(() => _notifyListeners());
    }, 30000);
  }
}

/** 读宿主主题（组件内）。旧宿主/取不到 = null（消费方各自回退）。
 *  宿主改主题毫秒级跟随（14.18：MutationObserver on :root style + 30s
 *  兜底；值有 diff 才 setState——无 diff 零重渲染）。 */
export function useHostTheme(): HostTheme | null {
  const [theme, setTheme] = React.useState<HostTheme | null>(null);
  React.useEffect(() => {
    let alive = true;
    let lastJson = "";
    const apply = (): void => {
      if (!alive) return;
      void fetchHostTheme().then((t) => {
        if (!alive) return;
        const j = t ? JSON.stringify(t) : "";
        if (j !== lastJson) {
          lastJson = j;
          setTheme(t);
        }
      });
    };
    apply();
    _ensureThemeWatcher();
    _themeListeners.add(apply);
    return () => {
      alive = false;
      _themeListeners.delete(apply);
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

/**
 * TreeRowShell.tsx — 文件管理树 / 工作区路径选择器共用的树行骨架（16.138）。
 *
 * 抽取来源（同一骨架，此前两份实现）：
 * - manage/FilesSection.tsx 的 TreeRowView（文件树行：批量选择 + 展开 +
 *   行操作）；
 * - components/WorkspacePathPicker.tsx 的 DirRow（目录选择行）。
 *
 * 骨架统一负责：
 * - 缩进 treeModel.treeIndent(depth)（不再各自 depth*16）；
 * - caret 区（16px；点击只切展开，双击不下传 → 不误触「进入目录」）；
 * - 行高 --hf-row-min（默认 44px，coarse 指针由 touchCss() 放大）；
 * - role=treeitem + aria-level / aria-expanded / aria-busy / aria-selected；
 * - 键盘 Space/Enter 基础分发（行内子控件的按键不参与，见 handleKeyDown）；
 * - hover / focus 视觉（选中行底色由调用方 style 决定，hover 不覆盖）。
 *
 * 列内容与业务语义（名称列、批量选择、激活、拖拽、懒加载文案）由调用方经
 * children / 透传 div 属性给出——本文件不含任何文件域业务逻辑。
 */
import type * as ReactNS from "react";

import type { ThemeColors } from "../../theme";
import { treeIndent } from "./treeModel";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export interface TreeRowShellProps
  extends Omit<
    ReactNS.HTMLAttributes<HTMLDivElement>,
    "role" | "style" | "onKeyDown" | "children" | "aria-level"
  > {
  /** 缩进层级（0 = 当前层）。 */
  depth: number;
  expanded: boolean;
  /** 有子项（目录）：决定 caret 缺省形态与 aria-expanded。 */
  hasChildren: boolean;
  /** 子项加载中（caret 缺省「…」+ aria-busy）。 */
  loading?: boolean;
  /** caret 文案覆盖（懒加载未知态 / 已加载空目录）；缺省按 hasChildren 推导。 */
  caret?: string;
  /** 缺省 treeitem（目录选择器 / 文件树同一语义）。 */
  role?: string;
  /** 缺省 depth + 1。 */
  ariaLevel?: number;
  /** 选中态（aria-selected + hover 不提亮）。 */
  selected?: boolean;
  /** 行首附加列（如批量选择复选框，位于 caret 之前）。 */
  leading?: ReactNS.ReactNode;
  /** caret 点击 / 键盘 Space/Enter 的展开切换；缺省 = caret 不可点。 */
  onToggleExpand?: () => void;
  /** 行级按键（先交给调用方；未 preventDefault 时骨架处理 Space/Enter）。 */
  onKeyDown?: (e: ReactNS.KeyboardEvent<HTMLDivElement>) => void;
  /** false = 键盘由祖先容器统一接管（文件树 roving tabindex：行 tabIndex=-1，
   *  方向键 / Space / Enter 全在容器 onKeyDown）；缺省 true = 行自己处理。 */
  dispatchKeys?: boolean;
  t: ThemeColors;
  children: ReactNS.ReactNode;
  style?: ReactNS.CSSProperties;
}

export const TreeRowShell = React.forwardRef<HTMLDivElement, TreeRowShellProps>(
  function TreeRowShell(props, ref) {
    const {
      depth,
      expanded,
      hasChildren,
      loading = false,
      caret,
      role = "treeitem",
      ariaLevel,
      selected,
      leading,
      onToggleExpand,
      dispatchKeys = true,
      t,
      children,
      style,
      onKeyDown,
      onClick,
      onMouseEnter,
      onMouseLeave,
      onFocus,
      onBlur,
      ...rest
    } = props;
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);

    const glyph =
      caret !== undefined
        ? caret
        : loading
          ? "…"
          : hasChildren
            ? expanded
              ? "▾"
              : "▸"
            : "";

    const toggle = (e: ReactNS.SyntheticEvent): void => {
      e.stopPropagation(); // 只切展开，不改行选中 / 不进入目录
      onToggleExpand?.();
    };

    const handleKeyDown = (e: ReactNS.KeyboardEvent<HTMLDivElement>): void => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      // 行内子控件（按钮 / 复选框）的按键不当作行切换，避免重复触发。
      if (e.target !== e.currentTarget) return;
      if (!dispatchKeys) return;
      if (e.key === " " || e.key === "Enter") {
        if (!onToggleExpand) return;
        e.preventDefault();
        onToggleExpand();
      }
    };

    const skin: ReactNS.CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 8,
      minHeight: "var(--hf-row-min, 44px)",
      padding: "0 8px",
      paddingLeft: 8 + treeIndent(depth),
      borderRadius: 6,
      border: "1px solid transparent",
      background: "transparent",
      color: t.text,
      cursor: "pointer",
      ...style,
    };
    // hover 只在未选中、且调用方未指定底色时提亮（选中行 / 拖拽目标行
    // 的底色由调用方 style 决定，不被 hover 覆盖）。
    const callerBg = style?.background;
    if (hovered && !selected && (callerBg === undefined || callerBg === "transparent")) {
      skin.background = t.hoverBg;
    }
    if (focused) {
      skin.outline = "none";
      skin.boxShadow = "inset 0 0 0 2px var(--app-accent, #FF7F16)";
    }

    return (
      <div
        ref={ref}
        {...rest}
        role={role}
        aria-level={ariaLevel ?? depth + 1}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-busy={loading ? true : undefined}
        aria-selected={selected === undefined ? undefined : selected}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        onMouseEnter={(e) => {
          setHovered(true);
          onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          setHovered(false);
          onMouseLeave?.(e);
        }}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={skin}
      >
        {leading}
        <span
          aria-hidden="true"
          onClick={toggle}
          onDoubleClick={(e) => e.stopPropagation()}
          style={{
            width: 16,
            fontSize: 11,
            color: t.textSecondary,
            textAlign: "center",
            userSelect: "none",
            flexShrink: 0,
            cursor: onToggleExpand ? "pointer" : "default",
          }}
        >
          {glyph}
        </span>
        {children}
      </div>
    );
  },
);

export default TreeRowShell;

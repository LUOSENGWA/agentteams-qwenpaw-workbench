// a11y 静态门（R4）：axe-core 不在依赖里（不进 devDeps，也不新增依赖）→
// 用源码级纯函数做可访问性断言。输入 = JSX 源码文本，输出 = 违规列表。
//
// 覆盖五类规则（对应任务书检查项）：
// ① icon-button-name     图标按钮必须有 aria-label / title（可见文本不算名字）
// ② clickable-div-role   可点 div 必须有交互 role（缺 = 读屏/键盘完全不可达）
// ③ clickable-div-keyboard  role=button 的 div 必须有 tabIndex + onKeyDown
// ④ checkbox-aria-checked  role=checkbox 必须带合法 aria-checked
// ⑤ dialog-aria-modal      role=dialog 必须 aria-modal="true"
// ⑥ form-control-name     表单控件必须有 aria-label / aria-labelledby
//
// 扫描器只做 JSX 标签结构的轻量解析（标签名 + 原始属性文本 + 子节点区间），
// 不做完整 AST——够用且零依赖。注释先掩码成空格（长度不变，行号不漂），
// 所以注释里贴的 `<button role="checkbox">` 示例不会误报。
//
// 例外通道：元素前 500 字符内出现 `/* a11y-static-exempt: <理由> */` 即豁免
// （理由必填）——仅用于 roving tabindex 这类「键盘由祖先容器统一接管」的
// 标准模式，测试里会断言豁免清单与理由同时存在。

export type A11yRule =
  | "icon-button-name"
  | "clickable-div-role"
  | "clickable-div-keyboard"
  | "checkbox-aria-checked"
  | "dialog-aria-modal"
  | "form-control-name";

export interface A11yIssue {
  rule: A11yRule;
  tag: string;
  /** 元素在源码中的偏移（已过注释掩码，与原文件一致）。 */
  index: number;
  detail: string;
}

export interface JsxTag {
  /** 标签名，如 div / button / antd.Button / antd.Input.Password。 */
  name: string;
  /** 标签名之后的原始属性文本（自闭合标签已去掉结尾 "/"）。 */
  attrs: string;
  selfClosing: boolean;
  /** 子节点原始源码（自闭合为空串）。 */
  inner: string;
  index: number;
}

/** 交互型 role（可点 div 带上其一即视为有语义）。 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "switch",
  "radio",
  "tab",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "link",
]);

/** 受检表单控件（去掉 antd. 前缀后比对，含原生标签）。 */
const FORM_CONTROLS = new Set([
  "Input",
  "Input.Password",
  "Input.TextArea",
  "Select",
  "Switch",
  "Checkbox",
  "Radio",
  "Radio.Group",
  "Segmented",
  "input",
  "textarea",
  "select",
]);

/** 子节点文字即标签的控件（Checkbox/Radio 的 children = 可见字段名）。 */
const LABELLED_BY_CHILDREN = new Set(["Checkbox", "Radio"]);

const EXEMPT_MARK = "a11y-static-exempt:";
const EXEMPT_WINDOW = 500;

function isNameStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_$.:-]/.test(ch);
}

/** 块注释 + 整行 `//` 注释掩码为空格（保留换行与长度）。 */
function maskComments(src: string): string {
  const ranges: Array<[number, number]> = [];
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) {
    ranges.push([m.index as number, (m.index as number) + m[0].length]);
  }
  for (const m of src.matchAll(/^[ \t]*\/\/[^\n]*/gm)) {
    ranges.push([m.index as number, (m.index as number) + m[0].length]);
  }
  if (ranges.length === 0) return src;
  let out = "";
  let cursor = 0;
  ranges.sort((a, b) => a[0] - b[0]);
  for (const [from, to] of ranges) {
    if (to <= cursor) continue;
    const start = Math.max(from, cursor);
    out += src.slice(cursor, start);
    out += src.slice(start, to).replace(/[^\n]/g, " ");
    cursor = to;
  }
  return out + src.slice(cursor);
}

interface ParsedOpen {
  name: string;
  attrs: string;
  selfClosing: boolean;
  /** 开标签 `>` 之后的偏移。 */
  end: number;
}

/** 从 `<` 位置解析一个开标签（未闭合/非标签返回 null）。 */
function parseOpenAt(src: string, lt: number): ParsedOpen | null {
  let i = lt + 1;
  if (!isNameStart(src[i] ?? "")) return null;
  const nameStart = i;
  while (i < src.length && isNameChar(src[i])) i++;
  const name = src.slice(nameStart, i);
  const attrsStart = i;
  let depth = 0;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (depth > 0) {
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      continue;
    }
    if (ch === "{") {
      depth = 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      const rawAttrs = src.slice(attrsStart, i);
      const trimmed = rawAttrs.trimEnd();
      const selfClosing = trimmed.endsWith("/");
      return {
        name,
        attrs: selfClosing ? trimmed.slice(0, -1) : rawAttrs,
        selfClosing,
        end: i + 1,
      };
    }
  }
  return null;
}

/** 找同名闭标签位置（处理同标签嵌套与自闭合子标签）。 */
function findInnerEnd(src: string, from: number, name: string): number | null {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) return null;
    if (src[lt + 1] === "/") {
      const m = /^<\/\s*([A-Za-z_$][A-Za-z0-9_$.:-]*)/.exec(src.slice(lt, lt + 64));
      if (m && m[1] === name) {
        depth--;
        if (depth === 0) return lt;
      }
      const gt = src.indexOf(">", lt);
      i = gt < 0 ? src.length : gt + 1;
      continue;
    }
    const open = parseOpenAt(src, lt);
    if (!open) {
      i = lt + 1;
      continue;
    }
    if (open.name === name && !open.selfClosing) depth++;
    i = open.end;
  }
  return null;
}

/** 扫出全部开标签（含嵌套；注释已掩码）。 */
export function scanTags(source: string): JsxTag[] {
  const src = maskComments(source);
  const out: JsxTag[] = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (src[lt + 1] === "/") {
      const gt = src.indexOf(">", lt);
      i = gt < 0 ? src.length : gt + 1;
      continue;
    }
    const open = parseOpenAt(src, lt);
    if (!open) {
      i = lt + 1;
      continue;
    }
    if (open.selfClosing) {
      out.push({ name: open.name, attrs: open.attrs, selfClosing: true, inner: "", index: lt });
      i = open.end;
      continue;
    }
    const innerEnd = findInnerEnd(src, open.end, open.name);
    out.push({
      name: open.name,
      attrs: open.attrs,
      selfClosing: false,
      inner: innerEnd == null ? src.slice(open.end) : src.slice(open.end, innerEnd),
      index: lt,
    });
    i = open.end;
  }
  return out;
}

/** 属性原始值：静态串返回去引号值，`{expr}` 返回原文（含花括号）。 */
export function attrRaw(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  if (m) return m[1];
  const b = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(\\{[^}]*\\})`).exec(attrs);
  return b ? b[1] : null;
}

export function hasAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}\\s*=`).test(attrs);
}

/** 子节点是否有可见文本/表达式（标签与注释不算）。 */
function hasContent(inner: string): boolean {
  const noComments = inner.replace(/\/\*[\s\S]*?\*\//g, " ");
  const noTags = noComments.replace(/<[^>]*>/g, " ");
  return noTags.trim() !== "";
}

function isExempt(src: string, index: number): boolean {
  const from = Math.max(0, index - EXEMPT_WINDOW);
  const window = src.slice(from, index);
  const at = window.lastIndexOf(EXEMPT_MARK);
  if (at < 0) return false;
  const reason = window.slice(at + EXEMPT_MARK.length).split("*/")[0].trim();
  return reason.length > 0;
}

/** 源码级 a11y 检查（六条规则；返回全部违规）。 */
export function findA11yIssues(source: string): A11yIssue[] {
  const issues: A11yIssue[] = [];
  for (const tag of scanTags(source)) {
    if (isExempt(source, tag.index)) continue;
    const attrs = tag.attrs;
    const hasName = hasAttr(attrs, "aria-label") || hasAttr(attrs, "aria-labelledby");
    const hasTitle = hasAttr(attrs, "title");
    const role = attrRaw(attrs, "role");

    // ① 图标按钮必须有无障碍名字（antd.Button icon-only / 原生 button 纯图标）。
    const isButton = tag.name === "antd.Button" || tag.name === "button";
    if (isButton) {
      const iconProp = hasAttr(attrs, "icon");
      const iconChild = /<[A-Za-z]/.test(tag.inner) && !hasContent(tag.inner);
      if ((iconProp || iconChild) && !hasContent(tag.inner) && !hasName && !hasTitle) {
        issues.push({
          rule: "icon-button-name",
          tag: tag.name,
          index: tag.index,
          detail: "图标按钮缺少 aria-label / title —— 读屏只念「按钮」",
        });
      }
    }

    // ②③ 可点 div：缺交互 role = 键盘/读屏不可达；role=button 还须能聚焦+回车空格。
    if (tag.name === "div" && hasAttr(attrs, "onClick")) {
      const literalRole = role && !role.startsWith("{") ? role : null;
      if (literalRole == null ? role == null : !INTERACTIVE_ROLES.has(literalRole)) {
        issues.push({
          rule: "clickable-div-role",
          tag: tag.name,
          index: tag.index,
          detail: `可点击 div 缺交互 role（现为 ${role ?? "无"}）——键盘不可达`,
        });
      } else if (role === "button" && (!hasAttr(attrs, "tabIndex") || !hasAttr(attrs, "onKeyDown"))) {
        issues.push({
          rule: "clickable-div-keyboard",
          tag: tag.name,
          index: tag.index,
          detail: "role=button 的 div 缺 tabIndex / onKeyDown —— 回车与空格无法触发",
        });
      }
    }

    // ④ role=checkbox 的 aria-checked 合法性（true / false / mixed）。
    if (role === "checkbox") {
      const checked = attrRaw(attrs, "aria-checked");
      if (checked == null) {
        issues.push({
          rule: "checkbox-aria-checked",
          tag: tag.name,
          index: tag.index,
          detail: "role=checkbox 缺 aria-checked",
        });
      } else if (!checked.startsWith("{") && !["true", "false", "mixed"].includes(checked)) {
        issues.push({
          rule: "checkbox-aria-checked",
          tag: tag.name,
          index: tag.index,
          detail: `aria-checked="${checked}" 非法（只允许 true / false / mixed）`,
        });
      }
    }

    // ⑤ 自绘弹窗必须声明模态（antd.Modal 自带，不在本规则内）。
    if (role === "dialog") {
      const modal = attrRaw(attrs, "aria-modal");
      if (modal !== "true" && modal !== "{true}") {
        issues.push({
          rule: "dialog-aria-modal",
          tag: tag.name,
          index: tag.index,
          detail: "role=dialog 缺 aria-modal=\"true\" —— 读屏不会限制在弹窗内",
        });
      }
    }

    // ⑥ 表单控件必须有可读名字（placeholder 不是名字，失焦即消失）。
    const bare = tag.name.replace(/^antd\./, "");
    if (FORM_CONTROLS.has(bare) && !hasName) {
      const hidden = attrRaw(attrs, "aria-hidden") === "true";
      const labelledByText = LABELLED_BY_CHILDREN.has(bare) && hasContent(tag.inner);
      if (!hidden && !labelledByText) {
        issues.push({
          rule: "form-control-name",
          tag: tag.name,
          index: tag.index,
          detail: "表单控件缺 aria-label / aria-labelledby —— 只有 placeholder 时读屏不报字段名",
        });
      }
    }
  }
  return issues;
}

/** 人读格式（测试失败时的 diff 直接可看）。 */
export function formatA11yIssue(src: string, issue: A11yIssue): string {
  const line = src.slice(0, issue.index).split("\n").length;
  return `L${line} <${issue.tag}> [${issue.rule}] ${issue.detail}`;
}

/** 源码中的豁免声明（测试断言其必带理由）。 */
export function listExemptions(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/a11y-static-exempt:\s*([^*\n]+)/g)) {
    out.push(m[1].trim());
  }
  return out;
}

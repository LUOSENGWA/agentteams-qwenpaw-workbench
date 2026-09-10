import type * as ReactNS from "react";

import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

const PRIMARY = "#FF7F16";

/** 行内格式：`code` / **bold** / *italic* / @mention / 裸 URL。 */
function InlineMd({
  text,
  onMentionClick,
}: {
  text: string;
  onMentionClick?: (name: string) => void;
}) {
  const nodes: ReactNS.ReactNode[] = [];
  const regex =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|@[\w\u4e00-\u9fa5-]+|https?:\/\/[^\s]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`") && tok.endsWith("`")) {
      nodes.push(
        <code
          key={key++}
          style={{
            background: "rgba(0,0,0,0.06)",
            borderRadius: 4,
            padding: "1px 5px",
            fontSize: 13,
            fontFamily: "monospace",
            // 超长单行行内码（URL/token）强制换行，不撑宽气泡。
            overflowWrap: "anywhere",
            wordBreak: "break-all",
          }}
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**") && tok.endsWith("**")) {
      nodes.push(<b key={key++}>{tok.slice(2, -2)}</b>);
    } else if (tok.startsWith("*") && tok.endsWith("*") && tok.length > 2) {
      nodes.push(<i key={key++}>{tok.slice(1, -1)}</i>);
    } else if (tok.startsWith("@")) {
      nodes.push(
        <span
          key={key++}
          style={{
            color: PRIMARY,
            fontWeight: 600,
            cursor: onMentionClick ? "pointer" : undefined,
          }}
          onClick={
            onMentionClick ? () => onMentionClick(tok.slice(1)) : undefined
          }
        >
          {tok}
        </span>,
      );
    } else {
      nodes.push(
        <a
          key={key++}
          href={tok}
          target="_blank"
          rel="noreferrer"
          style={{ color: "#1677ff" }}
        >
          {tok}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

/** 复制按钮（代码块用）。 */
function CopyButton({ text }: { text: string }) {
  const tr = useT();
  const [copied, setCopied] = React.useState(false);
  return (
    <antd.Button
      type="text"
      size="small"
      style={{ color: "#bbb", fontSize: 11 }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard 不可用 */
        }
      }}
    >
      {copied ? tr("已复制") : tr("复制")}
    </antd.Button>
  );
}

/** 代码块：深底 + 语言标签 + 复制。 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div
      style={{
        background: "#1e1e2e",
        borderRadius: 8,
        margin: "6px 0",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "2px 8px",
          fontSize: 11,
          color: "#8b8b9e",
        }}
      >
        <span>{lang || "code"}</span>
        <CopyButton text={code} />
      </div>
      <pre
        style={{
          margin: 0,
          padding: "8px 12px 12px",
          overflowX: "auto",
          fontSize: 12.5,
          lineHeight: 1.55,
          color: "#d6d6e8",
          fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** 块级结构：代码块 / 标题 / 列表（有序/无序）/ 表格 / 引用 / 普通段。 */
interface Block {
  type: "code" | "h" | "list" | "table" | "quote" | "text";
  lang?: string;
  content: string;
  items?: string[];
  /** 表格：行数组（首行 = 表头）。v0.4.83。 */
  rows?: string[][];
  /** 有序列表标记。v0.4.83。 */
  ordered?: boolean;
  /** 标题层级（1-6）。v0.4.83。 */
  level?: number;
}

/** 表格分隔行：|---|:---:|---| （只含 | - : 空格且至少一个 -）。 */
function isTableSep(line: string): boolean {
  if (!line.includes("-")) return false;
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("|");
}

/** 表格行 → 单元格数组（去首尾 | 后按 | 切分，逐格 trim）。 */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      blocks.push({ type: "text", content: buf.join("\n") });
      buf = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      flush();
      const lang = line.trim().slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 ```
      blocks.push({ type: "code", lang, content: code.join("\n") });
      continue;
    }
    const hMatch = /^#{1,6}\s+/.exec(line);
    if (hMatch) {
      flush();
      blocks.push({
        type: "h",
        level: hMatch[0].trim().length, // "## " → 3（# 数 + 1）
        content: line.replace(/^#{1,6}\s+/, "").trim(),
      });
      i++;
      continue;
    }
    // 表格（v0.4.83）：| 开头行 + 下一行是分隔行 |---|---| → 吃掉连续 | 行。
    // 报告类产物（对比表/清单）表格是主形态——此前全部按 RAW 文本渲染，
    // 用户「md 预览 RAW 没修好」的主要根因之一。
    if (
      /^\s*\|/.test(line) &&
      i + 1 < lines.length &&
      isTableSep(lines[i + 1])
    ) {
      flush();
      const rows: string[][] = [splitTableRow(line)];
      i += 2; // 跳过表头 + 分隔行
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", content: "", rows });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, "").trim());
        i++;
      }
      blocks.push({ type: "list", content: "", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      // 有序列表（v0.4.83）：1. / 2) 连续行。
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "").trim());
        i++;
      }
      blocks.push({ type: "list", content: "", items, ordered: true });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const qs: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        qs.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", content: qs.join("\n") });
      continue;
    }
    buf.push(line);
    i++;
  }
  flush();
  return blocks;
}

export interface MdTextProps {
  text: string;
  /** 折叠阈值（字符数）；超长文本默认折叠显示前 400 字符。 */
  maxLength?: number;
  onMentionClick?: (name: string) => void;
}

/** 零依赖 markdown 渲染：代码块/标题/列表/引用 + 行内格式 + @高亮 + 长文折叠。 */
export default function MdText({
  text,
  maxLength = 800,
  onMentionClick,
}: MdTextProps) {
  const tr = useT();
  const [expanded, setExpanded] = React.useState(false);
  const isLong = text.length > maxLength;
  const shown = isLong && !expanded ? text.slice(0, 400) : text;
  const blocks = React.useMemo(() => parseBlocks(shown), [shown]);

  return (
    <div style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
      {blocks.map((b, bi) => {
        switch (b.type) {
          case "code":
            return <CodeBlock key={bi} code={b.content} lang={b.lang || ""} />;
          case "h": {
            const lvl = b.level || 3;
            const fontSize = lvl <= 1 ? 17 : lvl <= 2 ? 16 : lvl <= 4 ? 15 : 13.5;
            return (
              <div
                key={bi}
                style={{ fontWeight: 700, fontSize, margin: "6px 0 2px" }}
              >
                <InlineMd text={b.content} onMentionClick={onMentionClick} />
              </div>
            );
          }
          case "list":
            const listStyle = { margin: "4px 0", paddingLeft: 22 } as const;
            return b.ordered ? (
              <ol key={bi} style={listStyle}>
                {(b.items || []).map((it, ii) => (
                  <li key={ii} style={{ margin: "2px 0" }}>
                    <InlineMd text={it} onMentionClick={onMentionClick} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={bi} style={listStyle}>
                {(b.items || []).map((it, ii) => (
                  <li key={ii} style={{ margin: "2px 0" }}>
                    <InlineMd text={it} onMentionClick={onMentionClick} />
                  </li>
                ))}
              </ul>
            );
          case "table": {
            const cellBorder = "1px solid rgba(127,127,127,0.28)";
            const cols = (b.rows && b.rows[0] ? b.rows[0].length : 1) || 1;
            return (
              <div key={bi} style={{ overflowX: "auto", margin: "6px 0" }}>
                <table
                  style={{
                    borderCollapse: "collapse",
                    width: "100%",
                    fontSize: 12.5,
                    lineHeight: 1.5,
                  }}
                >
                  <thead>
                    <tr>
                      {(b.rows?.[0] || Array.from({ length: cols }, () => ""))
                        .slice(0, cols)
                        .map((c, ci) => (
                          <th
                            key={ci}
                            style={{
                              border: cellBorder,
                              padding: "4px 10px",
                              background: "rgba(0,0,0,0.045)",
                              textAlign: "left",
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {c}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(b.rows || []).slice(1).map((row, ri) => (
                      <tr key={ri}>
                        {Array.from({ length: cols }, (_, ci) => (
                          <td
                            key={ci}
                            style={{
                              border: cellBorder,
                              padding: "4px 10px",
                              wordBreak: "break-word",
                              verticalAlign: "top",
                            }}
                          >
                            <InlineMd
                              text={row[ci] ?? ""}
                              onMentionClick={onMentionClick}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          case "quote":
            return (
              <div
                key={bi}
                style={{
                  borderLeft: "3px solid rgba(0,0,0,0.2)",
                  paddingLeft: 10,
                  color: "#888",
                  fontSize: 13,
                  margin: "4px 0",
                }}
              >
                <InlineMd text={b.content} onMentionClick={onMentionClick} />
              </div>
            );
          default:
            return (
              <div key={bi} style={{ margin: "2px 0" }}>
                <InlineMd text={b.content} onMentionClick={onMentionClick} />
              </div>
            );
        }
      })}
      {isLong ? (
        <antd.Button
          type="link"
          size="small"
          style={{ padding: 0, fontSize: 12 }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? tr("收起") + " ↑" : tr("展开全文（{kb} KB）↓", { kb: Math.round(text.length / 1024) })}
        </antd.Button>
      ) : null}
    </div>
  );
}

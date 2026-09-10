import { strFromU8, unzipSync } from "fflate";

/** 0.4.99 B4：表格预览解析——csv（RFC4180-lite）+ xlsx（fflate 解包 +
 * DOMParser 解析 sheet XML，零重依赖：不引 SheetJS 400KB+）。
 * 统一输出 { header, rows } 供 antd Table 渲染（前 300 行 × 30 列上限）。 */

export interface TableData {
  header: string[];
  rows: string[][];
  /** 解析说明（截断提示等）。 */
  note?: string;
}

const MAX_ROWS = 300;
const MAX_COLS = 30;

/** CSV/TSV 解析（支持引号内逗号/换行/双引号转义）。 */
export function parseDelimited(
  text: string,
  delim: string,
): TableData {
  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delim) {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (ch !== "\r") {
      cur += ch;
    }
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (clean.length < 1) throw new Error("表格为空");
  const header = clean[0].slice(0, MAX_COLS);
  let rowsOut = clean.slice(1);
  let note = "";
  if (rowsOut.length > MAX_ROWS) {
    rowsOut = rowsOut.slice(0, MAX_ROWS);
    note = `仅显示前 ${MAX_ROWS} 行（共 ${clean.length - 1} 行），完整内容请下载`;
  }
  rowsOut = rowsOut.map((r) => {
    const rr = r.slice(0, MAX_COLS);
    while (rr.length < header.length) rr.push("");
    return rr;
  });
  return { header, rows: rowsOut, note: note || undefined };
}

/** 单元格引用 "BC12" 的字母段 → 0-based 列号。 */
function colLetterToIndex(ref: string): number {
  let idx = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    idx = idx * 26 + (c - 64);
  }
  return Math.max(0, idx - 1);
}

/** XLSX 解析（首个 sheet；sharedStrings + 内联串 + 数值/日期原值）。 */
export function parseXlsx(buffer: ArrayBuffer): TableData {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch (e) {
    throw new Error(`不是有效的 xlsx 文件：${e instanceof Error ? e.message : String(e)}`);
  }
  const readXml = (p: string): Document | null => {
    const b = files[p];
    if (!b) return null;
    return new DOMParser().parseFromString(strFromU8(b), "application/xml");
  };
  // 1) 共享字符串表
  const strings: string[] = [];
  const sst = readXml("xl/sharedStrings.xml");
  if (sst) {
    const sis = sst.getElementsByTagName("si");
    for (let i = 0; i < sis.length; i++) {
      let txt = "";
      const ts = sis[i].getElementsByTagName("t");
      for (let j = 0; j < ts.length; j++) txt += ts[j].textContent || "";
      strings.push(txt);
    }
  }
  // 2) 首个 sheet 的文件路径（workbook.xml → rels）
  let sheetFile = "xl/worksheets/sheet1.xml";
  const wb = readXml("xl/workbook.xml");
  if (wb) {
    const first = wb.getElementsByTagName("sheet")[0];
    const rid = first
      ? first.getAttribute("r:id") || first.getAttribute("rId") || ""
      : "";
    if (rid) {
      const rels = readXml("xl/_rels/workbook.xml.rels");
      if (rels) {
        const relsList = rels.getElementsByTagName("Relationship");
        for (let i = 0; i < relsList.length; i++) {
          if (relsList[i].getAttribute("Id") === rid) {
            const target = (relsList[i].getAttribute("Target") || "").replace(
              /^\//,
              "",
            );
            sheetFile = target.startsWith("xl/") ? target : `xl/${target}`;
            break;
          }
        }
      }
    }
  }
  const sdoc = readXml(sheetFile) || readXml("xl/worksheets/sheet1.xml");
  if (!sdoc) throw new Error("xlsx 内未找到工作表数据");
  // 3) 行/单元格
  const rowsOut: string[][] = [];
  let maxCols = 0;
  const rowEls = sdoc.getElementsByTagName("row");
  for (let r = 0; r < rowEls.length && rowsOut.length < MAX_ROWS + 1; r++) {
    const rowEls2 = rowEls[r].getElementsByTagName("c");
    const sparse: (string | undefined)[] = [];
    for (let c = 0; c < rowEls2.length; c++) {
      const cell = rowEls2[c];
      const ref = cell.getAttribute("r") || "";
      const colIdx = colLetterToIndex(ref);
      const type = cell.getAttribute("t") || "";
      let v = "";
      const vEl = cell.getElementsByTagName("v")[0];
      const isEl = cell.getElementsByTagName("is")[0];
      if (type === "s" && vEl) {
        const si = parseInt(vEl.textContent || "0", 10);
        v = strings[si] || "";
      } else if (type === "inlineStr" && isEl) {
        v = isEl.textContent || "";
      } else if (vEl) {
        v = vEl.textContent || "";
      }
      sparse[colIdx] = v;
    }
    const dense: string[] = [];
    for (let i = 0; i < sparse.length; i++) dense.push(sparse[i] ?? "");
    rowsOut.push(dense);
    if (dense.length > maxCols) maxCols = dense.length;
  }
  if (rowsOut.length < 1) throw new Error("工作表为空");
  const header = rowsOut[0].slice(0, MAX_COLS);
  let body = rowsOut.slice(1);
  let note = "";
  if (body.length > MAX_ROWS) {
    body = body.slice(0, MAX_ROWS);
    note = `仅显示前 ${MAX_ROWS} 行（共 ${rowsOut.length - 1} 行），完整内容请下载`;
  }
  body = body.map((r) => {
    const rr = r.slice(0, MAX_COLS);
    while (rr.length < header.length) rr.push("");
    return rr;
  });
  return { header, rows: body, note: note || undefined };
}

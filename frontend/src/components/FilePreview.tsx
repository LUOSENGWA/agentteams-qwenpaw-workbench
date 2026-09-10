import type * as ReactNS from "react";

import { downloadViaHost, fetchFile } from "../api";
import { parseDelimited, parseXlsx, type TableData } from "../previewTables";
import MdText from "./MdText";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const DownloadIcon = pick("DownloadOutlined");

const PRIMARY = "#FF7F16";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);
const TEXT_PREVIEW_EXT = new Set([
  "md", "markdown", "txt", "log", "json", "csv", "tsv", "yaml", "yml",
  "xml", "sql", "html", "htm", "py", "ts", "js", "tsx", "jsx", "go", "rs",
  "sh", "yaml",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** markdown 内容特征嗅探（v0.4.82：无扩展名/无 mime 时的最后一道识别）。
 * 只查前 2000 字符，成本可忽略；命中任一特征即按 md 渲染。 */
const MD_HINTS: RegExp[] = [
  /^#{1,6}\s/m, // 标题
  /^```/m, // 代码块
  /^\s*[-*+]\s+\S/m, // 无序列表
  /^\s*\d+\.\s+\S/m, // 有序列表
  /\*\*[^*\n]{1,200}\*\*/, // 加粗
  /\[[^\]\n]{1,200}\]\(\S+\)/, // 链接
];
function looksLikeMarkdown(s: string): boolean {
  const head = s.slice(0, 2000);
  return MD_HINTS.some((re) => re.test(head));
}

export interface PreviewFile {
  name: string;
  /** 下载/预览地址（mxc 已转 media 代理 URL，或正源产物 URL，或 http 直链）。 */
  url: string;
  /** v0.4.85: 裸插件 API 路径（mxc 媒体代理 / 正源产物）——fetch 必须走
   * host.fetch（带鉴权）；缺省时 url 直接 fetch（http 直链）。
   * v0.4.98 再版 10：http 直链也带（/media/proxy?url= 服务端代抓，
   * 绕浏览器 CORS）。 */
  apiPath?: string;
  mimeType?: string;
  /** 字节数，用于预览大小守卫。 */
  size?: number;
  /** 正源产物 URL 带后端注入的鉴权——图片必须 fetch blob 而非 img 直链。 */
  needsFetch?: boolean;
  /** v0.4.98 再版 10：原始 url 值（mxc/直链/畸形地址原样）——错误态展示
   * 证据，「预览不行」不再是无从查起。 */
  rawUrl?: string;
}

/** 共享文件预览 Modal：图片（blob/objectURL 或直链）/ md·文本（fetch text）/
 * 其他类型（新窗口打开）。大小守卫：图片 8MB、文本 2MB，超限提示下载。
 *
 * v0.4.98 再版 10：fetch 失败不再静默 toast+close——错误细节进 Modal
 * （状态码/代理 vs 直链/原始地址），用户可截图定位、可直接新窗口兜底。 */
export function FilePreview({
  file,
  onClose,
}: {
  file: PreviewFile | null;
  onClose: () => void;
}) {
  const [state, setState] = React.useState<{
    loading?: boolean;
    url?: string;
    text?: string;
    blobUrl?: string;
    /** v0.4.82: 文本经嗅探通道载入（无扩展名/无 mime 的未知类型）。 */
    sniffed?: boolean;
    /** v0.4.84: 文件地址为空/无效（不 fetch，防 fetch("") 取回 SPA 壳）。 */
    errorUrl?: boolean;
    /** v0.4.98 再版 10: fetch 失败原因（Modal 内可见）。 */
    error?: string;
    /** 0.4.99 B4: xlsx 解析后的表格数据。 */
    table?: TableData;
  }>({});

  // v0.4.82: close 稳定化——onClose 是父组件内联箭头（每次渲染新引用），
  // 旧实现 close 依赖 [onClose] → 父组件每次重渲染（消息轮询）都让
  // effect 重跑、文本重复 fetch（预览闪烁/重复加载）。
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const close = React.useCallback(() => {
    setState((prev) => {
      if (prev.blobUrl) URL.revokeObjectURL(prev.blobUrl);
      return {};
    });
    onCloseRef.current();
  }, []);

  React.useEffect(() => {
    if (!file) return;
    // v0.4.84: 空 url 守卫——fetch("") 会取当前页面自身（QwenPaw Console 的
    // index.html SPA 壳），「md 预览出控制台 HTML」事故即 url 解析器对非 mxc
    // 链接回 "" 所致（见 api.ts resolveFileUrl 注释）。
    if (!file.url) {
      setState({ loading: false, errorUrl: true });
      return;
    }
    const ext = extOf(file.name);
    const mime = (file.mimeType || "").toLowerCase();
    // v0.4.81: 文件名无 .md 后缀时靠 mimetype 识别——此前 md 文件按名称
    // 落不到 md 分支，预览出 RAW 源码（用户：「预览只给了 RAW 没渲染，
    // 参考 QwenPaw」）。
    const isMd = ["md", "markdown"].includes(ext) || mime.includes("markdown");
    const isImage = IMAGE_EXT.has(ext) || mime.startsWith("image/");
    const isText = TEXT_PREVIEW_EXT.has(ext) || mime.startsWith("text/");

    // v0.4.98 再版 10: fetch 回退链——
    // ① apiPath（host.fetch 同源带鉴权）：mxc 媒体代理 / O19 正源 /
    //    http 直链的 /media/proxy 服务端代抓（绕 CORS，后端同网段可达）；
    // ② http 直链裸 fetch（代抓不可用时的最后一线，同域/CORS 放行时有效）；
    // ③ 全失败 → 带细节的错误态（旧版 toast+close 静默，失败点无从查起）。
    const fetchWithFallback = async (): Promise<Response> => {
      let proxyErr = "";
      if (file.apiPath) {
        try {
          const r = await fetchFile(file.apiPath, file.url);
          if (r.ok) return r;
          proxyErr = `代理抓取 HTTP ${r.status}`;
          // 4xx = 源不存在/无权限——裸直链重试无意义，直接抛（省一次请求）。
          if (r.status < 500) throw new Error(proxyErr);
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("代理抓取")) throw e;
          proxyErr = `代理抓取 ${e}`;
        }
      }
      if (/^https?:\/\//i.test(file.url)) {
        try {
          const r = await fetch(file.url);
          if (r.ok) return r;
          throw new Error(
            proxyErr
              ? `${proxyErr}；直连 HTTP ${r.status}`
              : `直连 HTTP ${r.status}`,
          );
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("代理抓取")) throw e;
          throw new Error(
            proxyErr
              ? `${proxyErr}；直连 ${e}`
              : `直连 ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      throw new Error(proxyErr || "无可用请求路径（mxc 需媒体代理，直链需 http）");
    };
    const fail = (e: unknown) => {
      setState({ error: e instanceof Error ? e.message : String(e) });
    };

    if (isImage) {
      if (file.size && file.size > 8 * 1024 * 1024) {
        antd.message.info("图片超过 8MB，请直接下载");
        close();
        return;
      }
      // v0.4.85: mxc 媒体代理（apiPath）与正源产物一样必须 fetch blob——
      // img src 裸导航带不了鉴权头，会落 SPA 兜底（index.html 壳）或 401。
      // v0.4.98 再版 10: 直链图片同样带 apiPath（代抓）→ 此处统一 blob 路径。
      if (file.needsFetch || file.apiPath) {
        setState({ loading: true });
        void (async () => {
          try {
            const resp = await fetchWithFallback();
            const blob = await resp.blob();
            const objUrl = URL.createObjectURL(blob);
            setState({ url: objUrl, blobUrl: objUrl });
          } catch (e) {
            fail(e);
          }
        })();
      } else {
        setState({ url: file.url });
      }
      return;
    }

    // 0.4.99 B4: xlsx 表格预览（ArrayBuffer + fflate + DOMParser，零重依赖）。
    if (ext === "xlsx") {
      if (file.size && file.size > 4 * 1024 * 1024) {
        antd.message.info("Excel 文件超过 4MB，请直接下载");
        close();
        return;
      }
      setState({ loading: true });
      void (async () => {
        try {
          const resp = await fetchWithFallback();
          const buf = await resp.arrayBuffer();
          setState({ url: file.url, table: parseXlsx(buf) });
        } catch (e) {
          fail(
            e instanceof Error
              ? `预览解析失败：${e.message}`
              : String(e),
          );
        }
      })();
      return;
    }

    if (isText) {
      if (file.size && file.size > 2 * 1024 * 1024) {
        antd.message.info("文本超过 2MB，请直接下载");
        close();
        return;
      }
      setState({ loading: true });
      void (async () => {
        try {
          // v0.4.85: 插件路径走 host.fetch（带鉴权）；裸路径落 SPA 兜底取回
          // 1073B index.html 壳 = 8/22「内容是网页」真根因。
          const resp = await fetchWithFallback();
          // v0.4.83: 502/404 守卫——代理失败时的错误 JSON 体不再当正文渲染。
          const text = await resp.text();
          // v0.4.84: md 期望但内容实为 HTML = 地址指向网页兜底页（SPA 壳）
          // 或发送端把网页存成了文件——两种都不该按 md 渲染（出一屏标签）。
          if (isMd && /^\s*(<!doctype html|<html)/i.test(text)) {
            antd.message.error(
              "内容是网页而非 markdown（附件地址指向页面兜底，或文件本身是 HTML），请让发送方重新上传",
            );
            close();
            return;
          }
          setState({ url: file.url, text: text.slice(0, 200000) });
        } catch (e) {
          fail(e);
        }
      })();
      return;
    }

    // v0.4.82: 未知类型先尝试「文本 + markdown 嗅探」——Worker 附件常连
    // info.mimetype 都没有（扩展名+mime 双源识别落空）。内容特征嗅探兜底，
    // 二进制（null 字节）/超大文件回退下载提示。
    setState({ loading: true });
    void (async () => {
      try {
        const resp = await fetchWithFallback();
        const cl = Number(resp.headers.get("content-length") || 0);
        if (cl > 2 * 1024 * 1024) {
          antd.message.info("文件超过 2MB，请直接下载");
          close();
          return;
        }
        const blob = await resp.blob();
        if (blob.size > 2 * 1024 * 1024) {
          antd.message.info("文件超过 2MB，请直接下载");
          close();
          return;
        }
        const text = await blob.text();
        if (text.slice(0, 4096).includes("\u0000")) {
          antd.message.info("二进制文件，请直接下载");
          close();
          return;
        }
        setState({
          url: file.url,
          text: text.slice(0, 200000),
          sniffed: true,
        });
      } catch (e) {
        fail(e);
      }
    })();
  }, [file, close]);

  if (!file) return null;
  // md 识别三源（v0.4.82）：扩展名 / mimetype / 内容嗅探——
  // 前两源都可能缺失（Worker 附件不带元数据），嗅探兜底。
  const md =
    ["md", "markdown"].includes(extOf(file.name)) ||
    (file.mimeType || "").toLowerCase().includes("markdown") ||
    (state.sniffed === true && looksLikeMarkdown(state.text || ""));

  return (
    <antd.Modal
      open
      title={file.name}
      footer={
        state.errorUrl || state.error ? null : (
          <antd.Button
            icon={<DownloadIcon />}
            // v0.4.98 再版 10: apiPath 路径（mxc/O19/代抓）裸 href 导航带
            // 不了鉴权头（401）→ 改 onClick blob 下载；纯直链保持 href。
            {...(file.apiPath
              ? {
                  onClick: () => {
                    void (async () => {
                      const ok = await downloadViaHost(
                        file.apiPath as string,
                        file.name,
                      );
                      if (!ok) antd.message.error("下载失败，请稍后重试");
                    })();
                  },
                }
              : { href: state.url || file.url, download: file.name })}
          >
            下载
          </antd.Button>
        )
      }
      onCancel={close}
      width={720}
    >
      {state.errorUrl ? (
        <div
          style={{
            minHeight: 120,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            color: "#999",
            fontSize: 13,
            textAlign: "center",
            padding: "0 24px",
          }}
        >
          <div style={{ fontSize: 22 }}>📎</div>
          <div style={{ color: "#666" }}>该附件没有可用的文件地址</div>
          {file.rawUrl ? (
            <div
              style={{
                fontSize: 11,
                color: "#999",
                wordBreak: "break-all",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                background: "rgba(0,0,0,0.04)",
                padding: "6px 10px",
                borderRadius: 6,
              }}
            >
              原始值：{file.rawUrl.slice(0, 160)}
            </div>
          ) : null}
          <div style={{ fontSize: 12 }}>
            发送方可能用了非 Matrix 的直链且已失效。请在聊天里点「下载」按钮，或让 Worker 重新上传文件。
          </div>
        </div>
      ) : state.error ? (
        <div
          style={{
            minHeight: 120,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            textAlign: "center",
            padding: "0 24px",
          }}
        >
          <div style={{ fontSize: 22 }}>⚠️</div>
          <div style={{ color: "#666", fontSize: 13 }}>文件内容拉取失败</div>
          <div
            style={{
              fontSize: 11,
              color: "#888",
              wordBreak: "break-all",
              textAlign: "left",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              background: "rgba(0,0,0,0.04)",
              padding: "8px 10px",
              borderRadius: 6,
              maxWidth: 560,
              whiteSpace: "pre-wrap",
            }}
          >
            {state.error}
            {file.rawUrl ? `
原始地址：${file.rawUrl.slice(0, 200)}` : ""}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {/^https?:\/\//i.test(file.url) ? (
              <antd.Button size="small" onClick={() => window.open(file.url, "_blank")}>
                新窗口打开原链接
              </antd.Button>
            ) : null}
            {file.apiPath ? (
              <antd.Button
                size="small"
                type="primary"
                icon={<DownloadIcon />}
                onClick={() => {
                  void (async () => {
                    const ok = await downloadViaHost(
                      file.apiPath as string,
                      file.name,
                    );
                    if (!ok) antd.message.error("下载失败，请稍后重试");
                  })();
                }}
              >
                下载
              </antd.Button>
            ) : null}
          </div>
        </div>
      ) : state.table ? (
        <TableView table={state.table} />
      ) : state.text !== undefined ? (
        md ? (
          <div style={{ maxHeight: "60vh", overflow: "auto" }}>
            {/* v0.4.83: 预览弹窗全文渲染——聊天气泡默认 800 字折叠是聊天
                场景防刷屏，预览场景要完整看长报告（用户「RAW 没修好」
                的观感来源之一：长文被截到 400 字 + 展开按钮）。 */}
            <MdText text={state.text} maxLength={Number.MAX_SAFE_INTEGER} />
          </div>
        ) : (
          renderTextPreview(file, state.text)
        )
      ) : state.loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            minHeight: 160,
            color: "#999",
          }}
        >
          <antd.Spin size="small" /> 加载预览…
        </div>
      ) : state.url ? (
        <img
          src={state.url}
          alt={file.name}
          style={{
            maxWidth: "100%",
            maxHeight: "60vh",
            display: "block",
            margin: "0 auto",
          }}
        />
      ) : null}
    </antd.Modal>
  );
}

/** 0.4.99 B4：文本预览分派——json 高亮 / csv·tsv 表格 / 纯文本。 */
function renderTextPreview(
  file: PreviewFile,
  text: string,
): ReactNS.ReactNode {
  const fext = extOf(file.name);
  if (fext === "json") {
    return <JsonHighlight text={text} />;
  }
  if (fext === "csv" || fext === "tsv") {
    try {
      return (
        <TableView
          table={parseDelimited(text, fext === "tsv" ? "\t" : ",")}
        />
      );
    } catch {
      /* 非规整表格 → 纯文本兜底 */
    }
  }
  return <pre style={preStyle}>{text}</pre>;
}

const preStyle: ReactNS.CSSProperties = {
  maxHeight: "60vh",
  overflow: "auto",
  background: "rgba(0,0,0,0.03)",
  padding: 12,
  borderRadius: 8,
  fontSize: 12,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

/** 0.4.99 B4：表格预览（antd Table；首行=表头）。 */
function TableView({ table }: { table: TableData }) {
  const columns = table.header.map((h, i) => ({
    title: h || `列${i + 1}`,
    dataIndex: i,
    key: i,
    ellipsis: true,
    width: 140,
  }));
  const data = table.rows.map((r, ri) => ({
    key: ri,
    ...(Object.fromEntries(r.map((v, ci) => [ci, v])) as Record<number, string>),
  }));
  return (
    <div style={{ maxHeight: "60vh", overflow: "auto" }}>
      {table.note ? (
        <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>
          {table.note}
        </div>
      ) : null}
      <antd.Table
        size="small"
        columns={columns}
        dataSource={data}
        pagination={false}
        scroll={{ x: "max-content" }}
        bordered
      />
    </div>
  );
}

/** 0.4.99 B4：JSON 语法高亮（轻量正则 tokenizer，零依赖）。 */
const JSON_TOKEN_RE =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
function JsonHighlight({ text }: { text: string }) {
  const parts = React.useMemo(() => {
    const out: {
      s: string;
      cls: "" | "key" | "str" | "kw" | "num" | "punc";
    }[] = [];
    let last = 0;
    JSON_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = JSON_TOKEN_RE.exec(text))) {
      if (m.index > last) out.push({ s: text.slice(last, m.index), cls: "" });
      if (m[1]) {
        out.push({ s: m[1], cls: m[2] ? "key" : "str" });
        if (m[2]) out.push({ s: m[2], cls: "punc" });
      } else if (m[3]) {
        out.push({ s: m[3], cls: "kw" });
      } else if (m[4]) {
        out.push({ s: m[4], cls: "num" });
      }
      last = JSON_TOKEN_RE.lastIndex;
    }
    if (last < text.length) out.push({ s: text.slice(last), cls: "" });
    return out;
  }, [text]);
  const colors: Record<string, string> = {
    key: "#c2410c",
    str: "#15803d",
    kw: "#7c3aed",
    num: "#1d4ed8",
    punc: "#666",
  };
  return (
    <pre style={preStyle}>
      {parts.map((p, i) =>
        p.cls ? (
          <span key={i} style={{ color: colors[p.cls] }}>
            {p.s}
          </span>
        ) : (
          <React.Fragment key={i}>{p.s}</React.Fragment>
        ),
      )}
    </pre>
  );
}

/** 供列表/消息渲染处引用（避免重复 import PRIMARY）。 */
export { PRIMARY };

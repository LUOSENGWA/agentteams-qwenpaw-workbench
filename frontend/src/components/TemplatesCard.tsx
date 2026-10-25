// 千锻（Millforge）模板卡——「团队管理」页：模板导入（git clone）/
// pack 列表（来源/ref/commit/导入时间 + 删除）/ 四组模板树
// （skeletons/industry/domain/fragments，点条目右侧只读预览）/
// 每行「用此模板建队」（预填建队表单「模板来源」，不执行编译器）。
// 数据面 = /agentteams-proxy/templates*（templates_api）。
// 诚实降级：无 pack → 空态引导；后端 400/502 → detail 原样展示。

import type * as ReactNS from "react";

import {
  deleteTemplatePack,
  fetchTemplateFile,
  fetchTemplates,
  importTemplates,
  type TemplateEntry,
  type TemplateFileResponse,
  type TemplateIndex,
  type TemplatePack,
} from "../api";
import { BrickIcon } from "./icons";
import { fmtRfc3339 } from "./WorkerManageShared";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { WbTooltip } from "./WbTooltip";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

const DEFAULT_REPO_URL = "https://github.com/LUOSENGWA/millforge.git";

/** 四组展示序（组名 → i18n key，渲染处 tr()）。 */
const SECTION_LABELS: [keyof TemplateIndex, string][] = [
  ["skeletons", "skeletons（骨架）"],
  ["industry", "industry（行业）"],
  ["domain", "domain（领域）"],
  ["fragments", "fragments（片段）"],
];

interface TemplatesCardProps {
  /** 「用此模板建队」→ 打开 CrdManage 建队表单并预填模板来源
   * （<pack>/<id>）。L1 未挂载时由调用方 toast，本卡只上报。 */
  onCreateTeam?: (templateSource: string) => void;
}

interface SelEntry {
  pack: string;
  section: string;
  id: string;
  file: string;
}

function TemplatesCard({ onCreateTeam }: TemplatesCardProps) {
  const t = useThemeColors();
  const tr = useT();

  // ── 列表 ──
  const [packs, setPacks] = React.useState<TemplatePack[]>([]);
  const [listLoading, setListLoading] = React.useState(true);
  const [listError, setListError] = React.useState("");
  const loadList = React.useCallback(async () => {
    setListLoading(true);
    setListError("");
    try {
      const d = await fetchTemplates();
      setPacks(d.packs || []);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void loadList();
  }, [loadList]);

  // ── 导入表单 ──
  const [url, setUrl] = React.useState(DEFAULT_REPO_URL);
  const [ref, setRef] = React.useState("main");
  const [importing, setImporting] = React.useState(false);
  const [importError, setImportError] = React.useState("");
  const [importOk, setImportOk] = React.useState("");
  const doImport = React.useCallback(async () => {
    const u = url.trim();
    const r = ref.trim() || "main";
    if (!u) {
      setImportError(tr("仓库 URL 必填"));
      return;
    }
    setImporting(true);
    setImportError("");
    setImportOk("");
    try {
      const d = await importTemplates(u, r);
      setImportOk(tr("导入成功：{pack}（{n} 个文件）", {
        pack: d.pack,
        n: d.files,
      }));
      void loadList();
    } catch (e) {
      // 诚实降级：后端 400（校验/大小）/ 502（clone 失败）detail 原样展示。
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [url, ref, loadList, tr]);

  // ── 选中 pack + 选中条目 + 文件预览 ──
  const [activePack, setActivePack] = React.useState("");
  const [sel, setSel] = React.useState<SelEntry | null>(null);
  const [file, setFile] = React.useState<TemplateFileResponse | null>(null);
  const [fileLoading, setFileLoading] = React.useState(false);
  const [fileError, setFileError] = React.useState("");
  React.useEffect(() => {
    setActivePack((cur) => {
      if (packs.length === 0) return "";
      if (packs.some((p) => p.pack === cur)) return cur;
      return (packs.find((p) => p.index && !p.parse_error) || packs[0]).pack;
    });
    setSel(null);
  }, [packs]);
  const selKey = sel ? `${sel.pack}:${sel.file}` : "";
  React.useEffect(() => {
    if (!sel) {
      setFile(null);
      setFileError("");
      return;
    }
    let alive = true;
    setFileLoading(true);
    setFileError("");
    fetchTemplateFile(sel.pack, sel.file)
      .then((d) => {
        if (alive) setFile(d);
      })
      .catch((e) => {
        if (alive)
          setFileError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setFileLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  const doDelete = React.useCallback(
    (name: string) => {
      antd.Modal.confirm({
        title: tr("删除模板包「{name}」？", { name }),
        content: tr(
          "已导入的 templates 文件将从本地移除（源仓库不受影响）。",
        ),
        okText: tr("删除"),
        cancelText: tr("取消"),
        onOk: async () => {
          try {
            await deleteTemplatePack(name);
            antd.message.success(tr("已删除"));
            void loadList();
          } catch (e) {
            antd.message.error(
              tr("删除失败") + "：" + (e instanceof Error ? e.message : String(e)),
            );
          }
        },
      });
    },
    [tr, loadList],
  );

  const renderRow = (
    pack: string,
    section: string,
    e: TemplateEntry,
  ): ReactNS.ReactElement | null => {
    if (!e.id && !e.file) return null;
    const key = `${pack}:${e.file}`;
    const selected = selKey === key;
    return (
      <div
        key={e.file || e.id}
        onClick={() =>
          setSel({ pack, section, id: e.id, file: e.file })
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          borderRadius: 6,
          cursor: "pointer",
          borderLeft: selected
            ? "2px solid var(--app-accent, #FF7F16)"
            : "2px solid transparent",
          background: selected
            ? "color-mix(in srgb, var(--app-accent, #FF7F16) 10%, transparent)"
            : "transparent",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontFamily: "monospace" }}>
            {e.id || e.file}
            {e.file && e.id ? (
              <span style={{ color: t.textSecondary, marginLeft: 6 }}>
                {e.file}
              </span>
            ) : null}
          </div>
          <div
            style={{
              fontSize: 11,
              color: t.textSecondary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {[
              e.applies_to ? `${tr("适用")}：${e.applies_to}` : "",
              e.budget ? `${tr("预算")}：${e.budget}` : "",
              e.source ? e.source : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <antd.Button
          size="small"
          type="link"
          style={{ fontSize: 11, padding: "0 4px", flexShrink: 0 }}
          onClick={(ev: ReactNS.MouseEvent) => {
            ev.stopPropagation();
            onCreateTeam?.(`${pack}/${e.id || e.file}`);
          }}
        >
          {tr("用此模板建队")}
        </antd.Button>
      </div>
    );
  };

  return (
    <antd.Card
      size="small"
      title={
        <span
          style={{
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <BrickIcon size={14} /> {tr("千锻模板")}
        </span>
      }
      styles={{ body: { padding: "12px 16px" } }}
    >
      <div style={{ display: "grid", gap: 10 }}>
        <WbTooltip
          title={tr(
            "导入千锻（Millforge）开源模板库（GitHub / GitCode / Gitee），浏览并在建队时预填模板来源（MVP：不执行千锻编译器）",
          )}
        >
          <div style={{ color: t.textSecondary, fontSize: 12, cursor: "help" }}>
            {tr("导入千锻（Millforge）模板库——浏览 + 建队预填（MVP，不执行编译器）")}
          </div>
        </WbTooltip>
        {/* 导入表单：仓库 URL + ref + 导入（loading/错误展示） */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <antd.Input
            size="small"
            style={{ flex: "2 1 320px" }}
            placeholder={tr("仓库 URL（https）")}
            value={url}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setUrl(e.target.value)
            }
          />
          <antd.Input
            size="small"
            style={{ width: 140 }}
            placeholder={tr("分支 / Tag（ref）")}
            value={ref}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setRef(e.target.value)
            }
          />
          <antd.Button
            size="small"
            type="primary"
            loading={importing}
            onClick={() => void doImport()}
          >
            {tr("导入")}
          </antd.Button>
        </div>
        {importError ? (
          <antd.Alert
            type="error"
            showIcon
            message={tr("导入失败")}
            description={
              <span style={{ fontSize: 12, fontFamily: "monospace" }}>
                {importError}
              </span>
            }
          />
        ) : null}
        {importOk ? (
          <antd.Alert type="success" showIcon message={importOk} />
        ) : null}
        {listError ? (
          <antd.Alert
            type="error"
            showIcon
            message={tr("模板列表加载失败")}
            description={
              <span style={{ fontSize: 12, fontFamily: "monospace" }}>
                {listError}
              </span>
            }
          />
        ) : null}
        {packs.length === 0 && !listLoading && !listError ? (
          <antd.Empty
            image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            description={tr(
              "尚未导入模板包——在上方填入千锻仓库地址（默认 GitHub，可换 GitCode / Gitee 镜像）并点导入",
            )}
          />
        ) : null}
        {packs.length > 0 ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 5fr) minmax(0, 4fr)",
              gap: 10,
            }}
          >
            {/* 左：pack 列表 + 模板树 */}
            <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
              {packs.map((p) => (
                <div
                  key={p.pack}
                  style={{
                    border: `1px solid ${t.border}`,
                    borderRadius: 8,
                    padding: 8,
                    opacity: p.pack === activePack ? 1 : 0.72,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      setActivePack(p.pack);
                      setSel(null);
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 12, fontFamily: "monospace" }}>
                      {p.pack}
                    </span>
                    {p.meta ? (
                      <span
                        style={{
                          fontSize: 11,
                          color: t.textSecondary,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                          minWidth: 0,
                        }}
                        title={p.meta.url}
                      >
                        {p.meta.url}
                        {p.meta.ref ? ` · ref ${p.meta.ref}` : ""}
                        {p.meta.commit ? ` · ${p.meta.commit.slice(0, 7)}` : ""}
                        {p.meta.imported_at ? ` · ${tr("导入时间")} ${fmtRfc3339(p.meta.imported_at)}` : ""}
                      </span>
                    ) : (
                      <span style={{ flex: 1 }} />
                    )}
                    <antd.Button
                      size="small"
                      danger
                      type="text"
                      style={{ fontSize: 11, flexShrink: 0 }}
                      onClick={(ev: ReactNS.MouseEvent) => {
                        ev.stopPropagation();
                        doDelete(p.pack);
                      }}
                    >
                      {tr("删除")}
                    </antd.Button>
                  </div>
                  {p.parse_error ? (
                    <antd.Alert
                      type="warning"
                      showIcon
                      style={{ marginTop: 6 }}
                      message={tr("INDEX 解析失败")}
                      description={
                        <span style={{ fontSize: 11, fontFamily: "monospace" }}>
                          {p.parse_error}
                        </span>
                      }
                    />
                  ) : null}
                  {p.index ? (
                    <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                      {SECTION_LABELS.map(([sec, label]) => {
                        const entries = p.index?.[sec] || [];
                        return (
                          <div key={sec}>
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: t.textSecondary,
                                padding: "2px 8px",
                              }}
                            >
                              {tr(label)}
                              {entries.length === 0 ? ` ${tr("（无条目）")}` : ""}
                            </div>
                            {entries.length > 0 ? (
                              <div>
                                {entries.map((e) =>
                                  renderRow(p.pack, sec, e),
                                )}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {/* 右：只读预览 */}
            <div
              style={{
                border: `1px solid ${t.border}`,
                borderRadius: 8,
                padding: 8,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minWidth: 0,
                }}
              >
                {tr("模板预览")}
                {sel ? (
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontWeight: 400,
                      color: t.textSecondary,
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sel.pack}/{sel.file}
                  </span>
                ) : null}
              </div>
              <antd.Spin spinning={fileLoading}>
                {fileError ? (
                  <antd.Alert
                    type="error"
                    showIcon
                    message={tr("读取模板文件失败")}
                    description={
                      <span style={{ fontSize: 11, fontFamily: "monospace" }}>
                        {fileError}
                      </span>
                    }
                  />
                ) : file ? (
                  <pre
                    style={{
                      margin: 0,
                      padding: 8,
                      background: t.mode === "dark" ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
                      border: `1px solid ${t.border}`,
                      borderRadius: 6,
                      fontFamily: "monospace",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 480,
                      overflow: "auto",
                      color: t.text,
                    }}
                  >
                    {file.content}
                  </pre>
                ) : (
                  <div style={{ color: t.textSecondary, fontSize: 12, padding: 8 }}>
                    {tr("选择左侧模板条目查看预览（只读）")}
                  </div>
                )}
              </antd.Spin>
            </div>
          </div>
        ) : null}
      </div>
    </antd.Card>
  );
}

export default React.memo(TemplatesCard);

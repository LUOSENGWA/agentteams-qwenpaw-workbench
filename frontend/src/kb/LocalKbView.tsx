// 本地（宿主）知识库视图（QC-164 阶段 1 自 components/KnowledgeBase.tsx 纯搬移）。

import { DownloadIcon } from "../components/icons";
import type * as ReactNS from "react";

import {
  fetchAgentIdList,
  fetchMemoryGraph,
  fetchMemoryStatus,
  listMemoryFiles,
  loadMemoryFile,
  reindexMemory,
  type MemoryFileItem,
  type MemoryGraphNode,
  type MemorySection,
  type MemoryStatusResponse,
} from "../api";
import MdText from "../components/MdText";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { createPoller, type Poller } from "../usePoller";
import { WbTooltip } from "../components/WbTooltip";
import { GraphCard } from "./GraphCard";
import { FileGroup, RefreshIcon, StatusChip } from "./parts";
import { useKbColHeight } from "./useKbColHeight";
import { KB_CARD_BODY_STYLE, KB_CARD_STYLE, KB_COL_STYLE, saveTextFile } from "./util";
import type { GraphNodeLike, SelectedFile } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 本地（宿主）分类配色。 */
const SECTION_COLOR: Record<string, string> = {
  daily: "#1677ff",
  "digest/personal": "#52c41a",
  "digest/procedure": "#fa8c16",
  "digest/wiki": "#722ed1",
  virtual: "#8c8c8c",
};

// ── 本地（宿主）知识库视图（原实现保留）────────────────────────
export function LocalKbView(props: { refreshTick: number }) {
  const { refreshTick } = props;
  const t = useThemeColors();
  const tr = useT();
  const [agentId, setAgentId] = React.useState("");
  const [graph, setGraph] = React.useState<{ nodes: MemoryGraphNode[]; edges: { source: string; target: string; target_anchor?: string | null }[] } | null>(null);
  const [graphUnavailable, setGraphUnavailable] = React.useState(false);
  const [status, setStatus] = React.useState<MemoryStatusResponse | null>(null);
  const [statusUnavailable, setStatusUnavailable] = React.useState(false);
  const [graphLoading, setGraphLoading] = React.useState(true);
  const [digestFiles, setDigestFiles] = React.useState<MemoryFileItem[]>([]);
  const [dailyFiles, setDailyFiles] = React.useState<MemoryFileItem[]>([]);
  const [filesLoading, setFilesLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [selected, setSelected] = React.useState<SelectedFile | null>(null);
  const [content, setContent] = React.useState("");
  const [contentLoading, setContentLoading] = React.useState(false);
  const [contentError, setContentError] = React.useState("");
  // 文件取回竞态守卫（同 RemoteKbView）。
  const fileSeqRef = React.useRef(0);
  // 两栏全容器化：包裹 Row 的 ref + 量得的两栏高度（未测得 null → 回退旧 CSS 值）。
  const { setRowRef, colH } = useKbColHeight();
  const [reindexing, setReindexing] = React.useState(false);
  // 旧定时器 → 命令式 createPoller（5s 重建检查，
  // !document.hidden——后台暂停；tries/停止逻辑原样保留）。
  const reindexPoller = React.useRef<Poller | null>(null);
  const stopReindexPoll = React.useCallback(() => {
    if (reindexPoller.current !== null) {
      reindexPoller.current.stop();
      reindexPoller.current = null;
    }
  }, []);

  // agentId：宿主当前选中 agent（X-Agent-Id 同会话隔离）。
  React.useEffect(() => {
    let alive = true;
    try {
      const h = window.QwenPaw?.host;
      if (h && typeof h.getSelectedAgentId === "function") {
        const id = h.getSelectedAgentId() || "";
        if (id) {
          setAgentId(id);
          return;
        }
      }
    } catch {
      /* fall through → /agents 兜底 */
    }
    void fetchAgentIdList()
      .then((ids) => {
        if (alive && ids.length > 0) setAgentId(ids[0]);
      })
      .catch(() => {
        /* 无宿主/全失败 → agentId 空 */
      });
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    return () => {
      stopReindexPoll();
    };
  }, [stopReindexPoll]);

  const loadAll = React.useCallback(
    (silent = false) => {
      if (!agentId) return;
      if (!silent) {
        setGraphLoading(true);
        setFilesLoading(true);
      }
      setError("");
      setGraphUnavailable(false);
      setStatusUnavailable(false);
      void (async () => {
        try {
          const [g, s] = await Promise.allSettled([
            fetchMemoryGraph(agentId),
            fetchMemoryStatus(agentId),
          ]);
          if (g.status === "fulfilled") setGraph(g.value);
          else setGraphUnavailable(true);
          if (s.status === "fulfilled") setStatus(s.value);
          else setStatusUnavailable(true);
        } finally {
          setGraphLoading(false);
        }
        const [df, daily] = await Promise.allSettled([
          listMemoryFiles("digest"),
          listMemoryFiles("daily"),
        ]);
        if (df.status === "fulfilled") setDigestFiles(df.value);
        if (daily.status === "fulfilled") setDailyFiles(daily.value);
        setFilesLoading(false);
      })();
    },
    [agentId],
  );

  React.useEffect(() => {
    if (agentId) void loadAll();
  }, [agentId, loadAll]);

  React.useEffect(() => {
    if (refreshTick > 0 && agentId) void loadAll(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const openFile = React.useCallback(
    (section: MemorySection, filename: string) => {
      const title = filename.split("/").pop() || filename;
      setSelected({ section, filename, title });
      const seq = ++fileSeqRef.current;
      setContent("");
      setContentError("");
      setContentLoading(true);
      loadMemoryFile(filename, section)
        .then((c) => {
          if (fileSeqRef.current !== seq) return; // 迟到旧响应，丢弃
          setContent(c);
        })
        .catch((e) => {
          if (fileSeqRef.current !== seq) return;
          setContentError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (fileSeqRef.current !== seq) return;
          setContentLoading(false);
        });
    },
    [],
  );

  const openNode = React.useCallback(
    (node: GraphNodeLike) => {
      const mn = node as MemoryGraphNode;
      if (mn.virtual) {
        antd.message.info(tr("该节点为虚拟根节点，不可打开"));
        return;
      }
      const section: MemorySection | null =
        mn.section === "daily"
          ? "daily"
          : mn.section === "digest"
            ? "digest"
            : null;
      if (!section) return;
      let p = mn.relative_path || "";
      if (!p && mn.path) {
        const prefix = section === "digest" ? "digest/" : "memory/";
        p = mn.path.startsWith(prefix)
          ? mn.path.slice(prefix.length)
          : mn.path;
      }
      if (!p) {
        antd.message.warning(tr("节点缺少文件路径，无法打开"));
        return;
      }
      openFile(section, p);
    },
    [openFile, tr],
  );

  const startReindex = React.useCallback(() => {
    antd.Modal.confirm({
      title: tr("确认重建记忆索引？"),
      content: tr(
        "会重新扫描当前 Agent 的全部记忆文件（memory/ + digest/）。大库耗时数分钟，期间检索可能不完整。",
      ),
      okText: tr("重建"),
      cancelText: tr("取消"),
      onOk: () => {
        setReindexing(true);
        void reindexMemory(agentId)
          .catch((e) => {
            setReindexing(false);
            antd.message.error(
              `${tr("索引重建失败")}: ${e instanceof Error ? e.message : String(e)}`,
            );
          })
          .finally(() => {
            stopReindexPoll();
            let tries = 0;
            const tick = () => {
              tries += 1;
              if (tries > 180) {
                stopReindexPoll();
                setReindexing(false);
                return;
              }
              void fetchMemoryStatus(agentId)
                .then((s) => {
                  setStatus(s);
                  if (!s.runtime.reindexing) {
                    stopReindexPoll();
                    setReindexing(false);
                    antd.message.success(tr("索引重建完成"));
                    void loadAll(true);
                  }
                })
                .catch(() => {
                  stopReindexPoll();
                  setReindexing(false);
                });
            };
            reindexPoller.current = createPoller({
              fn: tick,
              intervalMs: 5000,
              isActive: () => !document.hidden,
            });
            reindexPoller.current.start();
          });
      },
    });
  }, [agentId, loadAll, tr]);

  const digestGroups = React.useMemo(() => {
    const groups = new Map<string, MemoryFileItem[]>();
    for (const f of [...digestFiles].sort((a, b) =>
      a.filename.localeCompare(b.filename),
    )) {
      const seg =
        f.filename.split("/").filter(Boolean)[0]?.toLowerCase() || "other";
      const arr = groups.get(seg) || [];
      arr.push(f);
      groups.set(seg, arr);
    }
    return groups;
  }, [digestFiles]);
  const dailySorted = React.useMemo(
    () => [...dailyFiles].sort((a, b) => b.filename.localeCompare(a.filename)),
    [dailyFiles],
  );

  const auto = status?.runtime?.auto_memory;
  const workerStatus = status?.runtime?.worker?.status;

  if (!agentId) {
    return (
      <antd.Space direction="vertical" style={{ width: "100%", padding: 16 }}>
        <antd.Alert
          type="warning"
          showIcon
          message={tr("宿主环境不可用（无法获取当前 Agent）")}
        />
      </antd.Space>
    );
  }

  return (
    <antd.Space direction="vertical" size={12} style={{ width: "100%" }}>
      <antd.Card
        size="small"
        title={
          <span style={{ fontSize: 13 }}>
            {tr("当前 Agent")}：
            <antd.Typography.Text code style={{ fontSize: 12 }}>
              {agentId}
            </antd.Typography.Text>
            <antd.Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              {tr("本机宿主 QwenPaw")}
            </antd.Typography.Text>
          </span>
        }
        extra={
          <antd.Space size={6}>
            <antd.Button size="small" icon={<RefreshIcon />} onClick={() => void loadAll()}>
              {tr("刷新")}
            </antd.Button>
            <antd.Button
              size="small"
              type="primary"
              ghost
              loading={reindexing}
              disabled={statusUnavailable}
              onClick={startReindex}
            >
              {reindexing ? tr("正在重建索引…") : tr("重建索引")}
            </antd.Button>
          </antd.Space>
        }
      >
        <antd.Space size={16} wrap>
          <StatusChip
            label={tr("自动记忆")}
            value={
              auto?.enabled
                ? `${tr("开")}（${tr("每 N 轮").replace("N", String(auto.interval || 5))}）`
                : tr("关")
            }
            ok={Boolean(auto?.enabled)}
          />
          <StatusChip
            label={tr("记忆 worker")}
            value={
              workerStatus === "idle"
                ? tr("空闲")
                : workerStatus === "busy"
                  ? tr("忙碌")
                  : workerStatus === "stopping"
                    ? tr("停止中")
                    : workerStatus
                      ? tr("错误")
                      : "—"
            }
            ok={workerStatus === "idle"}
          />
          <StatusChip label={tr("进程内存")} value={status?.process_rss || "—"} ok />
          {status?.runtime?.recent?.last_error ? (
            <WbTooltip title={status.runtime.recent.last_error}>
              <StatusChip label={tr("最近错误")} value="⚠" ok={false} />
            </WbTooltip>
          ) : null}
          {graphUnavailable ? (
            <antd.Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {tr("图谱/状态 API 需宿主 2.1.0+（当前 404），仅文件浏览可用")}
            </antd.Typography.Text>
          ) : null}
        </antd.Space>
      </antd.Card>

      <GraphCard
        graph={graph}
        loading={graphLoading}
        error={error}
        onOpenNode={openNode}
      />

      <div ref={setRowRef} style={{ width: "100%" }}>
        <antd.Row gutter={12}>
          <antd.Col span={10} style={{ ...KB_COL_STYLE, height: colH ?? KB_COL_STYLE.height }}>
            <antd.Card size="small" style={KB_CARD_STYLE} styles={{ body: KB_CARD_BODY_STYLE }} title={<span style={{ fontSize: 13 }}>{tr("记忆文件")}</span>}>
              <antd.Spin spinning={filesLoading}>
                <FileGroup
                  title={tr("个人偏好")}
                  color={SECTION_COLOR["digest/personal"]}
                  files={digestGroups.get("personal") || []}
                  selected={selected}
                  onSelect={(k) => openFile("digest", k)}
                />
                <FileGroup
                  title={tr("操作流程")}
                  color={SECTION_COLOR["digest/procedure"]}
                  files={digestGroups.get("procedure") || []}
                  selected={selected}
                  onSelect={(k) => openFile("digest", k)}
                />
                <FileGroup
                  title={tr("Wiki 知识")}
                  color={SECTION_COLOR["digest/wiki"]}
                  files={digestGroups.get("wiki") || []}
                  selected={selected}
                  onSelect={(k) => openFile("digest", k)}
                />
                {digestGroups.get("other") && digestGroups.get("other")!.length > 0 ? (
                  <FileGroup
                    title={tr("其他")}
                    color={SECTION_COLOR.virtual}
                    files={digestGroups.get("other") || []}
                    selected={selected}
                    onSelect={(k) => openFile("digest", k)}
                  />
                ) : null}
                <FileGroup
                  title={tr("每日记忆")}
                  color={SECTION_COLOR.daily}
                  files={dailySorted}
                  selected={selected}
                  onSelect={(k) => openFile("daily", k)}
                  limit={60}
                />
              </antd.Spin>
            </antd.Card>
          </antd.Col>
          <antd.Col span={14} style={{ ...KB_COL_STYLE, height: colH ?? KB_COL_STYLE.height }}>
            <antd.Card
              size="small"
              style={KB_CARD_STYLE}
              styles={{ body: KB_CARD_BODY_STYLE }}
              title={
                <span style={{ fontSize: 13 }}>
                  {selected ? selected.title : tr("预览")}
                </span>
              }
              extra={
                selected && !contentLoading && !contentError && content
                  ? (
                    <antd.Button
                      size="small"
                      onClick={() =>
                        saveTextFile(selected.title, content)
                      }
                    >
                      <DownloadIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("下载")}
                    </antd.Button>
                  )
                  : null
              }
            >
              {contentLoading ? (
                <antd.Spin style={{ display: "block", margin: "40px auto" }} />
              ) : contentError ? (
                <antd.Alert type="error" showIcon message={contentError} />
              ) : content ? (
                <div
                  style={{
                    maxHeight: "none",
                    overflow: "auto",
                    fontSize: 13,
                    lineHeight: 1.7,
                    color: t.text,
                  }}
                >
                  <MdText text={content} maxLength={100000} />
                </div>
              ) : (
                <antd.Empty
                  image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
                  description={tr("点击左侧文件查看内容")}
                  style={{ margin: "40px 0" }}
                />
              )}
            </antd.Card>
          </antd.Col>
        </antd.Row>
      </div>
    </antd.Space>
  );
}

/**
 * CommandPalette.tsx — 全局命令面板（⌘K / Ctrl+K，反向对齐 dashboard R1）。
 *
 * 行为：
 * - 顶层挂载一次（WorkbenchPage），窗口级监听只认 ⌘K/Ctrl+K（其余按键
 *   一律不劫持——输入框内正常打字）；
 * - 打开后：输入框自动聚焦，↑↓ 选择 / Enter 打开 / Esc 关闭，鼠标
 *   hover + 点击等价（行高 ≥44px，触控可达）；
 * - 空输入 = 快捷入口（文件 / 工作流 / 消息 / 设置）；有输入 = 人员 /
 *   团队 / Worker / 项目 / 文件五组模糊匹配，分组展示图标 + 副标题；
 * - 数据懒加载：首次打开才取数，60s 缓存；任何一段失败都静默（面板
 *   仍可用快捷入口导航）；加载中有「加载中…」，无结果有明确空态。
 *
 * 取数走既有 API（不新增依赖）：
 * - fetchAdminData()（crd 缓存 120s）：humans / teams / workers / managers
 * - fetchProjectSummaries()（projects/list 缓存 30s）
 * - listFiles(human, "")（管理页文件域根目录；human 名由当前 MXID 解析）
 */
import type * as ReactNS from "react";

import {
  fetchAdminData,
  fetchProjectSummaries,
  listFiles,
  entryRelPath,
  isEntryDir,
  type AdminData,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import type { ManageSectionFocus } from "../manage/useManageNav";
import {
  buildItems,
  groupItems,
  moveIndex,
  resolveEnterTarget,
  resolveSelfHumanName,
  EMPTY_SOURCE,
  type PaletteGroup,
  type PaletteItem,
  type PaletteSource,
} from "../lib/commandPalette";
import {
  FolderIcon,
  MessageIcon,
  RobotIcon,
  SearchIcon,
  SettingsIcon,
  TeamIcon,
  TopologyIcon,
  UserIcon,
  CrownIcon,
} from "./icons";

const host = window.QwenPaw.host;
const React = host.React;

const PRIMARY = "var(--app-accent, #FF7F16)";

/** 列表 60s 缓存（首次打开才取数；过期后下次打开静默刷新）。 */
const SOURCE_TTL_MS = 60_000;
/** 每组数据上限（避免首屏拉全量；命令面板只做「跳转入口」）。 */
const FILE_LIMIT = 50;
const PROJECT_LIMIT = 50;

interface SourceCache {
  at: number;
  source: PaletteSource;
}

let sourceCache: SourceCache | null = null;
let inflight: Promise<PaletteSource> | null = null;

function mapAdmin(admin: AdminData | null): Pick<PaletteSource, "humans" | "teams" | "workers"> {
  const humans = (admin?.humans ?? []).map((h) => ({
    name: h.name,
    displayName: h.displayName || undefined,
    matrixUserID: h.matrixUserID || undefined,
  }));
  const teams = (admin?.teams ?? []).map((t) => ({
    name: t.name,
    teamName: t.teamName || undefined,
    leaderName: t.leaderName || undefined,
    readyWorkers: t.readyWorkers,
    totalWorkers: t.totalWorkers,
  }));
  const workers = (admin?.workers ?? []).map((w) => ({
    name: w.name,
    workerName: w.workerName || undefined,
    team: w.team || undefined,
    runtime: w.runtime || undefined,
    model: w.model || undefined,
    role: w.role || undefined,
  }));
  // Manager 同为「可跳转的 agent」——并入 Worker 组，role 标注来源。
  for (const m of admin?.managers ?? []) {
    workers.push({
      name: m.name,
      workerName: m.name,
      team: undefined,
      runtime: m.runtime || undefined,
      model: m.model || undefined,
      role: "Manager",
    });
  }
  return { humans, teams, workers };
}

/** 取数（失败静默：单段失败 = 该组为空，不阻断其它组）。 */
async function loadSource(myUserId: string): Promise<PaletteSource> {
  if (sourceCache && Date.now() - sourceCache.at < SOURCE_TTL_MS) {
    return sourceCache.source;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const [admin, rawProjects] = await Promise.all([
      fetchAdminData().catch(() => null),
      fetchProjectSummaries().catch(() => [] as Record<string, unknown>[]),
    ]);
    const base = mapAdmin(admin);
    const projects = rawProjects.slice(0, PROJECT_LIMIT).map((p) => ({
      projectId: String(p.project_id || ""),
      title: typeof p.title === "string" ? p.title : undefined,
      team: typeof p.team_id === "string" ? p.team_id : undefined,
      status: typeof p.status === "string" ? p.status : undefined,
    })).filter((p) => p.projectId);

    // 文件组：当前 Human 的文件根目录（管理页文件域可达的条目）。
    const humanName = resolveSelfHumanName(base.humans, myUserId);
    let files: PaletteSource["files"] = [];
    if (humanName) {
      try {
        const page = await listFiles(humanName, "");
        files = page.entries
          .filter((e) => !isEntryDir(e))
          .map((e) => entryRelPath(e))
          // 详情面板按「当前目录条目」寻址——只收根目录文件，避免跳过去空态。
          .filter((p) => p && !p.includes("/"))
          .slice(0, FILE_LIMIT)
          .map((path) => ({ path }));
      } catch {
        files = [];
      }
    }

    const source: PaletteSource = { ...base, projects, files };
    sourceCache = { at: Date.now(), source };
    return source;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 快捷入口（空输入 / 无结果兜底）：文案走 i18n，key = 顶层 tab。 */
function quickEntries(tr: (s: string) => string): PaletteItem[] {
  return [
    {
      id: "quick:files",
      group: "quick",
      key: "files",
      title: tr("文件"),
      subtitle: tr("文件管理与上传"),
    },
    {
      id: "quick:workflow",
      group: "quick",
      key: "workflow",
      title: tr("工作流"),
      subtitle: tr("项目进展与任务拓扑"),
    },
    {
      id: "quick:chat",
      group: "quick",
      key: "chat",
      title: tr("消息"),
      subtitle: tr("团队群聊"),
    },
    {
      id: "quick:settings",
      group: "quick",
      key: "settings",
      title: tr("设置"),
      subtitle: tr("连接、凭据与自检"),
    },
  ];
}

const GROUP_LABEL: Record<PaletteGroup, string> = {
  quick: "快捷入口",
  people: "人员",
  team: "团队",
  worker: "Worker",
  project: "项目",
  file: "文件",
};

function GroupIcon({ group, item }: { group: PaletteGroup; item: PaletteItem }) {
  if (group === "quick") {
    if (item.key === "files") return <FolderIcon size={16} />;
    if (item.key === "workflow") return <TopologyIcon size={16} />;
    if (item.key === "chat") return <MessageIcon size={16} />;
    return <SettingsIcon size={16} />;
  }
  if (group === "people") return <UserIcon size={16} />;
  if (group === "team") return <TeamIcon size={16} />;
  if (group === "worker")
    return item.subtitle.startsWith("Manager") ? (
      <CrownIcon size={16} />
    ) : (
      <RobotIcon size={16} />
    );
  if (group === "project") return <TopologyIcon size={16} />;
  return <FolderIcon size={16} />;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** 当前登录 MXID（文件组解析 Human 名）。 */
  myUserId?: string;
  /** 快捷入口：顶层 tab 跳转（复用 setTab）。 */
  onGotoTab: (tabKey: string) => void;
  /** 管理页实体深链（域 + 选中项）。 */
  onOpenManage: (req: ManageSectionFocus) => void;
  /** 项目 → 工作流（复用 handleOpenProject）。 */
  onOpenProject: (projectId: string) => void;
}

function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose, myUserId = "", onGotoTab, onOpenManage, onOpenProject } = props;
  const t = useThemeColors();
  const tr = useT();
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const [source, setSource] = React.useState<PaletteSource | null>(
    () => sourceCache?.source ?? null,
  );
  const [loading, setLoading] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // 打开：重置输入/选中；缓存过期（或从未加载）则取数（失败静默）。
  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const fresh = sourceCache && Date.now() - sourceCache.at < SOURCE_TTL_MS;
    if (fresh) return;
    let alive = true;
    setLoading(true);
    void loadSource(myUserId)
      .then((s) => {
        if (alive) setSource(s);
      })
      .catch(() => {
        if (alive && !sourceCache) setSource(EMPTY_SOURCE);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // source 不进 deps：只在打开/身份变化时评估缓存新鲜度。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, myUserId]);

  const quick = React.useMemo(() => quickEntries(tr), [tr]);
  const items = React.useMemo(
    () => buildItems(source ?? EMPTY_SOURCE, query, quick),
    [source, query, quick],
  );
  /** 无结果（且有输入）→ 保底渲染快捷入口（错误静默、仍可导航）。 */
  const noResults = query.trim() !== "" && items.length === 0;
  const visible = React.useMemo(
    () => (noResults ? quick : items),
    [noResults, quick, items],
  );
  const groups = React.useMemo(() => groupItems(visible), [visible]);

  // 结果集变化后夹住选中项（避免越界高亮消失）。
  React.useEffect(() => {
    setIndex((i) => (visible.length === 0 ? 0 : Math.min(i, visible.length - 1)));
  }, [visible.length]);

  // 选中行滚动到可视区。
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${index}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [index, visible.length]);

  const activate = React.useCallback(
    (item: PaletteItem | null) => {
      if (!item) return;
      onClose();
      if (item.group === "quick") {
        // 「文件」不在顶层 tab 里（管理页 files 域）——走 manage 深链。
        if (item.key === "files") onOpenManage({ section: "files" });
        else onGotoTab(item.key);
      } else if (item.group === "people")
        onOpenManage({ section: "people", human: item.key });
      else if (item.group === "team") onOpenManage({ section: "team", team: item.key });
      else if (item.group === "worker") onOpenManage({ section: "team", worker: item.key });
      else if (item.group === "project") onOpenProject(item.key);
      else onOpenManage({ section: "files", file: item.key });
    },
    [onClose, onGotoTab, onOpenManage, onOpenProject],
  );

  const onInputKeyDown = React.useCallback(
    (e: ReactNS.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => moveIndex(i, 1, visible.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => moveIndex(i, -1, visible.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        activate(resolveEnterTarget(visible, index));
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [activate, index, onClose, visible],
  );

  // 输入框失焦（例如点了面板外区域）时 Esc 仍能关——全局兜底。
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  let flatIdx = -1;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "10vh",
        paddingLeft: 12,
        paddingRight: 12,
        boxSizing: "border-box",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tr("全局搜索")}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 100%)",
          maxHeight: "min(70vh, 560px)",
          display: "flex",
          flexDirection: "column",
          background: t.popoverBg,
          borderRadius: 14,
          border: `1px solid ${t.border}`,
          boxShadow: "0 18px 60px rgba(0,0,0,0.32)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderBottom: `1px solid ${t.border}`,
          }}
        >
          <SearchIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder={tr("搜索人员 / 团队 / Worker / 项目 / 文件")}
            aria-label={tr("全局搜索")}
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              color: t.text,
              fontSize: 15,
              lineHeight: "24px",
            }}
          />
          <span
            style={{
              flexShrink: 0,
              fontSize: 11,
              color: t.textSecondary,
              border: `1px solid ${t.border}`,
              borderRadius: 6,
              padding: "1px 6px",
            }}
          >
            Esc
          </span>
        </div>
        <div ref={listRef} style={{ overflowY: "auto", flex: "1 1 auto", minHeight: 0 }}>
          {loading ? (
            <div style={{ padding: "10px 14px", fontSize: 12, color: t.textSecondary }}>
              {tr("加载中…")}
            </div>
          ) : null}
          {noResults ? (
            <div style={{ padding: "16px 14px 4px" }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: t.text }}>
                {tr("无匹配结果")}
              </div>
              <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 2 }}>
                {tr("换个关键词试试，或使用快捷入口")}
              </div>
            </div>
          ) : null}
          {groups.map(({ group, items: rows }) => (
            <div key={group}>
              <div
                style={{
                  padding: "8px 14px 4px",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  color: t.textSecondary,
                  textTransform: "uppercase",
                }}
              >
                {tr(GROUP_LABEL[group])} ({rows.length})
              </div>
              {rows.map((item) => {
                flatIdx += 1;
                const idx = flatIdx;
                const active = idx === index;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-idx={idx}
                    onMouseEnter={() => setIndex(idx)}
                    onClick={() => activate(item)}
                    style={{
                      width: "100%",
                      minHeight: 44,
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 14px",
                      border: "none",
                      borderLeft: `3px solid ${active ? PRIMARY : "transparent"}`,
                      background: active ? t.accentBg : "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                      color: t.text,
                    }}
                  >
                    <span style={{ color: active ? PRIMARY : t.textSecondary, flexShrink: 0 }}>
                      <GroupIcon group={item.group} item={item} />
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: 13.5,
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.title}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontSize: 11.5,
                          color: t.textSecondary,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.subtitle}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 14px",
            borderTop: `1px solid ${t.border}`,
            fontSize: 11,
            color: t.textSecondary,
          }}
        >
          <span>{tr("↑↓ 选择 · Enter 打开 · Esc 关闭")}</span>
          <span style={{ flex: 1 }} />
          <span>{query.trim() ? tr("文本匹配结果") : tr("快捷入口")}</span>
        </div>
      </div>
    </div>
  );
}

/** 全局快捷键：只认 ⌘K / Ctrl+K（其余按键不劫持——输入框内正常打字）。 */
export function useCommandPaletteHotkey(onOpen: () => void): void {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (String(e.key || "").toLowerCase() !== "k") return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
}

export default React.memo(CommandPalette);

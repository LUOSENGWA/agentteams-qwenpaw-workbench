/**
 * useManageNav.ts — 「管理」页导航状态（L0 五域 → L1 中栏 → L2 详情）。
 *
 * 各域状态机本身即 L2 层级（不另设栈结构——竖屏「← 返回」= 本状态机
 * 逐级降层）：
 * - team:    list → topology → worker | settings
 * - crd:     list → human | team | worker
 * - people:  list → (selectedHuman + access | perm)
 * - cluster: overview → logs | audit | upgrade（15.36 C 加批量升级）
 * - files:   扁平（#1426 Human Files；仅 selectedFile 跨列选中，无详情层）
 * 各域选择互不影响 section 切换（切走再切回保留状态）；back 只降本域。
 *
 * 深链（首页 SGLang 卡 → 集群管理）经 ManagePage 的 sectionRequest
 * prop 消费（setSection 一次性落域）。
 */
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export type ManageSection = "team" | "crd" | "people" | "cluster" | "files";
export type TeamView = "list" | "topology" | "worker" | "settings";
export type CrdView = "list" | "human" | "team" | "worker";
export type PeopleView = "list" | "access" | "perm";
export type ClusterView = "overview" | "logs" | "audit" | "upgrade";

export interface ManageNav {
  section: ManageSection;
  teamView: TeamView;
  selectedTeam: string | null;
  selectedWorker: string | null;
  selectedManager: string | null;
  crdView: CrdView;
  peopleView: PeopleView;
  selectedHuman: string | null;
  clusterView: ClusterView;
  /** 当前 section 是否处于详情层（竖屏 L2 二级页判定；各域详情态
   * 恒 true——cluster 的 logs/audit/upgrade 含内）。 */
  inDetail: boolean;
  setSection: (s: ManageSection) => void;
  /** 中栏点团队行 → 拓扑（清 Worker 选中，右栏回到空态）。 */
  openTeam: (name: string) => void;
  /** 拓扑点节点 → Worker/Leader 详情（右栏 / 竖屏再推一层）。 */
  openWorker: (name: string) => void;
  openManager: (name: string) => void;
  /** 团队拓扑齿轮 → 团队设置（右栏内联，非弹窗）。 */
  openTeamSettings: () => void;
  /** 竖屏「←」：worker/settings → topology；topology → list。 */
  backTeam: () => void;
  /** 横屏面包屑「团队列表」：回列表（清选中团队/Worker）。 */
  goTeamList: () => void;
  /** 横屏面包屑「[团队名]」：回该团队拓扑（清 Worker 选中）。 */
  goTeamTopology: () => void;
  setCrdView: (v: CrdView) => void;
  selectHuman: (name: string, view?: PeopleView) => void;
  setPeopleView: (v: PeopleView) => void;
  /** 横屏面包屑「人员列表」：回列表（清选中人员）。 */
  clearPeople: () => void;
  setClusterView: (v: ClusterView) => void;
  /** files 域选中的文件名（跨列：l1 列表 → mid/right 详情；null = 未选）。 */
  selectedFile: string | null;
  selectFile: (name: string | null) => void;
}

export function useManageNav(): ManageNav {
  const [section, setSection] = React.useState<ManageSection>("team");
  const [teamView, setTeamView] = React.useState<TeamView>("list");
  const [selectedTeam, setSelectedTeam] = React.useState<string | null>(null);
  const [selectedWorker, setSelectedWorker] = React.useState<string | null>(null);
  const [selectedManager, setSelectedManager] = React.useState<string | null>(null);
  const [crdView, setCrdView] = React.useState<CrdView>("list");
  const [peopleView, setPeopleView] = React.useState<PeopleView>("list");
  const [selectedHuman, setSelectedHuman] = React.useState<string | null>(null);
  const [clusterView, setClusterView] = React.useState<ClusterView>("overview");
  const [selectedFile, setSelectedFile] = React.useState<string | null>(null);
  const selectFile = React.useCallback((name: string | null) => {
    setSelectedFile(name);
  }, []);

  const openTeam = React.useCallback((name: string) => {
    setSelectedTeam(name);
    setSelectedWorker(null);
    setSelectedManager(null);
    setTeamView("topology");
  }, []);
  const openManager = React.useCallback((name: string) => {
    setSelectedManager(name);
    setSelectedWorker(null);
    setSelectedTeam(null);
    setTeamView("list");
  }, []);

  const openWorker = React.useCallback((name: string) => {
    setSelectedWorker(name);
    setSelectedManager(null);
    setTeamView("worker");
  }, []);
  const openTeamSettings = React.useCallback(() => {
    setTeamView("settings");
  }, []);
  const backTeam = React.useCallback(() => {
    setSelectedManager(null);
    if (teamView === "worker" || teamView === "settings") {
      setTeamView(selectedTeam ? "topology" : "list");
      setSelectedWorker(null);
    } else {
      setTeamView("list");
      setSelectedTeam(null);
      setSelectedWorker(null);
    }
  }, [teamView, selectedTeam]);

  const goTeamList = React.useCallback(() => {
    setSelectedManager(null);
    setTeamView("list");
    setSelectedTeam(null);
    setSelectedWorker(null);
  }, []);
  const goTeamTopology = React.useCallback(() => {
    if (!selectedTeam) return;
    setTeamView("topology");
    setSelectedWorker(null);
  }, [selectedTeam]);
  const clearPeople = React.useCallback(() => {
    setPeopleView("list");
    setSelectedHuman(null);
  }, []);

  const selectHuman = React.useCallback((name: string, view: PeopleView = "access") => {
    setSelectedHuman(name);
    setPeopleView(view);
  }, []);

  const inDetail =
    (section === "team" && teamView !== "list") ||
    (section === "crd" && crdView !== "list") ||
    (section === "people" && peopleView !== "list" && selectedHuman !== null) ||
    (section === "cluster" && clusterView !== "overview");

  return {
    section,
    teamView,
    selectedTeam,
    selectedWorker,
    selectedManager,
    crdView,
    peopleView,
    selectedHuman,
    clusterView,
    inDetail,
    setSection,
    openTeam,
    openWorker,
    openManager,
    openTeamSettings,
    backTeam,
    goTeamList,
    goTeamTopology,
    setCrdView,
    selectHuman,
    setPeopleView,
    clearPeople,
    setClusterView,
    selectedFile,
    selectFile,
  };
}

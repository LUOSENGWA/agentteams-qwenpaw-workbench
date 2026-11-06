// Workspace Access 数据面域（H2 #1502）：人员工作区 files/** 的团队访问
// 授予（grants）/ 限制（restrictions）。
//
// 契约（#1502 已合，main 8ca5ae881 + 修复 014c32dd3，正文逐字）：
//   Human CR spec.workspaceAccess =
//     {
//       grants:       [{ team, paths: [...], mode: "read" | "readwrite" }],
//       restrictions: [{ team, paths: [...], mode: "none" | "read" }]
//     }
// 语义（controller human_workspace_access.go 组合序）：
// - 默认访问按成员关系派生：defaultTeams = accessibleTeams ∪ { humanMembers
//   含该人员的团队 } → files/** readwrite（UI 只解释，不写此字段）；
// - grants = 为非成员团队加授（模式只能 read/readwrite，raise only）；
// - restrictions = 收窄默认（none = 撤销 / read = 降级）；restriction 是
//   global deny（跨调用方全部团队，最强生效），在 baseline/grant 最大值之后
//   应用，同路径 restriction 优先（fail closed）；
// - memory/**、digest/** 与 .trash/ .sync/ .control/ 永不可寻址（400）；
// - 路径规则：必须在 files/ 下；禁止绝对路径、反斜杠、控制字符、尾 /、
//   空段、. / .. 段、顶层保留名 .trash/.sync/.control（仅顶层——
//   files/reports/.trash/x 合法）；glob 元字符只有 *（单段）与 **（零或多个整段）；
// - 同一团队在同列表中至多一条规则（两列表可同团队）；
// - 每列表 ≤32 规则、每规则 ≤16 路径、每规则 ≥1 路径、team 非空。
// 线语义（与 modelAccess 不同！）：
// - workspaceAccess 键 absent（或 null）= 不变；对象在场 = 整体替换；
//   空对象 {} = 清空两列表——清空发 {}，不是删键 / 发 null（PATCH merge-patch
//   下 null 会删键，语义不同，禁用）；
// - 旧控制器（未重建 #1502）对 PUT 的未知字段静默忽略（200 不落库）→
//   保存后须 re-GET 验证（verifyWorkspaceAccessSaved）；
// - #1502 快照的 GET /humans/{name}（HumanResponse）不回显 workspaceAccess
//   （write-only）→ 读路径对 flat cr.workspaceAccess / 完整 CR
//   cr.spec.workspaceAccess 双形状防御；re-GET「字段缺失」可能是
//   (a) 旧控制器丢弃 或 (b) 新控制器不回显——UI 统一按「保存未生效」
//   告警展示（口径见任务报告不确定性节）。
//
// 写面复用 modelAccess 同源的读-改-写 + PUT→PATCH 模式（shared.ts 请求
// 工具与 requestCache/memoryLru 写失效）；校验是独立纯函数，编辑器行内
// 红字与父组件保存门共用同一来源（同 modelAccess.findPairIssues 口径）。
import {
  controllerRequest,
  fetchControllerJson,
  httpErrorStatus,
} from "../shared";
import { invalidateTags } from "../../requestCache";
import { lruInvalidate } from "../../cache/memoryLru";

/** 规则模式（wire 值；grants ∈ read/readwrite，restrictions ∈ none/read）。 */
export type AccessMode = "read" | "readwrite" | "none";

/** 一条访问规则（团队 + 路径集 + 模式）。 */
export interface WorkspaceAccessRule {
  team: string;
  paths: string[];
  mode: AccessMode;
}

/** Human CR spec.workspaceAccess（grants / restrictions 均可缺省）。 */
export interface WorkspaceAccess {
  grants?: WorkspaceAccessRule[];
  restrictions?: WorkspaceAccessRule[];
}

const GRANT_MODES: AccessMode[] = ["read", "readwrite"];
const RESTRICTION_MODES: AccessMode[] = ["none", "read"];
const RESERVED_TOP_LEVEL = [".trash", ".sync", ".control"];
const MAX_RULES_PER_LIST = 32;
const MAX_PATHS_PER_RULE = 16;

function asRecord(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

// ────────────────────────────────────────────────────────────────────
// 校验（纯函数；镜像 server validateHumanWorkspaceAccess /
// validateWorkspaceAccessPath。issue 只带结构化信息，消息文案由编辑器
// 经 tr() 映射——同 modelAccess.findPairIssues 口径）。
// ────────────────────────────────────────────────────────────────────

/** 结构化校验问题（编辑器行内红字 + 保存门）。 */
export interface AccessIssue {
  list: "grants" | "restrictions";
  /** 该列表内规则下标（-1 = 列表级问题）。 */
  index: number;
  kind:
    | "bad_path"
    | "bad_mode"
    | "empty_team"
    | "dup_team"
    | "unknown_team"
    | "no_paths"
    | "too_many_paths"
    | "too_many_rules";
  /** bad_path: 非法路径；bad_mode: 越界模式；dup_team/unknown_team: 团队名。 */
  detail?: string;
}

/**
 * 校验单条路径（镜像 server validateWorkspaceAccessPath；null = 合法）。
 * 规则序与 server 一致：空串 → 绝对路径 → 反斜杠 → 控制字符 →
 * files/ 前缀 → 尾 / → 段级（空段 / . / ..）→ 顶层保留名。
 */
export function validateAccessPath(p: unknown): string | null {
  if (typeof p !== "string" || p === "") return "empty";
  if (p.startsWith("/")) return "absolute";
  if (p.includes("\\")) return "backslash";
  for (const ch of p) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return "control";
  }
  if (!p.startsWith("files/")) return "not_files";
  if (p.endsWith("/")) return "trailing_slash";
  const rel = p.slice("files/".length);
  for (const seg of rel.split("/")) {
    if (seg === "") return "empty_segment";
    if (seg === "." || seg === "..") return "dot_segment";
  }
  for (const reserved of RESERVED_TOP_LEVEL) {
    if (rel === reserved || rel.startsWith(reserved + "/")) return "reserved";
  }
  return null;
}

function asRule(x: unknown): WorkspaceAccessRule | null {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (typeof r.team !== "string") return null;
  if (!Array.isArray(r.paths)) return null;
  if (typeof r.mode !== "string") return null;
  const paths: string[] = [];
  for (const p of r.paths) if (typeof p === "string") paths.push(p);
  return { team: r.team, paths, mode: r.mode as AccessMode };
}

function listRules(
  a: WorkspaceAccess | null | undefined,
  list: "grants" | "restrictions",
): WorkspaceAccessRule[] {
  const raw = a?.[list];
  if (!Array.isArray(raw)) return [];
  return raw.map(asRule).filter((r): r is WorkspaceAccessRule => r !== null);
}

/**
 * 纯校验（编辑器保存门 + 行内红字同一来源；镜像 server 校验）：
 * - 每列表 ≤32 规则；每规则 team 非空、同列表不重复、≥1 路径、≤16 路径、
 *   模式在该列表范围内、每条路径合法（validateAccessPath）；
 * - teams：/teams 候选名单（null = 端点不可用 → 跳过「团队不存在」检查，
 *   对应编辑器自由输入降级）。
 */
export function validateAccess(
  a: WorkspaceAccess | null | undefined,
  teams?: string[] | null,
): AccessIssue[] {
  const issues: AccessIssue[] = [];
  const checkList = (list: "grants" | "restrictions", allowed: AccessMode[]) => {
    const rules = listRules(a, list);
    if (rules.length > MAX_RULES_PER_LIST) {
      issues.push({
        list,
        index: -1,
        kind: "too_many_rules",
        detail: String(rules.length),
      });
    }
    const seen = new Set<string>();
    rules.forEach((rule, i) => {
      const team = rule.team.trim();
      if (team === "") {
        issues.push({ list, index: i, kind: "empty_team" });
      } else {
        if (seen.has(team)) issues.push({ list, index: i, kind: "dup_team", detail: team });
        seen.add(team);
        if (teams !== null && teams !== undefined && !teams.includes(team)) {
          issues.push({ list, index: i, kind: "unknown_team", detail: team });
        }
      }
      const paths = rule.paths.filter((p) => typeof p === "string");
      if (paths.length === 0) issues.push({ list, index: i, kind: "no_paths" });
      if (paths.length > MAX_PATHS_PER_RULE) {
        issues.push({ list, index: i, kind: "too_many_paths", detail: String(paths.length) });
      }
      if (!allowed.includes(rule.mode)) {
        issues.push({ list, index: i, kind: "bad_mode", detail: rule.mode });
      }
      for (const p of paths) {
        if (validateAccessPath(p) !== null) issues.push({ list, index: i, kind: "bad_path", detail: p });
      }
    });
  };
  checkList("grants", GRANT_MODES);
  checkList("restrictions", RESTRICTION_MODES);
  return issues;
}

/**
 * 编辑器值 → wire 载荷（恒为对象，永不为 null——与 modelAccess 的
 * null-清除语义不同）：
 * - 合法规则（team trim 非空 + ≥1 路径 + 模式在列表范围内）保留；
 *   不合法行静默丢弃（UI 保存门已拦，这里是二道防线）；
 * - 两列表均为空 → {}（server 语义：空对象 = 清空两列表）。
 */
export function buildWorkspaceAccessPayload(
  a: WorkspaceAccess | null | undefined,
): Record<string, unknown> {
  const clean = (
    rules: WorkspaceAccessRule[] | undefined,
    allowed: AccessMode[],
  ): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (const r of rules ?? []) {
      const team = r.team.trim();
      const paths = (r.paths ?? []).filter((p): p is string => typeof p === "string" && p !== "");
      if (!team || paths.length === 0) continue;
      if (!allowed.includes(r.mode)) continue;
      out.push({ team, paths, mode: r.mode });
    }
    return out;
  };
  const out: Record<string, unknown> = {};
  const grants = clean(a?.grants, GRANT_MODES);
  if (grants.length) out.grants = grants;
  const restrictions = clean(a?.restrictions, RESTRICTION_MODES);
  if (restrictions.length) out.restrictions = restrictions;
  return out; // {} = 清空两列表
}

// ────────────────────────────────────────────────────────────────────
// 读 / 写 / 验证（读-改-写，任务书强约束：只动 spec.workspaceAccess，
// 其余字段原样带回；PUT 404/405 → PATCH merge-patch 兜底）。
// ────────────────────────────────────────────────────────────────────

/** 读取视图（CR 原样 + 解析出的 workspaceAccess）。 */
export interface WorkspaceAccessView {
  /** 人 CR 原样（完整 CR 形状或 flat 形状——写面按此定 body）。 */
  cr: Record<string, unknown> | null;
  /** 配置的 spec.workspaceAccess（null = 未配置 → 编辑器显「未配置（继承默认）」）。 */
  access: WorkspaceAccess | null;
}

function extractWorkspaceAccess(cr: Record<string, unknown> | null): WorkspaceAccess | null {
  if (!cr) return null;
  const holder = asRecord(cr.spec) ?? cr;
  const wa = asRecord(holder.workspaceAccess);
  if (!wa) return null;
  const out: WorkspaceAccess = {};
  for (const list of ["grants", "restrictions"] as const) {
    const rules = listRules(wa as WorkspaceAccess, list);
    if (rules.length) out[list] = rules;
  }
  return out;
}

/**
 * 读人员的工作区访问（GET /humans/{name}）。
 * 注意：#1502 快照的 HumanResponse 不回显 workspaceAccess（write-only）→
 * 当前部署下 access 通常为 null（编辑器显空态）；读路径对 flat / spec
 * 双形状防御，将来控制器版本回显时自动可用。
 */
export async function getHumanWorkspaceAccess(name: string): Promise<WorkspaceAccessView> {
  const cr = asRecord(await fetchControllerJson<unknown>(`humans/${encodeURIComponent(name)}`));
  return { cr, access: extractWorkspaceAccess(cr) };
}

/**
 * 保存 spec.workspaceAccess（读-改-写，任务书强约束）：
 * ① GET /humans/{name} 读现状（CR 原样形状）；
 * ② 只改 workspaceAccess 一个字段（payload = buildWorkspaceAccessPayload，
 *    {} = 清空两列表；键恒在场 = 替换语义，绝不发 null——merge-patch 下
 *    null 删键，语义不同），其余字段（metadata / spec 兄弟字段）原样
 *    带回——防整体覆盖丢字段；
 * ③ 完整 CR 形状（有 spec 键）→ PUT 整体 CR；flat 形状（本控制器 /humans
 *    惯例，updateHumanAccess 同源）→ PUT spec-direct body；
 *    PUT 404/405（控制器无 PUT /humans 端点）→ PATCH merge-patch 兜底
 *    （只发 workspaceAccess 对象，{} = 清空）。
 * 成功 → 写面失效（与 crd.ts 各写函数同源）。返回实际使用的 method。
 */
export async function saveWorkspaceAccess(
  name: string,
  access: WorkspaceAccess,
): Promise<{ method: "PUT" | "PATCH" }> {
  const payload = buildWorkspaceAccessPayload(access); // {} = 清空
  const path = `humans/${encodeURIComponent(name)}`;
  const cr = asRecord(await fetchControllerJson<unknown>(path));
  if (!cr) throw new Error("人 CR 读取结果非法（期望对象）");
  const spec = asRecord(cr.spec);
  let method: "PUT" | "PATCH" = "PUT";
  let body: Record<string, unknown>;
  if (spec) {
    // 完整 CR 形状：PUT 整体 CR（契约 body {"spec":{...}}）。
    const nextSpec: Record<string, unknown> = { ...spec, workspaceAccess: payload };
    body = { ...cr, spec: nextSpec };
  } else {
    // flat 形状：spec-direct body（其余键原样带回）。
    body = { ...cr, workspaceAccess: payload };
  }
  try {
    await controllerRequest("PUT", path, body);
  } catch (e) {
    const st = httpErrorStatus(e);
    if (st !== 404 && st !== 405) throw e;
    // 旧控制器无 PUT /humans → PATCH（merge-patch：发对象 = 替换；{} = 清空）。
    method = "PATCH";
    body = spec ? { spec: { workspaceAccess: payload } } : { workspaceAccess: payload };
    await controllerRequest("PATCH", path, body);
  }
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return { method };
}

/** re-GET 验证结果（silent-drop 检测，任务书强制降级项）。 */
export interface WorkspaceAccessVerifyResult {
  /** true = 回读内容与所存等价（或所存为空且回读亦空）。 */
  verified: boolean;
  /** 服务端实际回读的 workspaceAccess（null = 响应未含此字段）。 */
  current: WorkspaceAccess | null;
}

function accessIsEmpty(a: WorkspaceAccess | null): boolean {
  if (!a) return true;
  return (a.grants?.length ?? 0) === 0 && (a.restrictions?.length ?? 0) === 0;
}

function rulesEqual(a: WorkspaceAccess | null, b: WorkspaceAccess | null): boolean {
  const norm = (x: WorkspaceAccess | null) => {
    const pick = (list: "grants" | "restrictions") =>
      listRules(x, list)
        .map((r) =>
          JSON.stringify({ team: r.team.trim(), paths: [...r.paths].sort(), mode: r.mode }),
        )
        .sort();
    return { g: pick("grants"), r: pick("restrictions") };
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * 保存后 re-GET 验证（任务书强制降级：控制器未重建 #1502 时 PUT/PATCH
 * 静默丢弃未知字段，200 但不落库）：
 * - 所存为空（清空）→ 回读空 / 无字段 = 相符；
 * - 所存非空 → 回读必须含等价规则（team/paths/mode 集合等价，序不敏感），
 *   否则 verified = false。
 * 注意：#1502 快照 GET /humans/{name} 不回显 workspaceAccess（write-only）
 * → 即便新控制器保存成功，回读仍可能为 null → verified = false（UI 按
 * 「版本不支持 / 未回显」告警展示，不断言保存一定失败——口径见任务报告）。
 */
export async function verifyWorkspaceAccessSaved(
  name: string,
  saved: WorkspaceAccess,
): Promise<WorkspaceAccessVerifyResult> {
  const cr = asRecord(
    await fetchControllerJson<unknown>(`humans/${encodeURIComponent(name)}`),
  );
  const current = extractWorkspaceAccess(cr);
  const verified = accessIsEmpty(saved)
    ? accessIsEmpty(current)
    : current !== null && rulesEqual(current, saved);
  return { verified, current };
}

// ────────────────────────────────────────────────────────────────────
// 团队清单（编辑器候选 + 默认访问派生）
// ────────────────────────────────────────────────────────────────────

export interface TeamsForAccessResult {
  /** 团队名候选（响应序，去重）。 */
  teams: string[];
  /** 团队名 → humanMembers 人名（TeamMemberSpec 对象 {name,...} 与纯字符串均接受）。 */
  membership: Record<string, string[]>;
  /** true = /teams 端点 404/403 → 调用方降级（团队下拉 → 自由输入；跳过不存在校验）。 */
  unavailable: boolean;
}

/**
 * 拉团队清单（GET /teams）：
 * - 响应 { teams: [...] }（TeamListResponse {teams,total}）或裸数组；
 *   团队名 = item.name（或 item.metadata.name 兜底）；
 * - humanMembers = TeamResponse flat 字段 []TeamMemberSpec{name,...}
 *   （server 8ca5ae881 起为对象；纯字符串形状兼容——前端 TeamForm 历史上
 *   用 string[]）；
 * - 404/403（旧控制器无端点 / 无权限）→ {teams:[], membership:{},
 *   unavailable:true}（不抛错——任务书降级项）。
 */
export async function fetchTeamsForAccess(): Promise<TeamsForAccessResult> {
  try {
    const body = await fetchControllerJson<unknown>("teams");
    const rec = asRecord(body);
    const list: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray(rec?.teams)
        ? (rec.teams as unknown[])
        : Array.isArray(rec?.items)
          ? (rec.items as unknown[])
          : [];
    const teams: string[] = [];
    const membership: Record<string, string[]> = {};
    for (const it of list) {
      const o = asRecord(it);
      if (!o) continue;
      const meta = asRecord(o.metadata);
      const name =
        typeof o.name === "string" && o.name !== ""
          ? o.name
          : typeof meta?.name === "string"
            ? (meta.name as string)
            : "";
      if (!name) continue;
      if (!teams.includes(name)) teams.push(name);
      const members: string[] = [];
      const hm = o.humanMembers;
      if (Array.isArray(hm)) {
        for (const m of hm) {
          if (typeof m === "string" && m !== "") members.push(m);
          else {
            const mo = asRecord(m);
            if (mo && typeof mo.name === "string" && mo.name !== "") members.push(mo.name);
          }
        }
      }
      if (members.length) membership[name] = members;
    }
    return { teams, membership, unavailable: false };
  } catch (e) {
    const st = httpErrorStatus(e);
    if (st === 404 || st === 403) return { teams: [], membership: {}, unavailable: true };
    throw e;
  }
}

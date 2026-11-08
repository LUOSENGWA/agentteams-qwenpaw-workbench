// WorkspaceAccessEditor.tsx — H2（#1502）：Human CR spec.workspaceAccess
// 受控编辑器（人员详情「工作区访问」卡）。
//
// 纯受控（value/onChange）：自身不拨号——团队候选（teams；null = /teams
// 端点不可用，降级为自由输入）与默认团队（defaultTeams = accessibleTeams
// ∪ humanMembers，只读展示）全由父组件传入；校验与父组件保存门同一来源
// （api/domains/workspaceAccess.validateAccess）。
//
// 结构（契约 #1502，见 api/domains/workspaceAccess.ts 头注）：
// - 默认访问（只读说明：成员对 files/** readwrite，HelpDot「为什么」；
//   不写字段）；
// - Grants（read | readwrite，raise only）/ Restrictions（none | read，
//   收窄默认；同路径 restriction 优先）；
// - 每条规则 = 团队（Select；候选空降级自由输入）+ 路径 chips（* / **
//   支持，Enter 添加，× 删除；humanName 在场时「浏览…」= WorkspacePathPicker
//   目录树多选生成规则路径）+ 模式（按列表限定的 Select）+ 删除；
// - 空列表 = 「未配置（继承默认）」；行内红字 = 该规则的结构化 issue。
//
// React/antd 走 window.QwenPaw.host（blob-URL 单文件构建约束，见 vite.config 守卫）。
import type * as ReactNS from "react";
import {
  type AccessIssue,
  type WorkspaceAccess,
  type WorkspaceAccessRule,
  validateAccess,
} from "../api/domains/workspaceAccess";
import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import HelpDot from "./HelpDot";
import WorkspacePathPicker from "./WorkspacePathPicker";
import { PICKER_MAX_PATHS, mergeRulePaths } from "./workspacePathPicker";
import { CloseIcon } from "./icons";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

const GRANT_MODES: WorkspaceAccessRule["mode"][] = ["read", "readwrite"];
const RESTRICTION_MODES: WorkspaceAccessRule["mode"][] = ["none", "read"];

function modeLabel(m: string, tr: TrFn): string {
  if (m === "read") return tr("只读");
  if (m === "readwrite") return tr("读写");
  if (m === "none") return tr("无权限");
  return m;
}

/** 结构化 issue → 行内红字文案（tr 映射；消息不进 api 层）。 */
function issueText(issue: AccessIssue, tr: TrFn): string {
  switch (issue.kind) {
    case "bad_path":
      return tr("路径非法：{p}", { p: issue.detail ?? "" });
    case "bad_mode":
      return tr("模式越界：{m}（此列表允许 {allowed}）", {
        m: issue.detail ?? "",
        allowed: issue.list === "grants" ? "read / readwrite" : "none / read",
      });
    case "dup_team":
      return tr("同一团队在列表中重复");
    case "unknown_team":
      return tr("团队不存在：{team}", { team: issue.detail ?? "" });
    case "empty_team":
      return tr("团队不可为空");
    case "no_paths":
      return tr("至少需要一条路径");
    case "too_many_rules":
      return tr("每列表至多 32 条规则（当前 {m}）", { m: issue.detail ?? "" });
    case "too_many_paths":
      return tr("每规则至多 16 条路径（当前 {m}）", { m: issue.detail ?? "" });
  }
}

/** 路径 chips（closable Tag + 输入框，Enter 添加；* / ** 支持）。
 *  humanName 在场时输入框右侧出「浏览…」（WorkspacePathPicker 目录树，
 *  多选 + 含子目录开关，生成候选路径）；无 humanName = 只手动输入。 */
function PathChips({
  paths,
  canEdit,
  tr,
  t,
  humanName,
  onChange,
}: {
  paths: string[];
  canEdit: boolean;
  tr: TrFn;
  t: ThemeColors;
  humanName?: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const atCap = paths.length >= PICKER_MAX_PATHS;
  const commit = () => {
    const p = draft.trim();
    if (!p) {
      setDraft("");
      return;
    }
    if (paths.includes(p)) {
      setDraft("");
      return;
    }
    if (atCap) {
      antd.message.warning(tr("每规则至多 16 条路径（当前 {m}）", { m: paths.length }));
      setDraft("");
      return;
    }
    onChange([...paths, p]);
    setDraft("");
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      {paths.map((p, i) => (
        <antd.Tag
          key={`${p}-${i}`}
          closable={canEdit}
          onClose={() => onChange(paths.filter((_, j) => j !== i))}
          style={{ margin: 0 }}
        >
          {p}
        </antd.Tag>
      ))}
      {canEdit ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <antd.Input
            value={draft}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
            onPressEnter={commit}
            onBlur={() => {
              if (draft.trim()) commit();
            }}
            placeholder={tr("添加路径（支持 * 和 **）")}
            style={{ width: 200 }}
            aria-label={tr("添加路径（支持 * 和 **）")}
          />
          {humanName ? (
            <antd.Button
              onClick={() => setPickerOpen(true)}
              disabled={atCap}
              title={
                atCap
                  ? tr("已达路径上限（16 条）")
                  : tr("从工作区目录树选择")
              }
              style={{ minHeight: 44, minWidth: 44, flexShrink: 0 }}
              aria-label={tr("浏览…")}
            >
              {tr("浏览…")}
            </antd.Button>
          ) : null}
        </div>
      ) : null}
      {canEdit && humanName ? (
        <WorkspacePathPicker
          open={pickerOpen}
          humanName={humanName}
          existing={paths}
          t={t}
          tr={tr}
          onClose={() => setPickerOpen(false)}
          onConfirm={(candidates) => {
            // 与手动输入同一落点：onChange 全量数组（去重 / 上限在纯函数里）。
            const merged = mergeRulePaths(paths, candidates);
            if (merged.added.length > 0) onChange(merged.paths);
            if (merged.capped) {
              antd.message.warning(
                tr("每规则至多 16 条路径（当前 {m}）", { m: merged.paths.length }),
              );
            }
          }}
        />
      ) : null}
    </div>
  );
}

/** 一条规则行（团队 + 模式 + 删除 / 路径 chips / 行内红字）。 */
function RuleRow({
  rule,
  list,
  teamOptions,
  canEdit,
  tr,
  t,
  humanName,
  errors,
  onChange,
  onRemove,
}: {
  rule: WorkspaceAccessRule;
  list: "grants" | "restrictions";
  /** null = /teams 不可用 → 自由输入。 */
  teamOptions: string[] | null;
  canEdit: boolean;
  tr: TrFn;
  t: ThemeColors;
  humanName?: string;
  errors: AccessIssue[];
  onChange: (next: WorkspaceAccessRule) => void;
  onRemove: () => void;
}) {
  const modeOptions = list === "grants" ? GRANT_MODES : RESTRICTION_MODES;
  return (
    <div
      style={{
        border: `1px dashed ${t.border}`,
        borderRadius: 6,
        padding: 8,
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {teamOptions ? (
          <antd.Select
            value={rule.team || undefined}
            disabled={!canEdit}
            showSearch
            allowClear
            placeholder={tr("团队")}
            options={teamOptions.map((nm) => ({ value: nm, label: nm }))}
            style={{ width: 170 }}
            onChange={(v: string | undefined) => onChange({ ...rule, team: v ?? "" })}
            aria-label={tr("团队")}
          />
        ) : (
          <antd.Input
            value={rule.team}
            disabled={!canEdit}
            placeholder={tr("团队名（自由输入）")}
            style={{ width: 170 }}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              onChange({ ...rule, team: e.target.value })
            }
            aria-label={tr("团队名（自由输入）")}
          />
        )}
        <antd.Select
          value={rule.mode}
          disabled={!canEdit}
          options={modeOptions.map((m) => ({ value: m, label: modeLabel(m, tr) }))}
          style={{ width: 110 }}
          onChange={(v: string) => onChange({ ...rule, mode: v as WorkspaceAccessRule["mode"] })}
          aria-label={tr("模式")}
        />
        <span style={{ flex: 1 }} />
        {canEdit ? (
          <span
            role="button"
            aria-label={tr("删除规则")}
            onClick={onRemove}
            style={{ cursor: "pointer", color: t.textSecondary, display: "inline-flex" }}
          >
            <CloseIcon size={14} />
          </span>
        ) : null}
      </div>
      <PathChips
        paths={rule.paths}
        canEdit={canEdit}
        tr={tr}
        t={t}
        humanName={humanName}
        onChange={(paths) => onChange({ ...rule, paths })}
      />
      {errors.length > 0 ? (
        <div style={{ display: "grid", gap: 1 }}>
          {errors.map((e, i) => (
            <span key={i} style={{ fontSize: 11, color: "#ff4d4f" }}>
              {issueText(e, tr)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 一个规则列表分区（标题 + 说明 + 规则行 + 添加按钮 + 列表级红字）。 */
function RuleListSection({
  title,
  hint,
  rules,
  list,
  teamOptions,
  canEdit,
  tr,
  t,
  humanName,
  listIssues,
  onRules,
}: {
  title: string;
  hint: string;
  rules: WorkspaceAccessRule[];
  list: "grants" | "restrictions";
  teamOptions: string[] | null;
  canEdit: boolean;
  tr: TrFn;
  t: ThemeColors;
  humanName?: string;
  /** 列表级 issue（index = -1，如超 32 条）。 */
  listIssues: AccessIssue[];
  onRules: (next: WorkspaceAccessRule[]) => void;
}) {
  const issues = validateAccess(
    { [list]: rules } as WorkspaceAccess,
    teamOptions,
  );
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: 10,
        display: "grid",
        gap: 8,
        background: t.cardBg,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: t.text, flexShrink: 0 }}>
          {title}
        </span>
        <span style={{ fontSize: 11, color: t.textSecondary, minWidth: 0 }}>{hint}</span>
      </div>
      {rules.length === 0 ? (
        <span
          style={{
            fontSize: 11,
            color: t.textSecondary,
            border: `1px dashed ${t.border}`,
            borderRadius: 6,
            padding: 8,
          }}
        >
          {tr("未配置（继承默认）")}
        </span>
      ) : (
        rules.map((rule, i) => (
          <RuleRow
            key={i}
            rule={rule}
            list={list}
            teamOptions={teamOptions}
            canEdit={canEdit}
            tr={tr}
            t={t}
            humanName={humanName}
            errors={issues.filter((x) => x.list === list && x.index === i)}
            onChange={(next) => onRules(rules.map((r, j) => (j === i ? next : r)))}
            onRemove={() => onRules(rules.filter((_, j) => j !== i))}
          />
        ))
      )}
      {listIssues.length > 0 ? (
        <div style={{ display: "grid", gap: 1 }}>
          {listIssues.map((x, i) => (
            <span key={i} style={{ fontSize: 11, color: "#ff4d4f" }}>
              {issueText(x, tr)}
            </span>
          ))}
        </div>
      ) : null}
      {canEdit ? (
        <antd.Button
          type="dashed"
          size="small"
          onClick={() =>
            onRules([
              ...rules,
              { team: "", paths: [], mode: list === "grants" ? "read" : "none" },
            ])
          }
        >
          {list === "grants" ? tr("添加授予规则") : tr("添加限制规则")}
        </antd.Button>
      ) : null}
    </div>
  );
}

export interface WorkspaceAccessEditorProps {
  value?: WorkspaceAccess | null;
  /** 默认团队（accessibleTeams ∪ humanMembers；只读展示）。 */
  defaultTeams?: string[] | null;
  /** /teams 团队名候选（null = 端点不可用 → 团队降级自由输入）。 */
  teams?: string[] | null;
  onChange: (next: WorkspaceAccess) => void;
  tr: TrFn;
  t: ThemeColors;
  /** 当前人员名（listFiles 的 humanName）；缺省 → 隐藏「浏览…」只手动输入。 */
  humanName?: string;
  /** 整体只读（非 admin）。 */
  readOnly?: boolean;
}

export default function WorkspaceAccessEditor(props: WorkspaceAccessEditorProps) {
  const { value, defaultTeams, teams, humanName, onChange, tr, t } = props;
  const readOnly = props.readOnly ?? false;
  const raw = value ?? null;
  const grants = raw?.grants ?? [];
  const restrictions = raw?.restrictions ?? [];

  const setList = (list: "grants" | "restrictions", rules: WorkspaceAccessRule[]) =>
    onChange({ ...(raw ?? {}), [list]: rules });

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {/* 默认访问（只读说明；成员派生，不写字段） */}
      <div
        style={{
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          padding: 10,
          display: "grid",
          gap: 6,
          background: t.cardBg,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: t.text, flexShrink: 0 }}>
            {tr("默认访问")}
          </span>
          <HelpDot
            title={tr(
              "成员（accessibleTeams ∪ humanMembers）默认对 files/** 读写；grants 仅为非成员团队加授，restrictions 可收窄默认范围（同路径 restriction 优先）。",
            )}
          />
          <antd.Tag style={{ margin: 0, flexShrink: 0 }}>{tr("读写 files/**")}</antd.Tag>
        </div>
        {defaultTeams && defaultTeams.length ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {defaultTeams.map((nm) => (
              <antd.Tag key={nm} color="blue" style={{ margin: 0 }}>
                {nm}
              </antd.Tag>
            ))}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("无默认团队（无成员关系且未配置 accessibleTeams）")}
          </span>
        )}
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("默认访问由成员关系派生，不写字段")}
        </span>
      </div>

      {/* Grants（raise only） */}
      <RuleListSection
        title={tr("授予规则")}
        hint={tr("为非成员团队加授 files/** 访问（只能加，不能低于默认）")}
        rules={grants}
        list="grants"
        teamOptions={teams ?? null}
        canEdit={!readOnly}
        tr={tr}
        t={t}
        humanName={humanName}
        listIssues={validateAccess(raw, teams ?? null).filter(
          (x) => x.list === "grants" && x.index === -1,
        )}
        onRules={(rules) => setList("grants", rules)}
      />

      {/* Restrictions（收窄默认；同路径 restriction 优先） */}
      <RuleListSection
        title={tr("限制规则")}
        hint={tr("收窄默认范围（none = 撤销 / read = 降级）")}
        rules={restrictions}
        list="restrictions"
        teamOptions={teams ?? null}
        canEdit={!readOnly}
        tr={tr}
        t={t}
        humanName={humanName}
        listIssues={validateAccess(raw, teams ?? null).filter(
          (x) => x.list === "restrictions" && x.index === -1,
        )}
        onRules={(rules) => setList("restrictions", rules)}
      />
    </div>
  );
}

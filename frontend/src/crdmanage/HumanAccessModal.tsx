// HumanAccessModal — 15.35 人员访问与权限（chips 单模态，人物优先）。
// 锚定选中 human：权限档位 Select + 可访问团队 chips + 可访问独立
// Worker chips（WeChat 式：closable Tag 展示 + Select 逐个添加）。
// 保存 = 一次 PUT 全字段（updateHumanAccess，同 updateHumanAccessibleTeams
// 端点/merge 语义）；404/405（旧 Controller 无 PUT /humans）→ 回落生成
// 「内嵌 apiserver merge-patch」命令（逻辑自退役的旧权限弹窗原样搬移）。
// 团队访问矩阵（旧矩阵组件/hook）随本模态退役——矩阵与
// 权限设置同改 accessibleTeams 的重叠一并消除。

import type * as ReactNS from "react";

import {
  httpErrorDetail,
  httpErrorStatus,
  updateHumanAccess,
  type HumanInfo,
  type TeamInfo,
  type WorkerInfo,
} from "../api";
import type { ThemeColors } from "../theme";
import { copyText } from "../util";
import type { TrFn } from "./types";
import LevelHelp from "./LevelHelp";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 独立 Worker = 全部 Worker − 任意团队成员。
 * team 成员名读 Team CRD 两源：workerNames（必填）∪ workerMembers[].name
 * （TeamResponse 透传）——两源并集，Controller 版本差异下任一字段在即
 * 判「已入团队」（grep 实锤字段名，不猜）。 */
export function computeStandaloneWorkers(
  teams: TeamInfo[],
  workers: WorkerInfo[],
): string[] {
  const inTeam = new Set<string>();
  for (const tm of teams) {
    for (const n of tm.workerNames ?? []) inTeam.add(n);
    for (const m of tm.workerMembers ?? []) inTeam.add(m.name);
  }
  return workers
    .map((w) => w.name)
    .filter((n) => !inTeam.has(n));
}

interface AccessDraft {
  permissionLevel: number;
  accessibleTeams: string[];
  accessibleWorkers: string[];
}

function toDraft(h: HumanInfo | null): AccessDraft {
  return {
    permissionLevel: h?.permissionLevel ?? 2,
    accessibleTeams: h?.accessibleTeams ?? [],
    accessibleWorkers: h?.accessibleWorkers ?? [],
  };
}

/** 内嵌 apiserver merge-patch 命令（单人全字段）——逻辑自退役的
 * 旧权限弹窗命令生成原样搬移（token.csv 第一列 +
 * 127.0.0.1:6443 + application/merge-patch+json）。 */
function buildMergePatchCmd(name: string, d: AccessDraft): string {
  const json = JSON.stringify({
    spec: {
      permissionLevel: d.permissionLevel,
      accessibleTeams: d.accessibleTeams,
      accessibleWorkers: d.accessibleWorkers,
    },
  });
  return [
    "# 在运行 agentteams-controller 的宿主机执行",
    "# 生效：reconcile 周期（约 5 分钟）内把此人拉入/移出团队房间",
    "docker exec agentteams-controller sh -c '",
    "TOKEN=$(cut -d, -f1 /data/agentteams-controller/pki/token.csv)",
    `curl -sk -X PATCH "https://127.0.0.1:6443/apis/agentteams.io/v1beta1/namespaces/default/humans/${name}" \\`,
    '  -H "Authorization: Bearer $TOKEN" \\',
    '  -H "Content-Type: application/merge-patch+json" \\',
    `  -d "${json.replace(/"/g, '\\"')}"`,
    "'",
  ].join("\n");
}

/** chips 选择器（15.35 WeChat 式）：closable antd.Tag 展示 + antd.Select
 * （showSearch，options 排除已选）逐个添加；Tag × 移除。 */
function ChipPicker({
  label,
  values,
  options,
  placeholder,
  empty,
  onAdd,
  onRemove,
  t,
}: {
  label: string;
  values: string[];
  options: string[];
  placeholder: string;
  /** 空值占位文案（未选任何项时）。 */
  empty: string;
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  t: ThemeColors;
}) {
  // 已加入的项不再进候选（防重复 chip）。
  const rest = options.filter((o) => !values.includes(o));
  return (
    <div>
      <div style={{ fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {values.length ? (
          values.map((v) => (
            <antd.Tag
              key={v}
              closable
              style={{ fontFamily: "ui-monospace, monospace" }}
              onClose={(e: ReactNS.MouseEvent) => {
                e.preventDefault();
                onRemove(v);
              }}
            >
              {v}
            </antd.Tag>
          ))
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>{empty}</span>
        )}
        {rest.length > 0 ? (
          <antd.Select
            size="small"
            showSearch
            style={{ width: 150 }}
            placeholder={`＋ ${placeholder}`}
            value={undefined}
            options={rest.map((n) => ({ value: n, label: n }))}
            onChange={(v: string) => onAdd(v)}
            optionFilterProp="label"
            popupMatchSelectWidth={false}
          />
        ) : null}
      </div>
    </div>
  );
}

interface HumanAccessModalProps {
  /** 锚定人员（null = 关闭）。 */
  human: HumanInfo | null;
  /** 全部团队名（团队 chips 候选）。 */
  teamNames: string[];
  /** 独立 Worker 列表（Worker chips 候选；computeStandaloneWorkers 计算）。 */
  standaloneWorkers: string[];
  tr: TrFn;
  t: ThemeColors;
  onClose: () => void;
  /** 保存成功后刷新管理数据。 */
  onSaved?: () => void;
}

export default function HumanAccessModal({
  human,
  teamNames,
  standaloneWorkers,
  tr,
  t,
  onClose,
  onSaved,
}: HumanAccessModalProps) {
  const [draft, setDraft] = React.useState<AccessDraft>(() => toDraft(human));
  const [cmd, setCmd] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  // 锚定人变化（换人/重开）→ 重置草稿与命令。
  React.useEffect(() => {
    setDraft(toDraft(human));
    setCmd("");
    setSaveMsg(null);
  }, [human?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const doSave = React.useCallback(async () => {
    if (!human || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await updateHumanAccess(human.name, {
        permissionLevel: draft.permissionLevel,
        accessibleTeams: draft.accessibleTeams,
        accessibleWorkers: draft.accessibleWorkers,
      });
      setSaveMsg({ kind: "ok", text: tr("已保存") });
      onSaved?.();
    } catch (e) {
      const st = httpErrorStatus(e);
      if (st === 404 || st === 405) {
        setCmd(buildMergePatchCmd(human.name, draft));
        setSaveMsg({
          kind: "err",
          text: tr(
            "当前 Controller 不支持一键保存（无 PUT /humans 端点）——已生成命令，请在 Controller 宿主机执行。",
          ),
        });
      } else {
        setSaveMsg({
          kind: "err",
          text: `${tr("保存失败")}: ${
            httpErrorDetail(e) || (st ? `HTTP ${st}` : tr("网络错误"))
          }`,
        });
      }
    } finally {
      setSaving(false);
    }
  }, [human, saving, draft, tr, onSaved]);

  const generateCmd = React.useCallback(() => {
    if (!human) return;
    setCmd(buildMergePatchCmd(human.name, draft));
  }, [human, draft]);

  const copyCmd = React.useCallback(() => {
    if (!cmd) return;
    copyText(cmd, (ok) => {
      if (ok) antd.message.success(tr("已复制"));
      else antd.message.warning(tr("复制失败——请手动全选复制"));
    });
  }, [cmd, tr]);

  if (!human) return null;

  return (
    <antd.Modal
      open
      title={`${tr("访问与权限")} · ${human.name}`}
      onCancel={onClose}
      width={560}
      style={{ maxWidth: "calc(100vw - 32px)" }}
      footer={
        <antd.Space>
          <antd.Button onClick={generateCmd} disabled={!!cmd}>
            {tr("生成命令")}
          </antd.Button>
          <antd.Button onClick={onClose}>{tr("关闭")}</antd.Button>
          <antd.Button
            type="primary"
            loading={saving}
            onClick={() => void doSave()}
          >
            {tr("保存")}
          </antd.Button>
        </antd.Space>
      }
    >
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr(
            "级别 / 可访问团队 / 可访问 Worker 一次保存；旧版 Controller（无 PUT /humans）自动回落「生成命令」。",
          )}
        </div>

        {/* 权限档位（15.36 D：label 精简为 L1/L2/L3 短档名，完整说明进
            LevelHelp ? tooltip；选项按档位 1/2/3 升序） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, width: 96, flexShrink: 0 }}>
            {tr("权限档位")}
          </span>
          <antd.Select
            style={{ width: 180 }}
            value={draft.permissionLevel}
            onChange={(v: number) =>
              setDraft((d) => ({ ...d, permissionLevel: v }))
            }
            options={[
              { value: 1, label: tr("L1 · 管理员") },
              { value: 2, label: tr("L2 · 团队成员") },
              { value: 3, label: tr("L3 · Worker") },
            ]}
          />
          <LevelHelp level={draft.permissionLevel} tr={tr} />
        </div>

        <ChipPicker
          label={tr("可访问团队（决定此人被拉入哪些团队房间）")}
          values={draft.accessibleTeams}
          options={teamNames}
          placeholder={tr("添加团队…")}
          empty={tr("未加入任何团队")}
          onAdd={(v) =>
            setDraft((d) => ({
              ...d,
              accessibleTeams: [...d.accessibleTeams, v],
            }))
          }
          onRemove={(v) =>
            setDraft((d) => ({
              ...d,
              accessibleTeams: d.accessibleTeams.filter((x) => x !== v),
            }))
          }
          t={t}
        />

        <ChipPicker
          label={tr("可访问 Worker（可选）")}
          values={draft.accessibleWorkers}
          options={standaloneWorkers}
          placeholder={tr("添加独立 Worker…")}
          empty={
            standaloneWorkers.length === 0
              ? tr("无独立 Worker（全部已入团队）")
              : tr("未关联 Worker（可选）")
          }
          onAdd={(v) =>
            setDraft((d) => ({
              ...d,
              accessibleWorkers: [...d.accessibleWorkers, v],
            }))
          }
          onRemove={(v) =>
            setDraft((d) => ({
              ...d,
              accessibleWorkers: d.accessibleWorkers.filter((x) => x !== v),
            }))
          }
          t={t}
        />

        {saveMsg ? (
          <div
            style={{
              fontSize: 12,
              color: saveMsg.kind === "ok" ? "#389e0d" : "#ff4d4f",
            }}
          >
            {saveMsg.text}
          </div>
        ) : null}

        {cmd ? (
          <>
            <div style={{ fontSize: 11, color: t.textSecondary }}>
              {tr(
                "在运行 Controller 的宿主机执行；空列表 = 清空。merge-patch 不改 status——初始密码不变。",
              )}
            </div>
            <antd.Input.TextArea
              rows={7}
              readOnly
              value={cmd}
              style={{ fontFamily: "monospace", fontSize: 11 }}
            />
            <antd.Button size="small" onClick={copyCmd}>
              {tr("复制命令")}
            </antd.Button>
          </>
        ) : null}
      </div>
    </antd.Modal>
  );
}

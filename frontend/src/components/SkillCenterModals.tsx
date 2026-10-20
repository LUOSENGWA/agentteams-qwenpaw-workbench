/** SkillCenter 子模块——自 SkillCenter.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import type { SkillDetail } from "./SkillCenterShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export function UploadSkillModal({
  open,
  mode,
  team,
  teams,
  name,
  desc,
  body,
  busy,
  onClose,
  onSubmit,
  onTeamChange,
  onFileChange,
  onNameChange,
  onDescChange,
  onBodyChange,
}: {
  open: boolean;
  mode: "zip" | "new";
  team: string;
  teams: string[];
  name: string;
  desc: string;
  body: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onTeamChange: (v: string) => void;
  onFileChange: (f: File | null) => void;
  onNameChange: (v: string) => void;
  onDescChange: (v: string) => void;
  onBodyChange: (v: string) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  return (
      <antd.Modal
        open={open}
        title={mode === "zip" ? tr("上传技能包（zip）") : tr("新建自定义技能")}
        onCancel={onClose}
        onOk={onSubmit}
        confirmLoading={busy}
        okText={tr("上传")}
        cancelText={tr("取消")}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12 }}>{tr("目标团队")}</span>
            <antd.Select
              size="small"
              style={{ minWidth: 200 }}
              value={team || undefined}
              onChange={onTeamChange}
              options={teams.map((t) => ({ value: t, label: t }))}
              placeholder={tr("选择团队")}
            />
          </div>
          {mode === "zip" ? (
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                onFileChange(e.target.files?.[0] || null)
              }
            />
          ) : (
            <>
              <antd.Input
                size="small"
                placeholder={tr("技能名（小写字母/数字/连字符）")}
                value={name}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  onNameChange(e.target.value)
                }
              />
              <antd.Input
                size="small"
                placeholder={tr("描述（可选）")}
                value={desc}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  onDescChange(e.target.value)
                }
              />
              <antd.Input.TextArea
                rows={7}
                placeholder={tr("SKILL.md 正文（指令内容）")}
                value={body}
                onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
                  onBodyChange(e.target.value)
                }
              />
            </>
          )}
          <div style={{ fontSize: 11.5, color: t.textSecondary }}>
            {tr("上传进入该团队技能层；L1 可任意团队，L2 限本团队。上传经 skillscan 扫描（截拦即报原因）。")}
          </div>
        </div>
      </antd.Modal>
  );
}

export function SkillDetailModal({
  detail,
  onClose,
}: {
  detail: SkillDetail | null;
  onClose: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  return (
      <antd.Modal
        title={detail ? detail.name : ""}
        open={Boolean(detail)}
        onCancel={onClose}
        footer={null}
        width="min(calc(100vw - 48px), 480px)"
        destroyOnClose
      >
        {detail ? (
          <div style={{ display: "grid", gap: 10, fontSize: 12.5 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <antd.Tag color={detail.source === "builtin" ? "blue" : "purple"}>
                {detail.source}
              </antd.Tag>
              {detail.version ? (
                <span style={{ color: t.textSecondary }}>
                  {tr("版本")} {detail.version}
                </span>
              ) : null}
              {detail.runtimes?.length ? (
                <span style={{ color: t.textSecondary }}>
                  {tr("运行时")} {detail.runtimes.join(", ")}
                </span>
              ) : null}
              {detail.channels?.length ? (
                <span style={{ color: t.textSecondary }}>
                  {tr("装载渠道")} {detail.channels.join(", ")}
                </span>
              ) : null}
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {tr("描述")}
              </div>
              <div style={{ lineHeight: 1.6, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
                {detail.description || tr("（无描述）")}
              </div>
            </div>
            {detail.agents?.length ? (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {tr("使用方")}（{detail.agents.length}）
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {detail.agents.map((a) => (
                    <antd.Tag key={a} style={{ marginInlineEnd: 0 }}>
                      {a}
                    </antd.Tag>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </antd.Modal>
  );
}

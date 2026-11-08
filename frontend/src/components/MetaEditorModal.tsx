// MetaEditorModal.tsx — 项目/任务 meta（meta.json）编辑弹窗（单一共享一套，
// project/task 两种 kind 复用；入口 = 项目详情头部 / 任务巡检 Drawer）。
//
// 契约（上游 project_handler.go / task_meta_commit.go，详见 api/domains/meta.ts）：
//   GET 200 = meta.json 原文（不重排）+ ETag；PUT 必带 If-Match（缺失 428 /
//   不匹配 409 conflict）；任务同 id 跨多团队 → 409 ambiguous_task，?team= 重试；
//   老控制器路由未部署 → 405（或 404）→ 关弹窗 + onUnsupported 报父，父隐藏入口
//   （静默，不报错）。
//
// 行为：
//   - 打开即 GET 原文（逐字）→ 等宽 TextArea；非法 JSON = 行内红字 + 禁止保存；
//     空对象 {} 合法（明确语义 = 清空 meta）。
//   - 保存 = PUT + If-Match；成功 → message「已保存」+ onSaved（调用方刷新数据）。
//   - 409 conflict → 提示后自动重读一次拿新 ETag（保留用户编辑文本，不覆盖），
//     用户确认后以新 If-Match 再保存。
//   - 409 ambiguous → 显示团队选择（?team=），选择/输入后重试。

import type * as ReactNS from "react";

import {
  classifyMetaError,
  fetchTeamsStructure,
  getProjectMeta,
  getTaskMeta,
  putProjectMeta,
  putTaskMeta,
  validateMetaJson,
  type MetaValidationError,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 校验错误码 → 行内红字文案（key 进 i18n 字典，动态 tr() 渲染）。 */
const VALIDATION_TEXT: Record<MetaValidationError, string> = {
  empty: "meta 不能为空（清空请用空对象 {}）",
  invalid_json: "不是合法 JSON，无法保存",
  not_object: "meta 必须是 JSON 对象（不接受数组/标量）",
};

export interface MetaEditorModalProps {
  open: boolean;
  kind: "project" | "task";
  /** 项目 id（WorkflowEvent.runId）或任务 id（DAG 节点 id）。 */
  id: string;
  /** 目标显示名（项目标题 / 任务短名）。 */
  title: string;
  /** 目标所属团队（WorkflowEvent.team_id）——任务 ?team= 消歧首选键。 */
  teamId?: string;
  onClose: () => void;
  /** GET/PUT 405/404（路由未部署）→ 父组件记「不支持」并隐藏入口（静默）。 */
  onUnsupported?: () => void;
  /** 保存成功 → 调用方刷新自己的数据。 */
  onSaved?: () => void;
  /** R13「备注」入口：载入完成后把焦点放到 JSON 文本区。 */
  focusOnOpen?: boolean;
}

type Phase = "loading" | "ready" | "ambiguous" | "error";

export default function MetaEditorModal(props: MetaEditorModalProps) {
  const { open, kind, id, title, teamId, onClose, onUnsupported, onSaved, focusOnOpen } =
    props;
  const tr = useT();
  const t = useThemeColors();
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [text, setText] = React.useState("");
  const [etag, setEtag] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // ambiguous 消歧：用户选择/输入的团队名（优先于 teamId prop）。
  const [team, setTeam] = React.useState("");
  const [teamOptions, setTeamOptions] = React.useState<{ value: string }[]>([]);
  const [teamListFailed, setTeamListFailed] = React.useState(false);
  // R13「备注」入口：ready 后聚焦 JSON 文本区（延迟到 Modal 挂载/动画完成）。
  const textAreaRef = React.useRef<{ focus: () => void } | null>(null);
  React.useEffect(() => {
    if (!open || !focusOnOpen || phase !== "ready") return;
    const timer = window.setTimeout(() => textAreaRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [open, focusOnOpen, phase]);

  // 任务端点的有效消歧键：用户输入 > 所属团队 > 无（裸 id）。
  const effTeam =
    kind === "task" ? team.trim() || teamId || undefined : undefined;

  // 团队候选（ambiguous 时才拨号；fetchTeamsStructure 自带 15s 缓存）。
  const loadTeams = React.useCallback(async () => {
    try {
      const res = await fetchTeamsStructure();
      const names = new Set<string>();
      for (const tm of res?.tree || []) {
        const n = String(tm.team_name || "").trim();
        if (n) names.add(n);
      }
      setTeamOptions([...names].map((value) => ({ value })));
      setTeamListFailed(names.size === 0);
    } catch {
      setTeamOptions([]);
      setTeamListFailed(true);
    }
  }, []);

  // keepText = 冲突自动重读（只换新 ETag，不覆盖用户编辑文本）。
  const load = React.useCallback(
    async (opts?: { keepText?: boolean }) => {
      setPhase("loading");
      setMsg(null);
      try {
        const res =
          kind === "project"
            ? await getProjectMeta(id)
            : await getTaskMeta(id, effTeam);
        if (!opts?.keepText) setText(res.text);
        setEtag(res.etag);
        setPhase("ready");
      } catch (e) {
        const why = classifyMetaError(e);
        if (why === "unsupported" || why === "not_found") {
          // 老控制器路由未部署（405）/ 项目已消失（404）→ 关弹窗 + 报父隐藏入口。
          onUnsupported?.();
          onClose();
          return;
        }
        if (why === "ambiguous") {
          setPhase("ambiguous");
          void loadTeams();
          return;
        }
        setPhase("error");
        setMsg({
          ok: false,
          text:
            why === "forbidden"
              ? tr("无权限读取 meta")
              : e instanceof Error
                ? e.message
                : tr("加载失败"),
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, id, effTeam, onUnsupported, onClose, tr, loadTeams],
  );

  // 打开 / 切换目标 → 重置全部状态并重新 GET（ETag 可能已变，必须新鲜读）。
  React.useEffect(() => {
    if (!open || !id) return;
    setText("");
    setEtag("");
    setTeam("");
    setMsg(null);
    setTeamOptions([]);
    setTeamListFailed(false);
    setSaving(false);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, id, teamId]);

  const validation = React.useMemo(() => validateMetaJson(text), [text]);

  const save = React.useCallback(async () => {
    if (phase !== "ready" || !validation.ok || !etag || saving) return;
    setSaving(true);
    setMsg(null);
    try {
      const res =
        kind === "project"
          ? await putProjectMeta(id, text, etag)
          : await putTaskMeta(id, text, etag, effTeam);
      setEtag(res.etag || etag);
      antd.message.success(tr("已保存"));
      onSaved?.();
      onClose();
    } catch (e) {
      const why = classifyMetaError(e);
      if (why === "unsupported" || why === "not_found") {
        onUnsupported?.();
        onClose();
        return;
      }
      if (why === "conflict") {
        // 409 conflict：自动重读一次拿新 ETag（保留用户编辑文本，不覆盖）。
        setMsg({ ok: false, text: tr("已被他人修改，已重新载入最新版本") });
        void load({ keepText: true });
        return;
      }
      if (why === "ambiguous") {
        setPhase("ambiguous");
        setMsg({ ok: false, text: tr("同一任务存在于多个团队，请选择团队后重试") });
        void loadTeams();
        return;
      }
      setMsg({
        ok: false,
        text: e instanceof Error ? e.message : tr("保存失败"),
      });
    } finally {
      setSaving(false);
    }
  }, [
    phase,
    validation.ok,
    etag,
    saving,
    kind,
    id,
    text,
    effTeam,
    tr,
    onSaved,
    onClose,
    onUnsupported,
    load,
    loadTeams,
  ]);

  const kindLabel = kind === "task" ? tr("任务 meta") : tr("项目 meta");

  return (
    <antd.Modal
      open={open}
      title={`${kindLabel} — ${title || id}`}
      okText={tr("保存")}
      cancelText={tr("关闭")}
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={() => onClose()}
      okButtonProps={{
        disabled: phase !== "ready" || !validation.ok || !etag,
      }}
      width={640}
    >
      <div style={{ display: "grid", gap: 8 }}>
        {phase === "loading" ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "32px 0",
            }}
          >
            <antd.Spin />
          </div>
        ) : null}
        {phase === "ambiguous" ? (
          <div style={{ display: "grid", gap: 8, fontSize: 12.5 }}>
            <div style={{ color: "#e5a50a" }}>
              {tr("同一任务存在于多个团队，请选择团队后重试")}
            </div>
            <antd.AutoComplete
              value={team}
              onChange={(v: string) => setTeam(v)}
              options={teamOptions}
              placeholder={tr("选择团队（或输入团队名）")}
              style={{ width: "100%" }}
              allowClear
            />
            {teamListFailed ? (
              <div style={{ fontSize: 11, color: t.textSecondary }}>
                {tr("团队列表不可用，也可手动输入团队名")}
              </div>
            ) : null}
            <div>
              <antd.Button
                size="small"
                type="primary"
                disabled={!team.trim()}
                onClick={() => void load()}
              >
                {tr("重试")}
              </antd.Button>
            </div>
          </div>
        ) : null}
        {phase === "error" ? (
          <div style={{ display: "grid", gap: 8, fontSize: 12.5 }}>
            <div style={{ color: "#e5484d" }}>{msg?.text}</div>
            <antd.Button size="small" onClick={() => void load()}>
              {tr("重试")}
            </antd.Button>
          </div>
        ) : null}
        {phase === "ready" ? (
          <>
            <antd.Input.TextArea
              ref={textAreaRef}
              value={text}
              onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
                setText(e.target.value)
              }
              placeholder={tr("meta.json 内容（JSON 对象；空对象 {} = 清空）")}
              autoSize={{ minRows: 10, maxRows: 18 }}
              style={{
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 12,
              }}
            />
            {!validation.ok ? (
              <div style={{ fontSize: 11.5, color: "#e5484d" }}>
                {tr(VALIDATION_TEXT[validation.error])}
              </div>
            ) : null}
            {!etag ? (
              <div style={{ fontSize: 11.5, color: "#e5a50a" }}>
                {tr("版本未就绪（无 ETag）——点「重新载入」后重试")}
              </div>
            ) : null}
            {msg ? (
              <div
                style={{
                  fontSize: 11.5,
                  color: msg.ok ? "#2e9e5b" : "#e5484d",
                }}
              >
                {msg.text}
              </div>
            ) : null}
          </>
        ) : null}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <antd.Button
            size="small"
            disabled={phase !== "ready" || saving}
            onClick={() => void load()}
          >
            {tr("重新载入")}
          </antd.Button>
          {etag ? (
            <span
              style={{
                fontSize: 11,
                color: t.textSecondary,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                overflowWrap: "anywhere",
              }}
            >
              ETag: {etag}
            </span>
          ) : null}
        </div>
      </div>
    </antd.Modal>
  );
}

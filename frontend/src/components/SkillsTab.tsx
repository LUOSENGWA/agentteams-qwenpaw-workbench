import type * as ReactNS from "react";
import {
  createSkill,
  deleteSkill,
  fetchSkills,
  getSkillDetail,
  refreshSkills,
  setSkillEnabled,
  uploadSkillZip,
  type SkillDetail,
  type SkillSpec,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import MdText from "./MdText";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

function RefreshIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 1024 1024"
      fill="currentColor"
      style={{ verticalAlign: "-1px" }}
    >
      <path d="M784 832H272V736h400l-80-80 64-64 168 168-168 168-64-64 80-80zM240 640 72 480l168-168 64 64-80 80h408V256h96v416H144v-96h96z" />
    </svg>
  );
}

/** 8/30 re18（真机反馈：「skills 的上传和管理也没有…开关和管理也没有
 *  （参考 QwenPaw）」）：宿主 Agent 技能管理 tab——复刻 QwenPaw 原生
 *  SkillPool 核心面（清单/开关/上传 zip/新建/详情/删除/重扫），全部
 *  host.fetch 零新后端（契约 src/qwenpaw/app/routers/skills.py）。
 *  范围=当前宿主 Agent（本机助手）；远端 Worker 技能只读展示在
 *  Worker 管理 tab（M33 D4），团队侧上传/应用=M33 D6（待上游 G3 PR）。 */
function SkillsTab() {
  const t = useThemeColors();
  const tr = useT();
  const [skills, setSkills] = React.useState<SkillSpec[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [detail, setDetail] = React.useState<{
    name: string;
    data: SkillDetail | null;
  } | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newContent, setNewContent] = React.useState("");
  const [newEnable, setNewEnable] = React.useState(true);

  const load = React.useCallback((silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    fetchSkills()
      .then(setSkills)
      .catch((e) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // 乐观更新开关；失败回滚。
  const doToggle = (s: SkillSpec, enable: boolean) => {
    setBusy(true);
    setSkills((m) =>
      m.map((x) => (x.name === s.name ? { ...x, enabled: enable } : x)),
    );
    setSkillEnabled(s.name, enable)
      .catch((e) => {
        setSkills((m) =>
          m.map((x) =>
            x.name === s.name ? { ...x, enabled: s.enabled } : x,
          ),
        );
        antd.message.error(
          tr("操作失败") + "：" + (e instanceof Error ? e.message : String(e)),
        );
      })
      .finally(() => setBusy(false));
  };

  // 仅已禁用技能可删（宿主 409 语义）。
  const doDelete = (name: string) => {
    deleteSkill(name)
      .then(() => {
        antd.message.success(tr("技能已删除"));
        setSkills((m) => m.filter((x) => x.name !== name));
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("409")) {
          antd.message.warning(tr("请先禁用技能再删除"));
        } else {
          antd.message.error(tr("操作失败") + "：" + msg);
        }
      });
  };

  const onUpload = (file: File) => {
    setBusy(true);
    uploadSkillZip(file, true)
      .then((r) => {
        antd.message.success(
          tr("上传成功（导入 {n} 个技能）", { n: r.count }),
        );
        if (r.conflicts && r.conflicts.length > 0) {
          antd.message.warning(tr("存在命名冲突，已按建议名导入"));
        }
        void load(true);
      })
      .catch((e) => {
        antd.message.error(
          tr("上传失败") + "：" + (e instanceof Error ? e.message : String(e)),
        );
      })
      .finally(() => setBusy(false));
  };

  const onCreate = () => {
    if (!newName.trim() || !newContent.trim()) {
      antd.message.warning(tr("技能名与 SKILL.md 内容均必填"));
      return;
    }
    setBusy(true);
    createSkill(newName.trim(), newContent, newEnable)
      .then((r) => {
        antd.message.success(tr("新建技能成功：{n}", { n: r.name }));
        setCreateOpen(false);
        setNewName("");
        setNewContent("");
        void load(true);
      })
      .catch((e) =>
        antd.message.error(
          tr("操作失败") + "：" + (e instanceof Error ? e.message : String(e)),
        ),
      )
      .finally(() => setBusy(false));
  };

  const onRescan = () => {
    setBusy(true);
    refreshSkills()
      .then(setSkills)
      .then(() => antd.message.success(tr("已重新扫描")))
      .catch((e) =>
        antd.message.error(
          tr("操作失败") + "：" + (e instanceof Error ? e.message : String(e)),
        ),
      )
      .finally(() => setBusy(false));
  };

  const openDetail = (name: string) => {
    setDetail({ name, data: null });
    getSkillDetail(name)
      .then((d) => setDetail({ name, data: d }))
      .catch((e) => {
        setDetail(null);
        antd.message.error(
          e instanceof Error ? e.message : String(e),
        );
      });
  };

  return (
    <div>
      <antd.Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={tr(
          "管理当前 QwenPaw 宿主 Agent（你正在对话的本机助手）的技能，改动即时生效",
        )}
        description={tr(
          "远端团队 Worker 技能只读展示见「Worker 管理」tab；团队侧技能上传/应用 = M33 功能线（待上游 PR）",
        )}
      />
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <antd.Button
          size="small"
          icon={<RefreshIcon />}
          onClick={() => void load()}
          loading={loading}
        >
          {tr("刷新")}
        </antd.Button>
        <antd.Button
          size="small"
          icon={<RefreshIcon />}
          onClick={onRescan}
          loading={busy}
        >
          {tr("重新扫描")}
        </antd.Button>
        <antd.Upload
          accept=".zip"
          showUploadList={false}
          beforeUpload={(f: File) => {
            void onUpload(f);
            return false;
          }}
        >
          <antd.Button size="small" loading={busy}>
            {tr("上传技能（zip）")}
          </antd.Button>
        </antd.Upload>
        <antd.Button
          size="small"
          type="primary"
          onClick={() => setCreateOpen(true)}
        >
          {tr("新建技能")}
        </antd.Button>
        <span style={{ fontSize: 11.5, color: t.textSecondary }}>
          {tr("共 {n} 个技能（{e} 个启用）", {
            n: skills.length,
            e: skills.filter((s) => s.enabled).length,
          })}
        </span>
      </div>
      {error ? (
        <antd.Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <antd.Spin spinning={loading}>
        {skills.length === 0 && !loading ? (
          <antd.Empty
            image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            description={tr("暂无技能（可上传 zip 或新建）")}
            style={{ margin: "24px 0" }}
          />
        ) : null}
        {skills.map((s) => (
          <antd.Card
            key={s.name}
            size="small"
            style={{ marginBottom: 8 }}
            title={
              <span style={{ fontSize: 13 }}>
                {s.emoji ? `${s.emoji} ` : ""}
                {s.name}
              </span>
            }
            extra={
              <antd.Switch
                size="small"
                checked={s.enabled}
                loading={busy}
                onChange={(v: boolean) => doToggle(s, v)}
              />
            }
          >
            <div
              style={{
                fontSize: 12,
                color: t.textSecondary,
                marginBottom: 6,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {s.description || tr("（无描述）")}
            </div>
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <antd.Tag style={{ margin: 0 }}>
                {s.source || "—"}
              </antd.Tag>
              {(s.tags || []).map((tag) => (
                <antd.Tag key={tag} color="orange" style={{ margin: 0 }}>
                  {tag}
                </antd.Tag>
              ))}
              {s.last_updated ? (
                <span style={{ fontSize: 11, color: t.textSecondary }}>
                  {s.last_updated}
                </span>
              ) : null}
              <span style={{ flex: 1 }} />
              <antd.Button size="small" onClick={() => openDetail(s.name)}>
                {tr("查看详情")}
              </antd.Button>
              <antd.Popconfirm
                title={tr("删除技能「{name}」？（仅已禁用可删）", {
                  name: s.name,
                })}
                okText={tr("删除")}
                cancelText={tr("取消")}
                onConfirm={() => doDelete(s.name)}
              >
                <antd.Button
                  size="small"
                  danger
                  disabled={s.enabled}
                  title={
                    s.enabled
                      ? tr("请先禁用技能再删除")
                      : undefined
                  }
                >
                  {tr("删除")}
                </antd.Button>
              </antd.Popconfirm>
            </div>
          </antd.Card>
        ))}
      </antd.Spin>

      <antd.Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={640}
        title={
          detail
            ? `${detail.data?.emoji ? detail.data.emoji + " " : ""}${detail.name}`
            : ""
        }
      >
        {detail?.data ? (
          <div>
            <antd.Descriptions
              column={1}
              size="small"
              bordered
              style={{ marginBottom: 12 }}
              items={[
                {
                  key: "source",
                  label: tr("来源"),
                  children:
                    detail.data.source ||
                    "—",
                },
                {
                  key: "installed_from",
                  label: tr("安装来源"),
                  children: detail.data.installed_from || "—",
                },
                {
                  key: "channels",
                  label: tr("适用通道"),
                  children:
                    (detail.data.channels || []).join("、") || "—",
                },
                {
                  key: "updated",
                  label: tr("更新时间"),
                  children: detail.data.last_updated || "—",
                },
              ]}
            />
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: t.textSecondary,
                marginBottom: 6,
              }}
            >
              {tr("SKILL.md")}
            </div>
            <div
              style={{
                border: `1px solid ${t.border}`,
                borderRadius: 8,
                padding: 12,
                maxHeight: 480,
                overflowY: "auto",
              }}
            >
              <MdText text={detail.data.content || "（空）"} />
            </div>
          </div>
        ) : (
          <antd.Spin />
        )}
      </antd.Drawer>

      <antd.Modal
        open={createOpen}
        title={tr("新建技能")}
        okText={tr("创建")}
        cancelText={tr("取消")}
        confirmLoading={busy}
        onOk={onCreate}
        onCancel={() => setCreateOpen(false)}
        width={680}
      >
        <antd.Input
          value={newName}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            setNewName(e.target.value)}
          placeholder={tr("技能名（= 目录名，小写字母/数字/连字符）")}
          style={{ marginBottom: 8 }}
        />
        <antd.Input.TextArea
          value={newContent}
          onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
            setNewContent(e.target.value)}
          rows={12}
          placeholder={tr(
            "SKILL.md 全文（YAML frontmatter + 正文）",
          )}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
        <antd.Checkbox
          checked={newEnable}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            setNewEnable(e.target.checked)}
          style={{ marginTop: 8, display: "inline-block" }}
        >
          {tr("创建后立即启用")}
        </antd.Checkbox>
      </antd.Modal>
    </div>
  );
}

export default SkillsTab;

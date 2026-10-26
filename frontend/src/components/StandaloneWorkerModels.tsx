/**
 * 未分组（standalone）Worker 模型编辑弹窗。
 *
 * 背景：模型编辑原先只存在于「团队配置」弹窗（CrdCfgModal）。后端把
 * 无 team 的 Worker 归入伪团队「未分组」（teams_api.py），而该伪团队
 * 不是真实 Team CR → 拓扑齿轮 openConfig("未分组") 在 CRD 团队列表里
 * 必查不到 → 弹「团队数据未加载或团队不存在」，未分组 Worker 无路改模型。
 *
 * 本弹窗直接列 admin.workers 里 team 为空的 Worker，逐个改 model。
 * 写路径 = PUT /workers/{name} 只传 {model}（Controller 合并语义：
 * 只应用非空字段，provider 等其它字段不动；留空=跟随集群默认）。
 */
import type * as ReactNS from "react";

import { updateWorkerModel } from "../api";
import type { AdminData } from "../api";
import {
  modelVerdictText,
  useModelUnionOptions,
  validateModelValue,
} from "../modelUnion";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export function StandaloneWorkerModels({
  workers,
  open,
  onClose,
  onRefreshAdmin,
}: {
  workers: AdminData["workers"];
  open: boolean;
  onClose: () => void;
  onRefreshAdmin?: (silent?: boolean) => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  // 无 team = 未分组（与后端 teams_api.py 的分组口径一致：w.team 空）。
  const standalone = React.useMemo(
    () => workers.filter((w) => !(w.team || "").trim()),
    [workers],
  );
  const usedModels = React.useMemo(
    () => workers.map((w) => w.model || ""),
    [workers],
  );
  const union = useModelUnionOptions(usedModels, tr);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState<string | null>(null);

  // 每次打开复位草稿（不跨会话残留）。
  React.useEffect(() => {
    if (open) setDrafts({});
  }, [open]);

  const save = React.useCallback(
    async (name: string, value: string) => {
      const verdict = validateModelValue(value, union.candidates);
      if (verdict.level === "error") {
        antd.message.error(
          modelVerdictText(tr, verdict, value, union.candidates),
        );
        return;
      }
      setSaving(name);
      try {
        await updateWorkerModel(name, value.trim());
        antd.message.success(
          verdict.level === "warn"
            ? tr("已保存（提示：{t}）", {
                t: modelVerdictText(tr, verdict, value, union.candidates),
              })
            : tr("模型已保存（重启 Worker 后生效）"),
        );
        setDrafts((p) => {
          const n = { ...p };
          delete n[name];
          return n;
        });
        onRefreshAdmin?.(true);
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
      } finally {
        setSaving(null);
      }
    },
    [union.candidates, onRefreshAdmin, tr],
  );

  return (
    <antd.Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={620}
      title={tr("未分组 Worker 模型（独立 Worker）")}
      destroyOnClose
    >
      {standalone.length === 0 ? (
        <antd.Empty
          image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
          description={tr("没有未分组的 Worker")}
        />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {standalone.map((w) => {
            const draft = drafts[w.name] ?? w.model ?? "";
            const dirty = draft !== (w.model || "");
            return (
              <div
                key={w.name}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <span
                  style={{
                    minWidth: 140,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={w.name}
                >
                  {w.name}
                </span>
                <antd.AutoComplete
                  size="small"
                  style={{ flex: 1 }}
                  value={draft}
                  options={union.options}
                  allowClear
                  placeholder={tr("留空=跟随集群默认")}
                  onChange={(val: string) =>
                    setDrafts((p) => ({ ...p, [w.name]: val || "" }))
                  }
                />
                {dirty ? (
                  <antd.Button
                    size="small"
                    type="primary"
                    loading={saving === w.name}
                    onClick={() => void save(w.name, draft)}
                  >
                    {tr("保存")}
                  </antd.Button>
                ) : null}
              </div>
            );
          })}
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {tr(
              "只修改 model（PUT 合并语义：provider 等其它字段不动；留空=跟随集群默认）。",
            )}
          </div>
        </div>
      )}
    </antd.Modal>
  );
}

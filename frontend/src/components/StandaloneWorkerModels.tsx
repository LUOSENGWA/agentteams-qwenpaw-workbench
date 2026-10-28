/**
 * 未分组（standalone）Worker 模型编辑弹窗。
 *
 * 背景：模型编辑原先只存在于「团队配置」弹窗（CrdCfgModal）。后端把
 * 无 team 的 Worker 归入伪团队「未分组」（teams_api.py），而该伪团队
 * 不是真实 Team CR → 拓扑齿轮 openConfig("未分组") 在 CRD 团队列表里
 * 必查不到 → 弹「团队数据未加载或团队不存在」，未分组 Worker 无路改模型。
 *
 * 本弹窗直接列 admin.workers 里 team 为空的 Worker，逐个改 model +
 * modelProvider。写路径 = PUT /workers/{name}（Controller 合并语义）：
 * 只把**改动项**放进 body，provider 等其它字段不动。
 *
 * 为什么必须带 provider：多 Higress Provider 部署下，Worker 的 model 只是
 * 请求 alias，真正转发由 modelProvider（APIG Model API 名）决定。只改
 * model 不改 provider = 仍走旧 provider（用户「选了没用」的根因）。选
 * configured alias 时自动回填 binding.providerName；也可手动选 Provider。
 */
import type * as ReactNS from "react";

import { updateWorkerModel } from "../api";
import type { AdminData } from "../api";
import {
  modelVerdictText,
  providerForModel,
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
  const [provDrafts, setProvDrafts] = React.useState<Record<string, string>>(
    {},
  );
  const [saving, setSaving] = React.useState<string | null>(null);

  // 每次打开复位草稿（不跨会话残留）。
  React.useEffect(() => {
    if (open) {
      setDrafts({});
      setProvDrafts({});
    }
  }, [open]);

  const save = React.useCallback(
    async (name: string, value: string, provider: string) => {
      const verdict = validateModelValue(value, union.candidates);
      if (verdict.level === "error") {
        antd.message.error(
          modelVerdictText(tr, verdict, value, union.candidates),
        );
        return;
      }
      setSaving(name);
      try {
        const target = standalone.find((w) => w.name === name);
        // 当前 provider：Controller 值优先；旧 Controller 不返回 modelProvider
        // 时用 alias 的 binding.providerName 推导（与展示同一基线）。
        const current =
          target?.modelProvider ||
          providerForModel(union.gatewayOptions, target?.model || "");
        // 合并语义：provider 只在改动时下发（undefined = 不改）。
        const providerArg =
          provider.trim() !== current ? provider.trim() : undefined;
        await updateWorkerModel(name, value.trim(), providerArg);
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
        setProvDrafts((p) => {
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
    [standalone, union.candidates, union.gatewayOptions, onRefreshAdmin, tr],
  );

  return (
    <antd.Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={680}
      title={tr("未分组 Worker 模型（独立 Worker）")}
      destroyOnClose
    >
      {standalone.length === 0 ? (
        <antd.Empty
          image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
          description={tr("没有未分组的 Worker")}
        />
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {standalone.map((w) => {
            const draft = drafts[w.name] ?? w.model ?? "";
            // 当前 provider 基线：Controller 的 modelProvider 优先；旧
            // Controller 不返回它时，用 alias 的 binding.providerName 推导
            // ——与 model 一样预填现值（不是恒空）。
            const baselineProv =
              w.modelProvider ||
              providerForModel(union.gatewayOptions, w.model || "");
            const prov = provDrafts[w.name] ?? baselineProv;
            const dirty =
              draft !== (w.model || "") || prov !== baselineProv;
            return (
              <div
                key={w.name}
                style={{
                  display: "grid",
                  gap: 6,
                  border: `1px dashed ${t.border}`,
                  borderRadius: 8,
                  padding: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
                    placeholder={tr("模型 alias（留空=跟随集群默认）")}
                    onChange={(val: string) => {
                      setDrafts((p) => ({ ...p, [w.name]: val || "" }));
                      // configured alias → 自动回填其 binding.providerName。
                      const auto = providerForModel(
                        union.gatewayOptions,
                        val || "",
                      );
                      if (auto) {
                        setProvDrafts((p) => ({ ...p, [w.name]: auto }));
                      }
                    }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      minWidth: 140,
                      fontSize: 12,
                      color: t.textSecondary,
                    }}
                  >
                    {tr("Provider")}
                  </span>
                  <antd.AutoComplete
                    size="small"
                    style={{ flex: 1 }}
                    value={prov}
                    options={union.providers.map((p) => ({
                      value: p.name,
                    }))}
                    allowClear
                    placeholder={tr("留空=跟随默认（Higress Provider 名）")}
                    onChange={(val: string) =>
                      setProvDrafts((p) => ({ ...p, [w.name]: val || "" }))
                    }
                  />
                  {dirty ? (
                    <antd.Button
                      size="small"
                      type="primary"
                      loading={saving === w.name}
                      onClick={() => void save(w.name, draft, prov)}
                    >
                      {tr("保存")}
                    </antd.Button>
                  ) : null}
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {tr(
              "只改 model + Provider（PUT 合并语义：仅改动项下发，其它字段不动；留空=跟随集群默认）。选 Higress configured alias 会自动回填对应 Provider。",
            )}
          </div>
        </div>
      )}
    </antd.Modal>
  );
}

/**
 * QuotaEditDialog.tsx — 配额编辑弹窗（16.137 抽出共享实现，文件管理 /
 * 人员管理同一份 UI 与语义）。
 *
 * 迁移来源与口径（逐字保留行为）：
 * - 文件管理侧原实现 = files/FileOpsDialogs 的 QuotaEditDialog（十进制
 *   MB/GB + 文件数 + 当前已用；保存 setQuota({bytes, files})）；
 * - 人员管理侧原实现 = PeopleSection 内联 Modal（同表单 + 「清除配额」）——
 *   两份 UI 合并到本文件，FileOpsDialogs 保留 re-export（外部面不变）。
 *
 * 语义：
 * - 单值一律走 quotaEdit 纯映射（quotaToForm / quotaFormValid /
 *   quotaFormToPayload / quotaExactText / formatQuotaValue）；
 * - 保存 payload = {bytes: number|null, files: number|null}：null = 不限、
 *   0 = 零额度；清除 = setQuota(humanName, null)（旧单值形态）；
 * - 403 文案走 hfErrorText（「无权限」），不预判角色；
 * - 保存 / 清除成功 → onSaved()（调用方各自刷新：文件区 reload、人员区
 *   refreshQuota），然后关闭；
 * - 打开时按最新 quota 回显（调用方打开前已重取）。
 */
import type * as ReactNS from "react";

import { setQuota } from "../../api";
import type { ThemeColors } from "../../theme";
import DialogShell from "./DialogShell";
import { hfErrorText, type Tr } from "./hfError";
import {
  formatQuotaValue,
  quotaExactText,
  quotaFormToPayload,
  quotaFormValid,
  quotaInputNumber,
  quotaToForm,
  type QuotaUnit,
  type QuotaView,
} from "./quotaEdit";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface QuotaEditDialogProps {
  open: boolean;
  humanName: string;
  /** 当前配额（getQuota 响应；null = 未取到 → 空表单）。 */
  quota: QuotaView | null;
  t: ThemeColors;
  tr: Tr;
  onClose: () => void;
  /** 保存 / 清除成功（调用方刷新各自数据源）。 */
  onSaved: () => void;
}

export function QuotaEditDialog({
  open,
  humanName,
  quota,
  t,
  tr,
  onClose,
  onSaved,
}: QuotaEditDialogProps): ReactNS.ReactElement | null {
  const init = React.useMemo(() => quotaToForm(quota), [quota]);
  const [value, setValue] = React.useState<number | null>(init.value);
  const [unit, setUnit] = React.useState<QuotaUnit>(init.unit);
  const [files, setFiles] = React.useState<number | null>(init.files);
  const [busy, setBusy] = React.useState(false);

  // 每次打开按最新 getQuota 回显（quota 在打开前刚刷新过）。
  React.useEffect(() => {
    if (!open) return;
    const next = quotaToForm(quota);
    setValue(next.value);
    setUnit(next.unit);
    setFiles(next.files);
  }, [open, quota]);

  if (!open) return null;

  const exact = quotaExactText(value, unit);
  const save = async (): Promise<void> => {
    const form = { value, unit, files };
    if (!quotaFormValid(form)) {
      antd.message.warning(tr("请输入有效配额"));
      return;
    }
    setBusy(true);
    try {
      await setQuota(humanName, quotaFormToPayload(form));
      antd.message.success(tr("已保存"));
      onSaved();
      onClose();
    } catch (e) {
      antd.message.error(hfErrorText(e, tr));
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    antd.Modal.confirm({
      title: tr("清除配额？"),
      content: tr("清除后该人员文件存储无限制。"),
      okText: tr("清除配额"),
      cancelText: tr("取消"),
      onOk: async () => {
        try {
          await setQuota(humanName, null);
          antd.message.success(tr("已保存"));
          onSaved();
          onClose();
        } catch (e) {
          antd.message.error(hfErrorText(e, tr));
        }
      },
    });
  };

  return (
    <DialogShell
      open={open}
      title={tr("编辑配额")}
      subtitle={tr("十进制：1 MB = 1,000,000 bytes，1 GB = 1,000,000,000 bytes")}
      width={560}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={null}
    >
      <div style={{ display: "grid", gap: 12, padding: "6px 0" }}>
        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, color: t.textSecondary }}>{tr("容量")}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <antd.InputNumber
              value={value}
              min={0}
              step={0.1}
              disabled={busy}
              style={{ flex: "1 1 auto" }}
              onChange={(v: unknown) => setValue(quotaInputNumber(v))}
              aria-label={tr("容量")}
            />
            <antd.Select
              value={unit}
              disabled={busy}
              style={{ width: 96 }}
              onChange={(v: string) => setUnit(v === "GB" ? "GB" : "MB")}
              options={[
                { value: "MB", label: "MB" },
                { value: "GB", label: "GB" },
              ]}
              aria-label={tr("单位")}
            />
          </div>
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {exact || tr("留空 = 不限；0 = 零额度")}
          </span>
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, color: t.textSecondary }}>{tr("文件数")}</span>
          <antd.InputNumber
            value={files}
            min={0}
            precision={0}
            disabled={busy}
            onChange={(v: unknown) => setFiles(quotaInputNumber(v))}
            aria-label={tr("文件数")}
          />
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {files === null ? tr("留空 = 不限；0 = 零额度") : tr("{n} 个文件", { n: files })}
          </span>
        </div>
        {quota ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("当前已用 {a}", { a: formatQuotaValue(quota.usedBytes) })}
          </span>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <antd.Button danger size="small" disabled={busy} onClick={clear}>
            {tr("清除配额")}
          </antd.Button>
          <span style={{ flex: 1 }} />
          <antd.Button onClick={onClose} disabled={busy}>
            {tr("取消")}
          </antd.Button>
          <antd.Button type="primary" loading={busy} onClick={() => void save()}>
            {tr("保存")}
          </antd.Button>
        </div>
      </div>
    </DialogShell>
  );
}

export default QuotaEditDialog;

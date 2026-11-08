/**
 * quotaEdit.ts — 配额编辑表单的纯映射（无 React / window 依赖）。
 *
 * 单位口径（任务书硬约束）：**十进制** —— 1 MB = 1,000,000 bytes，
 * 1 GB = 1,000,000,000 bytes（不是 MiB/GiB，不乘 1024）。
 *
 * 语义：
 *   - 容量 / 文件数留空（null）= 不限（API 传 null）；
 *   - 输入 0 = 零额度（API 传 0，不是不限）；
 *   - 现有值回显按最大适用单位（≥1 GB → GB，否则 MB），保留 1 位小数；
 *   - 展示层（配额条 / 文案）用 formatQuotaValue：≥1 GB → GB、≥1 MB → MB、
 *     <1 MB → 原 bytes（未知旧值不硬换算）。
 * files 维为前向兼容字段：老 Controller 只认 quotaBytes，未知字段被忽略；
 * GET /quota 无 quotaFiles 时表单留空 = 不限。
 */

/** 容量单位（任务书只允许 MB / GB）。 */
export type QuotaUnit = "MB" | "GB";

/** 十进制换算基数（1 MB = 10^6，1 GB = 10^9）。 */
export const QUOTA_UNIT_BYTES: Record<QuotaUnit, number> = {
  MB: 1_000_000,
  GB: 1_000_000_000,
};

/** 配额表单值（null = 留空 = 不限；0 = 零额度）。 */
export interface QuotaForm {
  /** 容量数值（按 unit 换算）。 */
  value: number | null;
  unit: QuotaUnit;
  /** 文件数（整数）。 */
  files: number | null;
}

export interface QuotaLike {
  quotaBytes: number | null;
  quotaFiles?: number | null;
}

/** 共享配额视图（QuotaEditDialog 的入参形态）：文件区 getQuota 与人员详情
 *  getQuota 返回同一 QuotaResponse（usedBytes + quotaBytes + quotaFiles?），
 *  两处直接按本类型传入，避免字段名分叉。null = 未取到（表单空态）。 */
export interface QuotaView extends QuotaLike {
  usedBytes: number;
}

/** InputNumber 的 onChange 值归一：非有限数 → null；其余原样（0 保留 =
 *  零额度；负数由 quotaFormValid 判非法）。 */
export function quotaInputNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

/** 表单是否合法：空或 ≥0 的有限数（文件数还须为整数）。 */
export function quotaFormValid(form: QuotaForm): boolean {
  const capOk =
    form.value === null || (Number.isFinite(form.value) && form.value >= 0);
  const filesOk =
    form.files === null ||
    (Number.isFinite(form.files) && form.files >= 0 && Number.isInteger(form.files));
  return capOk && filesOk;
}

/** 容量数值 + 单位 → 字节（十进制；null → null；0 → 0；四舍五入到整数）。 */
export function quotaValueToBytes(
  value: number | null,
  unit: QuotaUnit = "MB",
): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * QUOTA_UNIT_BYTES[unit]);
}

/** 文件数 → 整数（null → null；0 → 0；正数向下取整）。 */
export function quotaFilesValue(files: number | null): number | null {
  if (files === null || !Number.isFinite(files) || files < 0) return null;
  return Math.floor(files);
}

/** 数值格式：整数不带小数，非整数保留 1 位（800 → "800"，1.5 → "1.5"）。 */
export function fmtQuotaNumber(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const rounded = Math.round(v * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 字节 → 表单预填（最大适用单位；≤0 / null / 非数 → null = 留空）。
 *  例：1,500,000,000 → {value:1.5, unit:"GB"}；800,000,000 → {value:800,
 *  unit:"MB"}；1,048,576（旧二进制值）→ {value:1.048576, unit:"MB"}。
 *  小于 1 MB 的值按 MB 保留 6 位小数（避免把旧小额度回显成 0）。 */
export function bytesToQuotaInput(bytes: number | null | undefined): {
  value: number | null;
  unit: QuotaUnit;
} {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return { value: null, unit: "MB" };
  }
  // 0 = 零额度（不是「不限」）：回显 0，不能落成空值。
  if (bytes === 0) return { value: 0, unit: "MB" };
  if (bytes >= QUOTA_UNIT_BYTES.GB) {
    return { value: Math.round((bytes / QUOTA_UNIT_BYTES.GB) * 10) / 10, unit: "GB" };
  }
  if (bytes >= QUOTA_UNIT_BYTES.MB) {
    return { value: Math.round((bytes / QUOTA_UNIT_BYTES.MB) * 10) / 10, unit: "MB" };
  }
  return { value: Math.round((bytes / QUOTA_UNIT_BYTES.MB) * 1e6) / 1e6, unit: "MB" };
}

/** 展示层（配额条 / 文案）：≥1 GB → GB、≥1 MB → MB、<1 MB → 原 bytes；
 *  null / 非数 → "—"。保留 1 位小数（整数不带 .0）。 */
export function formatQuotaValue(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= QUOTA_UNIT_BYTES.GB) {
    return `${fmtQuotaNumber(bytes / QUOTA_UNIT_BYTES.GB)} GB`;
  }
  if (bytes >= QUOTA_UNIT_BYTES.MB) {
    return `${fmtQuotaNumber(bytes / QUOTA_UNIT_BYTES.MB)} MB`;
  }
  return `${Math.round(bytes)} B`;
}

/** 千分位分组（不依赖 locale，纯函数可测）。 */
function groupThousands(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  const sign = n < 0 ? "-" : "";
  return sign + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 实时换算提示文案（任务书示例：`1.5 GB = 1,500,000,000 bytes`）。
 *  留空 → ""（由调用方显示「不限」）。 */
export function quotaExactText(value: number | null, unit: QuotaUnit): string {
  const bytes = quotaValueToBytes(value, unit);
  if (bytes === null || value === null) return "";
  return `${fmtQuotaNumber(value)} ${unit} = ${groupThousands(bytes)} bytes`;
}

/** API 配额 → 表单预填（quotaFiles 缺省 → null）。 */
export function quotaToForm(q: QuotaLike | null | undefined): QuotaForm {
  if (!q) return { value: null, unit: "MB", files: null };
  const hit = bytesToQuotaInput(q.quotaBytes);
  return {
    value: hit.value,
    unit: hit.unit,
    files:
      typeof q.quotaFiles === "number" && Number.isFinite(q.quotaFiles) && q.quotaFiles >= 0
        ? Math.floor(q.quotaFiles)
        : null,
  };
}

/** 表单 → setQuota 入参（两个维度都显式带上；null = 不限，0 = 零额度）。 */
export function quotaFormToPayload(form: QuotaForm): {
  bytes: number | null;
  files: number | null;
} {
  return {
    bytes: quotaValueToBytes(form.value, form.unit),
    files: quotaFilesValue(form.files),
  };
}

/** 「编辑配额」入口可见性：仅 admin（RBAC level 判定结果传入）。
 *  非 admin 隐藏（任务书）；纯函数便于单测。 */
export function canEditQuota(canAdmin: boolean): boolean {
  return canAdmin === true;
}

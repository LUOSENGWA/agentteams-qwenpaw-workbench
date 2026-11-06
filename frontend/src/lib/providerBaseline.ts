// providerBaseline.ts — Worker modelProvider 基线判定（#1477，16.61 起
// worker 列表走 fields=spec + fields=status 两道投影，均不含 modelProvider，
// 只有全量响应才带；旧代码用列表行做写盘基线 → 空/靠猜 → 误清 provider）。
//
// 基线优先级（resolveProviderBaseline）：
//   detail modelProvider（写前读 detail）> list modelProvider（两者 trusted=true，
//   均为 Controller 事实）> alias 回填（providerForModel 从模型 alias 反查的
//   binding，只是推导不是事实，trusted=false）> 无（value=""，trusted=false）。
//
// 写盘判定（providerForWrite）：
//   - 用户显式选了 provider（非空）→ 下发用户值（无论基线是否可信——
//     显式选择即意图）；
//   - 用户未改（字段保留基线预填）+ 基线可信 → 下发基线现值（与旧行为一致）；
//   - 用户未改 + 基线不可信 → undefined = 请求体不带 modelProvider，
//     控制器 merge 语义保持现值（避免 alias 猜测/空基线清空现存
//     deepseek / qwen3.6-local 等 provider）。
export interface ProviderBaseline {
  /** 基线值（""= 三个来源皆无值）。 */
  value: string;
  /** 是否 Controller 事实（detail/list 成功值=true；alias 回填/空=false）。 */
  trusted: boolean;
}

export function resolveProviderBaseline(
  detailProv: string | undefined,
  listProv: string | undefined,
  aliasProv: string | undefined,
): ProviderBaseline {
  const d = (detailProv ?? "").trim();
  if (d) return { value: d, trusted: true };
  const l = (listProv ?? "").trim();
  if (l) return { value: l, trusted: true };
  const a = (aliasProv ?? "").trim();
  if (a) return { value: a, trusted: false };
  return { value: "", trusted: false };
}

/**
 * 保存时下发什么 modelProvider。
 * @param baseline resolveProviderBaseline 的结果
 * @param userEdited 用户在弹窗里显式选择的 provider 值；
 *   undefined/""（含纯空白）= 未改动（字段保留基线预填）
 * @returns 下发的 modelProvider；undefined = 不下发（保持控制器现值）
 */
export function providerForWrite(
  baseline: ProviderBaseline,
  userEdited: string | undefined,
): string | undefined {
  const u = (userEdited ?? "").trim();
  if (u) return u;
  return baseline.trusted ? baseline.value : undefined;
}

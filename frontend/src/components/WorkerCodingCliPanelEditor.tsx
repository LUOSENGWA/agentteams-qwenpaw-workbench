import type * as ReactNS from "react";

import type { SettingsObject, SettingsValue } from "../api";
import {
  SECTION_LABELS,
  isRedacted,
  type FieldSpec,
} from "../codingCliPresets";
import { useLang, useT } from "../i18n";
import { useThemeColors } from "../theme";
import { modelVerdictText, validateModelValue } from "../modelUnion";
import {
  assignPath,
  buildSecretPatch,
  deepCopySettings,
  diffSettings,
  getAtPath,
  modelNameOf,
  type ModelOptions,
} from "./WorkerCodingCliPanelShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 15.34：分区卡默认展开判定——分区有内容（文件值 / seed 预填）=展开，
 * 纯目录空分区（文件未设置）=收起。draft 是 base/seed 深拷贝，两态同源。 */
function hasContentValue(v: SettingsValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== "object") return true;
  if (Array.isArray(v)) return v.length > 0;
  return Object.keys(v).length > 0;
}

/** 15.34：分区卡头「当前值摘要」——收集叶子 k=v（预填当前值，收起也可见）：
 * redacted → ••• / 数组 → [N] / 标量原样 / skipKey 跳过（model.name 由专行管）。
 * 返回 [[相对路径, 显示值]]；顶层标量分区返回 [["", 值]]。 */
function collectLeafPairs(
  v: SettingsValue | undefined,
  skipKey?: string,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (val: SettingsValue | undefined, rel: string) => {
    if (isRedacted(val)) {
      out.push([rel, "•••"]);
      return;
    }
    if (val === undefined) return;
    if (val === null) {
      out.push([rel, "null"]);
      return;
    }
    if (Array.isArray(val)) {
      out.push([rel, `[${val.length}]`]);
      return;
    }
    if (typeof val === "object") {
      for (const [ck, cv] of Object.entries(val as SettingsObject)) {
        if (ck === skipKey) continue;
        walk(cv, rel ? `${rel}.${ck}` : ck);
      }
      return;
    }
    out.push([rel, String(val)]);
  };
  walk(v, "");
  return out;
}

/** 结构化全设置表单（15.26 F4②）：递归渲染 settings 树——
 * redacted→密码框（留空=保留）/ object→分组下钻 / array→JSON 文本 /
 * 标量→类型化输入。免硬编码 per-CLI schema（动态渲染任意 CLI 的字段），
 * 保存=叶子级 diff + secret 补丁（网络传输只发变更）。 */
/** 深合并补丁（patch 优先；对象递归下钻，数组/标量整节点替换）。 */
function deepMergePatch(
  target: SettingsObject,
  patch: SettingsObject,
): SettingsObject {
  const out: SettingsObject = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
    ) {
      out[k] = deepMergePatch(out[k] as SettingsObject, v as SettingsObject);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 按路径删键（seed-secret 从 draft-diff 剔除后改走 secret 补丁）。 */
function removePath(obj: SettingsObject, path: string[]): void {
  let cur: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur && typeof cur === "object" && path[i] in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[path[i]];
    } else return;
  }
  if (cur && typeof cur === "object") delete (cur as Record<string, unknown>)[path[path.length - 1]];
}

/** 15.30：剥离 patch 里"用户没填的可选字段空串"——base 该处非空=用户主动
 * 清空（保留 ""=清除语义）；base 该处无值/空=seed 预填的可选字段留空
 * （不写空串，配置保持干净）。对象递归下钻，深度对齐 base。 */
function stripEmptyLeavesNotInBase(
  patch: SettingsObject,
  base: SettingsObject,
): SettingsObject {
  const out: SettingsObject = {};
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string" && v === "") {
      const bv = getAtPath(base, [k]);
      // base 该处是非空串 → 用户主动清空 → 保留 ""（清除）；否则丢弃。
      if (typeof bv === "string" && bv !== "") out[k] = v;
      continue;
    }
    if (Array.isArray(v) && v.length === 0) {
      // 与空串同语义：base 该处是非空数组 → 用户主动清空 → 保留 []
      // （清除）；否则（seed 预填的空数组）丢弃，不写脏字段。
      const bv = getAtPath(base, [k]);
      if (Array.isArray(bv) && bv.length > 0) out[k] = v;
      continue;
    }
    if (Array.isArray(v)) {
      // 15.31：数组在 diff 里是整节点替换（patch 里是全量新数组）→ 逐元素
      // 按对应 base 元素剥离：seed 预填的空串叶子（id/name/baseUrl）无 base 值
      // → 丢；整条全新且剥空 = seed 噪音 → 从数组移除；base 有的字段主动清空
      // （""）保留。不递归会把空态路由条目 {id:"",name:"",baseUrl:""} 原样写盘。
      const baseArr = getAtPath(base, [k]);
      const strippedArr: SettingsValue[] = [];
      (v as SettingsValue[]).forEach((el, i) => {
        if (el && typeof el === "object" && !Array.isArray(el)) {
          const baseEl = Array.isArray(baseArr) ? baseArr[i] : undefined;
          const baseIsObj =
            baseEl && typeof baseEl === "object" && !Array.isArray(baseEl);
          const stripped = stripEmptyLeavesNotInBase(
            el as SettingsObject,
            (baseIsObj ? baseEl : {}) as SettingsObject,
          );
          if (!baseIsObj && Object.keys(stripped).length === 0) return;
          strippedArr.push(stripped);
        } else {
          strippedArr.push(el);
        }
      });
      // 剥空成 [] 且 base 也无此数组 = seed 噪音 → 连 key 一起丢（零脏字段）。
      if (
        strippedArr.length === 0 &&
        !(Array.isArray(baseArr) && baseArr.length > 0)
      ) {
        continue;
      }
      out[k] = strippedArr;
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const subBase = (getAtPath(base, [k]) || {}) as SettingsObject;
      const sub = stripEmptyLeavesNotInBase(v as SettingsObject, subBase);
      if (Object.keys(sub).length > 0) out[k] = sub;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function SettingsTreeEditor({
  base,
  readOnly,
  busy,
  onSave,
  modelValue,
  onModelChange,
  modelOptions,
  modelCandidates,
  objectModel,
  seed,
  seedSecrets,
  patchPlaceholder,
  catalog,
}: {
  base: SettingsObject;
  readOnly: boolean;
  busy: boolean;
  onSave: (patch: SettingsObject) => void;
  /** 模型专行（15.27：同 Worker 模型选择的列表选择）。undefined=不启用
   * （树内 model 键照常渲染）；启用后 model 顶层键从树中摘出，由此行
   * 管理（draft 在父组件），保存时按 diff 写入 model（15.29 格式：
   * objectModel=true 写 {name}，否则写扁平字符串）。 */
  modelValue?: string;
  onModelChange?: (v: string) => void;
  modelOptions?: ModelOptions;
  modelCandidates?: string[];
  /** 15.29：model 以对象 {name} 写（qwen-code 现行格式）；false=扁平字符串。 */
  objectModel?: boolean;
  /** 15.30：空态模板（base 空时自动预填成结构化表单起点）；不含 model。 */
  seed?: SettingsObject;
  /** 15.30：模板中的密钥路径（渲染为密码框 + 空值保存时丢弃）。 */
  seedSecrets?: string[];
  /** 15.31：JSON 补丁占位示例（按 CLI 最高频补丁需求定制）。 */
  patchPlaceholder?: string;
  /** 15.32：字段目录（FIELD_CATALOG[cli]）——目录内字段即使用户文件未设置
   * 也渲染（空态控件，用户操作才写 draft → 保存才落盘）；目录不是白名单，
   * 未收录键原样自由渲染。undefined=不启用目录（纯内容驱动，旧行为）。 */
  catalog?: Record<string, FieldSpec>;
}) {
  const t = useThemeColors();
  const tr = useT();
  const lang = useLang();
  /** 15.32：目录字段双语文案（spec 自带 zh/en，不走 DICT）。 */
  const specLabel = (s: FieldSpec): string => (lang === "en" ? s.en : s.zh);
  const seedSecretSet = React.useMemo(
    () => new Set(seedSecrets ?? []),
    [seedSecrets],
  );
  // 空态（base 空）+ 有模板 → 预填模板（结构化表单起点）；否则用真实内容。
  const initDraft = React.useCallback((): SettingsObject => {
    const empty = Object.keys(base).length === 0;
    const tpl = seed && Object.keys(seed).length > 0 ? seed : null;
    return deepCopySettings(empty && tpl ? tpl : base);
  }, [base, seed]);
  const [draft, setDraft] = React.useState<SettingsObject>(initDraft);
  const [secretDraft, setSecretDraft] = React.useState<Record<string, string>>({});
  // 15.30：可选 JSON 补丁（任意字段逃逸口，同 dashboard；同键以补丁为准）。
  const [jsonPatch, setJsonPatch] = React.useState("");
  const [jsonErr, setJsonErr] = React.useState("");

  // 15.34：分区卡收放（每分区独立 state，非手风琴——settings 常需多组同看）；
  // 无显式 state → 默认 = 分区有内容（文件值/seed 预填）时展开、空分区收起。
  const [sectionOpen, setSectionOpen] = React.useState<Record<string, boolean>>({});
  // base 变化（切 CLI / 保存回写）→ 重置草稿（对齐最新基线）。
  const baseRef = React.useRef(base);
  React.useEffect(() => {
    if (base !== baseRef.current) {
      baseRef.current = base;
      setDraft(initDraft());
      setSecretDraft({});
      setJsonPatch("");
      setJsonErr("");
      // 15.34：分区收放显式态一并清（默认展开判定随新基线重算）。
      setSectionOpen({});
    }
  }, [base, initDraft]);

  const setAtPath = (path: string[], value: SettingsValue) => {
    setDraft((prev) => {
      const next = deepCopySettings(prev);
      assignPath(next, path, value);
      return next;
    });
  };

  // 15.31：模型行参与 dirty——15.27 引入模型行时漏接此判定，只改模型名
  // （树字段未动）时 diffSettings 空 → 保存钮恒 disabled、改不动（回归）。
  const modelDirty =
    modelValue !== undefined &&
    (modelValue ?? "").trim() !== modelNameOf(base);

  const dirty =
    Object.keys(diffSettings(base, draft)).length > 0 ||
    Object.entries(secretDraft).some(([, v]) => v !== "") ||
    jsonPatch.trim() !== "" ||
    modelDirty;

  const handleSave = () => {
    // 1) 叶子级 diff（redacted 跳过，secret 另行处理）。
    let patch: SettingsObject = { ...diffSettings(base, draft) };
    // 2) seed-secret 路径（点分串 → 段数组）：从 diff 剔除，改走 secret
    //    补丁（空值丢弃，不写空密钥——base 空时无现有密钥，跳过=不建空 key）。
    for (const joined of seedSecrets ?? []) removePath(patch, joined.split("."));
    // 3) base 既有 redacted（保存回写后可能存在；"***"=保留）。**深合并**——
    //    浅 Object.assign 会把 secret 与同层非 secret 字段（qwen-code
    //    security.auth 的 apiKey + baseUrl）互相覆盖，编辑同层字段时丢改动。
    patch = deepMergePatch(patch, buildSecretPatch(base, secretDraft));
    // 4) seed-secret 新值（用户输入才写；空=跳过）。
    for (const joined of seedSecrets ?? []) {
      const v = (secretDraft[joined] ?? "").trim();
      if (v) assignPath(patch, joined.split("."), v);
    }
    // 5) JSON 补丁（可选，同键以补丁为准，深合并 patch 优先）；非法即阻止。
    const jp = jsonPatch.trim();
    if (jp) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jp);
      } catch {
        setJsonErr(tr("JSON 补丁格式非法（未应用）"));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonErr(tr("JSON 补丁须为对象（未应用）"));
        return;
      }
      patch = deepMergePatch(patch, parsed as SettingsObject);
      setJsonErr("");
    }
    // 6) 模型专行：draft 在父组件——按 base diff 写入。15.29 格式定案：
    // qwen-code 现行 settings.json 的 model 是**对象 {name}**（官方
    // 文档「New Configuration Format」+ dashboard 同款写法实证；旧扁平
    // 字符串格式由 CLI 自动迁移）；opencode/qoder 用扁平字符串
    // （controller 测试夹具 "model":"updated" 实证）。读取双向兼容
    // （settingsModel 同时认 string / {name}）。空串=清除覆盖，merge
    // 直覆，回退 CLI 默认。写前校验同 Worker 模型选择
    // （路径/URL/空格=error 阻止；不在在服列表=warn 放行）。
    if (modelValue !== undefined && onModelChange) {
      const v = (modelValue ?? "").trim();
      const baseModel = modelNameOf(base);
      if (v !== baseModel) {
        if (objectModel) {
          // 15.31：model 对象——{name} 与树内子字段 diff 深合并
          // （直覆会丢用户在树里改的 reasoningEffort/generationConfig）。
          const existing =
            patch.model && typeof patch.model === "object" && !Array.isArray(patch.model)
              ? (patch.model as SettingsObject)
              : {};
          patch.model = { ...existing, name: v };
        } else {
          patch.model = v;
        }
      }
      if (v) {
        const verdict = validateModelValue(v, modelCandidates ?? []);
        if (verdict.level === "error") {
          antd.message.error(
            modelVerdictText(tr, verdict, v, modelCandidates ?? []),
          );
          return;
        }
        if (verdict.level === "warn") {
          antd.message.warning(
            modelVerdictText(tr, verdict, v, modelCandidates ?? []),
          );
        }
      }
    }
    // 7) 剥离未填的可选字段空串（seed 预填留空不写；base 非空主动清空保留）。
    onSave(stripEmptyLeavesNotInBase(patch, base));
  };

  // 15.31：modelProviders[provider] 是「路由数组」——每条目结构化卡片
  // （id/name/envKey/baseUrl 表单 + 增删），不再整数组 JSON 文本。
  // providerId → 推荐 envKey（官方文档默认值）。
  const ENV_KEY_BY_PROVIDER: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
  };

  function renderModelProviderList(
    path: string[],
    items: SettingsValue[],
  ): ReactNS.ReactNode {
    const providerId = path[1];
    const skeleton = (): SettingsObject => ({
      id: "",
      name: "",
      envKey: ENV_KEY_BY_PROVIDER[providerId] ?? "API_KEY",
      baseUrl: "",
      ...(providerId === "openai" ? { wireApi: "" } : {}),
    });
    return (
      <div
        style={{
          display: "grid",
          gap: 6,
          paddingLeft: 8,
          borderLeft: `2px solid ${t.border}`,
        }}
      >
        {items.length === 0 ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("尚无模型路由——点下方「添加模型路由」。")}
          </span>
        ) : null}
        {items.map((item, idx) => (
          <div
            key={idx}
            style={{
              border: `1px dashed ${t.border}`,
              borderRadius: 6,
              padding: 6,
              display: "grid",
              gap: 4,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary }}>
                {tr("{provider} · {n} 号路由", { provider: providerId, n: idx + 1 })}
              </span>
              <div style={{ flex: 1 }} />
              {!readOnly && items.length > 1 ? (
                <antd.Button
                  size="small"
                  type="text"
                  danger
                  onClick={() =>
                    setAtPath(path, items.filter((_, j) => j !== idx))
                  }
                >
                  {tr("删除")}
                </antd.Button>
              ) : null}
            </div>
            {item && typeof item === "object" && !Array.isArray(item) ? (
              renderNode(item, [...path, String(idx)])
            ) : (
              <span style={{ fontSize: 11, color: t.textSecondary }}>
                {tr("（非法条目——用下方 JSON 补丁修正）")}
              </span>
            )}
          </div>
        ))}
        {!readOnly ? (
          <antd.Button
            size="small"
            onClick={() => setAtPath(path, [...items, skeleton()])}
          >
            {tr("＋ 添加模型路由")}
          </antd.Button>
        ) : null}
      </div>
    );
  }

  const renderNode = (
    value: SettingsValue | undefined,
    path: string[],
    skipKey?: string,
  ): ReactNS.ReactNode => {
    // 15.32：catalog 前缀键文件未设置（undefined）但目录内有更深键 →
    // 展开为空对象（渲染子字段空态），避免落底显示 "null"。
    if (value === undefined && catalog) {
      if (Object.keys(catalog).some((k) => k.startsWith(path.join(".") + "."))) {
        value = {};
      }
    }
    // redacted（服务端脱敏）或 seed-secret（模板里的密钥，draft 里是普通串）
    // → 密码框（留空=不写/保留）。
    if (isRedacted(value) || seedSecretSet.has(path.join("."))) {
      const joined = path.join(".");
      const hasValue = isRedacted(value)
        ? value.has_value
        : Boolean(typeof value === "string" && value);
      return (
        <antd.Input.Password
          value={secretDraft[joined] ?? (typeof value === "string" ? value : "")}
          onChange={(e: { target: { value: string } }) =>
            setSecretDraft((p) => ({ ...p, [joined]: e.target.value }))}
          placeholder={
            hasValue ? tr("已保存，留空保留；输入=替换") : tr("未设置；输入=设置")
          }
          disabled={readOnly}
          size="small"
          style={{ flex: "1 1 200px", maxWidth: 300 }}
        />
      );
    }
    if (Array.isArray(value)) {
      // 15.31：modelProviders 的路由数组 → 结构化卡片（非 JSON 文本）。
      if (path.length === 2 && path[0] === "modelProviders") {
        return renderModelProviderList(path, value as SettingsValue[]);
      }
      return (
        <antd.Input.TextArea
          value={JSON.stringify(value, null, 2)}
          onChange={(e: { target: { value: string } }) => {
            try {
              const raw = e.target.value.trim();
              const parsed = raw === "" ? [] : JSON.parse(raw);
              if (Array.isArray(parsed)) setAtPath(path, parsed);
            } catch {
              /* 解析失败=不更新草稿（保留上次有效值） */
            }
          }}
          disabled={readOnly}
          autoSize={{ minRows: 2, maxRows: 8 }}
          style={{
            flex: "1 1 200px",
            maxWidth: 460,
            fontFamily: "monospace",
            fontSize: 11,
          }}
        />
      );
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as SettingsObject).filter(
        ([k]) => k !== skipKey,
      );
      // 15.32：catalog 驱动——目录内子键文件未设置的也显示（空态控件，
      // 用户操作才写 draft，不操作不落盘）。
      const prefix = path.join(".");
      const catChildren = catalog
        ? Object.keys(catalog)
            .filter((k) => k.startsWith(prefix + "."))
            .map((k) => k.slice(prefix.length + 1))
            .filter((k) => !entries.some(([ek]) => ek === k))
        : [];
      if (entries.length === 0 && catChildren.length === 0) {
        return (
          <span style={{ fontSize: 11, color: t.textSecondary }}>(空对象)</span>
        );
      }
      // 叶子行标签：有 spec=双语文案+key 副行；无 spec=裸 key（原样）。
      const labelFor = (leafKey: string) => {
        const spec = catalog?.[`${prefix}.${leafKey}`];
        return spec ? (
          <span
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              fontSize: 11,
              color: t.textSecondary,
              lineHeight: 1.35,
              display: "grid",
            }}
          >
            {specLabel(spec)}
            <span
              style={{
                fontFamily: "monospace",
                fontSize: 10,
                opacity: 0.7,
                overflowWrap: "anywhere",
              }}
            >
              {leafKey}
            </span>
          </span>
        ) : (
          <span
            style={{
              fontSize: 11,
              color: t.textSecondary,
              flex: "0 1 110px",
              minWidth: 0,
              overflowWrap: "anywhere",
              fontFamily: "monospace",
            }}
          >
            {leafKey}
          </span>
        );
      };
      return (
        <div
          style={{
            display: "grid",
            gap: 4,
            paddingLeft: 8,
            gridTemplateColumns: "minmax(0, 1fr)",
            borderLeft: `2px solid ${t.border}`,
          }}
        >
          {/* 15.31：model 对象的 name 子键由上方模型专行管——
           * 树内跳过（避免双源），留提示行。 */}
          {skipKey ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  fontSize: 11,
                  color: t.textSecondary,
                  minWidth: 110,
                  fontFamily: "monospace",
                }}
              >
                {skipKey}
              </span>
              <span style={{ fontSize: 11, color: t.textSecondary }}>
                {tr("← 由上方「模型」行管理")}
              </span>
            </div>
          ) : null}
          {entries.map(([k, v]) => (
            <div
                key={k}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "4px 8px",
                  flexWrap: "wrap",
                  minWidth: 0,
                }}
              >
              {labelFor(k)}
              {renderNode(v, [...path, k])}
            </div>
          ))}
          {/* 15.32：目录内未设置字段（空态起点）。 */}
          {catChildren.map((k) => {
            const spec = catalog?.[`${prefix}.${k}`];
            if (!spec) return null;
            return (
              <div
                key={k}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "4px 8px",
                  flexWrap: "wrap",
                  minWidth: 0,
                }}
              >
                {labelFor(k)}
                {renderNode(undefined, [...path, k])}
              </div>
            );
          })}
        </div>
      );
    }
    // 15.32：catalog 驱动叶子——有 spec 按 spec 控件渲染（空态=默认空
    // 控件；用户操作才写 draft，不操作不落盘）。无 spec=原样通用渲染。
    const leafSpec: FieldSpec | undefined = catalog?.[path.join(".")];
    if (leafSpec) {
      switch (leafSpec.type) {
        case "bool":
          return (
            <antd.Switch
              checked={value === true}
              onChange={(c: boolean) => setAtPath(path, c)}
              disabled={readOnly}
              size="small"
            />
          );
        case "number":
          return (
            <antd.InputNumber
              value={typeof value === "number" ? value : undefined}
              onChange={(v: number | null) => setAtPath(path, v ?? 0)}
              disabled={readOnly}
              size="small"
              style={{ flex: "0 1 140px", minWidth: 90 }}
            />
          );
        case "enum":
          return (
            <antd.AutoComplete
              value={typeof value === "string" ? value : ""}
              onChange={(v: string) => setAtPath(path, v)}
              options={(leafSpec.options ?? []).map((o) => ({ value: o }))}
              disabled={readOnly}
              size="small"
              style={{
                flex: "1 1 220px",
                maxWidth: 320,
                fontFamily: "monospace",
                fontSize: 11,
              }}
            />
          );
        default:
          return (
            <antd.Input
              value={typeof value === "string" ? value : ""}
              onChange={(e: { target: { value: string } }) =>
                setAtPath(path, e.target.value)}
              placeholder={leafSpec.hint || undefined}
              disabled={readOnly}
              size="small"
              style={{
                flex: "1 1 200px",
                maxWidth: 460,
                fontFamily: "monospace",
                fontSize: 11,
              }}
            />
          );
      }
    }
    if (typeof value === "boolean") {
      return (
        <antd.Switch
          checked={value}
          onChange={(c: boolean) => setAtPath(path, c)}
          disabled={readOnly}
          size="small"
        />
      );
    }
    if (typeof value === "number") {
      return (
        <antd.InputNumber
          value={value}
          onChange={(v: number | null) => setAtPath(path, v ?? 0)}
          disabled={readOnly}
          size="small"
          style={{ width: 140 }}
        />
      );
    }
    if (value === null || value === undefined) {
      return <span style={{ fontSize: 11, color: t.textSecondary }}>null</span>;
    }
    return (
      <antd.Input
        value={String(value)}
        onChange={(e: { target: { value: string } }) => setAtPath(path, e.target.value)}
        disabled={readOnly}
        size="small"
        style={{ maxWidth: 460, fontFamily: "monospace", fontSize: 11 }}
      />
    );
  };

  const modelRowEnabled = modelValue !== undefined && !!onModelChange;
  // 15.30：树从 draft 渲染（结构+值都反映编辑）——原从 base 渲染导致
  // ① base 空时无字段（"没结构化表单"）② 输入框受控于 base，编辑不反映
  // （value 绑 base 但 onChange 写 draft）。draft=base/seed 深拷贝，首帧
  // 与 base 渲染一致，编辑后真实反映。
  // 15.31：model 扁平串（opencode/qoder）整体摘出（专行管）；
  // 对象（qwen-code 现行 {name,...}）保留渲染子字段（name 子键跳过）。
  const draftTopEntries = Object.entries(draft).filter(
    ([k, v]) =>
      !(modelRowEnabled && k === "model" && !(v && typeof v === "object" && !Array.isArray(v))),
  );
  // 15.32：catalog 顶层分组文件未设置的也显示（空态起点，不操作不落盘）。
  // 15.34 修：顶层=目录键本身（无点）∪ 点分键的前缀（context.* → context）
  // ——原 filter(!includes(".")) 漏掉只有点分键的分组（context/general/ui/
  // modelFamily/goals/memory/agents/mcp/serve/advanced/experimental 整组不渲染）。
  const catTopKeys = catalog
    ? Array.from(
        new Set(
          Object.keys(catalog).flatMap((k) =>
            k.includes(".") ? [k.split(".")[0]] : [k],
          ),
        ),
      ).filter((k) => !draftTopEntries.some(([ek]) => ek === k))
    : [];
  const topEntries: Array<[string, SettingsValue | undefined]> = [
    ...draftTopEntries,
    ...catTopKeys.map((k) => [k, undefined] as [string, SettingsValue | undefined]),
  ];
  // 空态提示（15.31）：树无条目 + 模型专行也为空（或无专行）才提示。
  // model 对象（qwen-code {name,...}）留在 topEntries 渲染（树不空）；
  // model 扁平串（opencode/qoder）被专行摘出——专行已有值时不再误报
  // 「尚无配置文件」（判值用专行的 modelValue，不用 draft.model 形态）。
  const emptyTreeHint = !modelRowEnabled || !(modelValue ?? "").trim();
  return (
    <div style={{ display: "grid", gap: 10, gridTemplateColumns: "minmax(0, 1fr)" }}>
      {/* 空配置引导（15.28/15.30）：base 空 + seed 预填 → 常用字段表单；
       * base 空 + 无 seed（opencode/qoder）→ 仅模型行 + JSON 补丁。 */}
      {Object.keys(base).length === 0 && Object.keys(draft).length > 0 ? (
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("以下为该 CLI 完整设置表单（字段目录驱动）——未设置项显示为空态，只有你改动并保存的项才写入配置文件；未列出的高级字段用下方 JSON 补丁补充。")}
        </div>
      ) : Object.keys(base).length === 0 && modelRowEnabled ? (
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("尚无配置文件——填模型名并保存即创建；高级字段用下方 JSON 补丁补充。")}
        </div>
      ) : null}
      {/* 模型专行（15.27）：同 Worker 模型选择——列表选择（SGLang 在服 ∪
       * 在用 ∪ 网关 alias）+ 自由输入兜底 + 写前校验。 */}
      {modelRowEnabled ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: t.text, minWidth: 44 }}>
            {tr("模型")}
          </span>
          <antd.AutoComplete
            size="small"
            style={{ flex: 1, maxWidth: 460, fontFamily: "monospace", fontSize: 11 }}
            value={modelValue}
            options={modelOptions}
            allowClear
            placeholder={tr("留空=清除覆盖（跟随 CLI 默认）")}
            disabled={readOnly}
            onChange={(v: string) => onModelChange(v || "")}
          />
        </div>
      ) : null}
      {topEntries.length === 0 && emptyTreeHint ? (
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("尚无配置文件——填模型名并保存即创建。")}
        </div>
      ) : (
        /* 15.34：分区卡——每个顶层分组一张可收放卡（独立收放，非手风琴：
         * settings 常需多组同看）。卡头 = 标题 + 当前值摘要（预填当前值，
         * 收起也一瞥可见）+ 未保存改动点；有内容默认展开、目录空分区收起。
         * auto-fit 自适应排列：宽屏多列 / 窄屏（竖屏 sheet）单列。
         * 触屏：卡头 ≥44px 目标 + userSelect none + role=button +
         * aria-expanded（读屏可辨）；鼠标：cursor pointer + chevron。 */
        <div
          style={{
            display: "grid",
            gap: 8,
            alignItems: "start",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(300px, 100%), 1fr))",
          }}
        >
          {topEntries.map(([k, v]) => {
            // 15.32：顶层分组双语标题（SECTION_LABELS），无词条回退裸键名。
            const section = SECTION_LABELS[k];
            const sectionTitle = section
              ? lang === "en"
                ? section.en
                : section.zh
              : k;
            const skipName = modelRowEnabled && k === "model";
            const open = sectionOpen[k] ?? hasContentValue(draft[k]);
            const toggle = () =>
              setSectionOpen((p) => ({
                ...p,
                [k]: !(p[k] ?? hasContentValue(draft[k])),
              }));
            const pairs = collectLeafPairs(v, skipName ? "name" : undefined);
            const secDirty =
              Object.keys(diffSettings(base, draft)).includes(k) ||
              (k === "model" && modelRowEnabled && modelDirty);
            return (
              <div
                key={k}
                style={{
                  minWidth: 0,
                  border: `1px solid ${t.border}`,
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={toggle}
                  onKeyDown={(e: { key: string; preventDefault(): void }) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle();
                    }
                  }}
                  title={tr("点击展开 / 收起")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    minHeight: 44,
                    padding: "6px 10px",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <span style={{ width: 12, fontSize: 11, color: "#888" }}>
                    {open ? "▾" : "▸"}
                  </span>
                  {/* 无词条的裸键分区：标题即键名（monospace 区分），
                   * 不再重复渲染第二份键名。 */}
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: t.text,
                      fontFamily: section ? undefined : "monospace",
                    }}
                  >
                    {sectionTitle}
                  </span>
                  {/* 15.34：当前值摘要（预填当前值）——收起状态一瞥可知现状；
                   * 至多 2 对 + 「+N」，单行截断（wb-clamp-1）。 */}
                  {pairs.length > 0 ? (
                    <span
                      className="wb-clamp-1"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 10,
                        fontFamily: "monospace",
                        color: t.textSecondary,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {pairs
                        .slice(0, 2)
                        .map(([pk, pv]) => (pk ? `${pk}=${pv}` : pv))
                        .join(" · ")}
                      {pairs.length > 2 ? ` · +${pairs.length - 2}` : ""}
                    </span>
                  ) : null}
                  {pairs.length === 0 ? <div style={{ flex: 1 }} /> : null}
                  {/* 分区级未保存改动点（模型专行改动也计入 model 分区）。 */}
                  {secDirty ? (
                    <span
                      aria-label={tr("有未保存改动")}
                      title={tr("此分区有未保存改动")}
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        background: "#d48806",
                        display: "inline-block",
                        flexShrink: 0,
                      }}
                    />
                  ) : null}
                </div>
                {open ? (
                  <div
                    style={{
                      padding: "2px 10px 10px",
                      display: "grid",
                      gap: 4,
                      gridTemplateColumns: "minmax(0, 1fr)",
                    }}
                  >
                    {/* 15.32：modelProviders 由 Higress 网关托管（默认跟 Worker）
                     * ——提示；下方路由卡片保留可编辑。 */}
                    {k === "modelProviders" ? (
                      <span style={{ fontSize: 11, color: t.textSecondary }}>
                        {tr("modelProviders 由 Higress 网关管理，默认跟 Worker——一般无需在此配置；已有路由仍可在下方查看/调整。")}
                      </span>
                    ) : null}
                    {renderNode(v, [k], skipName ? "name" : undefined)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {/* 15.30：JSON 补丁（任意字段逃逸口，同 dashboard；同键以补丁为准）。 */}
      {!readOnly ? (
        <div
          style={{
            display: "grid",
            gap: 3,
            gridTemplateColumns: "minmax(0, 1fr)",
          }}
        >
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("JSON 补丁（可选，任意字段；同键以补丁为准，如 mcp / tools）")}
          </span>
          <antd.Input.TextArea
            value={jsonPatch}
            onChange={(e: { target: { value: string } }) => {
              setJsonPatch(e.target.value);
              if (jsonErr) setJsonErr("");
            }}
            autoSize={{ minRows: 2, maxRows: 8 }}
            placeholder={patchPlaceholder || '{"mcp": {"enabled": true}}'}
            disabled={busy}
            style={{ fontFamily: "monospace", fontSize: 11, maxWidth: 460 }}
          />
          {jsonErr ? (
            <span style={{ fontSize: 11, color: "#e5484d" }}>{tr(jsonErr)}</span>
          ) : null}
        </div>
      ) : null}
      {!readOnly ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <antd.Button
            type="primary"
            size="small"
            disabled={!dirty || busy}
            loading={busy}
            onClick={handleSave}
          >
            {tr("保存改动")}
          </antd.Button>
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {dirty ? tr("有未保存改动") : tr("无改动")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// 千锻（Millforge）内嵌流程共享状态 hook——建队表单折叠区（B）与
// 团队管理「千锻注入」对话框（C/D）各持一个实例，互不串扰。
// 覆盖：源配置持久化（A）→ 导入/pack（B2）→ 模板 spec（B3）→ 编译
// 预览（B4）→ 注入（B5）→ 自定义 LLM 二次生成（D）→ 注入历史。
// React 一律经 host.React（插件零裸 import 教训）。

import type * as ReactNS from "react";

import {
  fetchMillforgeInjections,
  fetchMillforgePacks,
  fetchMillforgeSource,
  millforgeCompile,
  millforgeInject,
  millforgeImport,
  millforgeParseTeamJson,
  millforgePrompt,
  putMillforgeSource,
  type MillforgeBuildResult,
  type MillforgeIndex,
  type MillforgeInjectionRec,
  type MillforgeInjectResult,
  type MillforgePack,
  type MillforgeParseResult,
  type MillforgeSource,
  type MillforgeTemplateSpec,
} from "../api";
import type { TrFn } from "../crdmanage/types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

/** 源 Segmented 三态（custom = custom_url 非空，kind 保持最后真实值）。 */
export type MfSourceSeg = "github" | "gitcode" | "custom";

/** 注入模式：mapping=更新已选 Worker / create=新建 Worker 并注入。 */
export type MfInjectMode = "mapping" | "create";

/** create 模式行（role_id 随 build 角色固定；name/role/model 可编辑）。 */
export interface MfCreateRow {
  key: string;
  role_id: string;
  name: string;
  role: "team_leader" | "worker";
  model: string;
}

/** D 自定义团队（描述需求）表单 + 提示词 + LLM JSON 校验状态。 */
export interface MfCustomState {
  members: string;
  task_types: string;
  runtime: string;
  pains: string;
  team_name: string;
  prompt: string;
  promptBusy: boolean;
  promptError: string;
  jsonText: string;
  parseBusy: boolean;
  parseError: string;
  parseResult: MillforgeParseResult | null;
}

const EMPTY_CUSTOM: MfCustomState = {
  members: "",
  task_types: "",
  runtime: "",
  pains: "",
  team_name: "",
  prompt: "",
  promptBusy: false,
  promptError: "",
  jsonText: "",
  parseBusy: false,
  parseError: "",
  parseResult: null,
};

const EMPTY_SPEC: MillforgeTemplateSpec = {
  industry: "",
  domains: [],
  members: { leader: 1, workers: 2, critic: 0 },
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** compile 错误美化：requestJson 消息 "HTTP 422: {…json…}" → 分段可读。 */
export function fmtCompileError(e: unknown): string {
  const raw = errText(e);
  const m = /^HTTP \d{3}: (.*)$/s.exec(raw);
  const body = m ? m[1] : raw;
  if (body.startsWith("{")) {
    try {
      const d = JSON.parse(body) as Record<string, unknown>;
      const stage = String(d.stage || "");
      const err = String(d.error || "");
      const tail = String(d.stderr_tail || "").trim();
      let out = `编译失败${stage ? `（${stage}）` : ""}${err ? `：${err}` : ""}`;
      if (tail) out += `\n${tail.slice(-600)}`;
      return out;
    } catch {
      /* 非 JSON——原样返回 */
    }
  }
  return raw;
}

export interface MfCompileOutcome {
  build: MillforgeBuildResult | null;
  error: string;
}

export function useMillforgeCore(tr: TrFn) {
  // ── A 源配置（Segmented 切换即 PUT 持久化；文本输入失焦持久化）──
  const [source, setSource] = React.useState<MillforgeSource | null>(null);
  const [sourceError, setSourceError] = React.useState("");
  const [ref, setRef] = React.useState("main");
  const [importing, setImporting] = React.useState(false);
  const [importMsg, setImportMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const loadSource = React.useCallback(async () => {
    setSourceError("");
    try {
      setSource(await fetchMillforgeSource());
    } catch (e) {
      setSourceError(errText(e));
    }
  }, []);
  React.useEffect(() => {
    void loadSource();
  }, [loadSource]);

  const persistSource = React.useCallback(
    async (patch: { kind?: string; repo?: string; custom_url?: string }) => {
      setSourceError("");
      try {
        setSource(await putMillforgeSource(patch));
      } catch (e) {
        setSourceError(errText(e));
      }
    },
    [],
  );

  /** 源 Segmented 现值（custom_url 非空 → custom，否则按 kind）。 */
  const seg: MfSourceSeg = source
    ? source.custom_url
      ? "custom"
      : source.kind === "gitcode"
        ? "gitcode"
        : "github"
    : "github";

  const changeSeg = React.useCallback(
    (next: MfSourceSeg) => {
      if (!source) return;
      if (next === "custom") {
        // 切到自定义：置占位 URL（失焦时再校验 PUT；空串=后端沿用现值）
        void persistSource({ custom_url: "" });
        return;
      }
      void persistSource({ kind: next, custom_url: "" });
    },
    [source, persistSource],
  );

  const persistRepo = React.useCallback(
    (repo: string) => {
      if (!source) return;
      void persistSource({ kind: source.kind, repo, custom_url: "" });
    },
    [source, persistSource],
  );

  const persistCustomUrl = React.useCallback(
    (url: string) => {
      if (!source) return;
      // 空串 = 清空自定义（回到 kind+repo 派生）——需带 kind 防 400（repo 现值兜底）。
      void persistSource({ kind: source.kind, repo: source.repo, custom_url: url });
    },
    [source, persistSource],
  );

  // ── 导入 / pack 列表 ──
  const [packs, setPacks] = React.useState<MillforgePack[]>([]);
  const [packsLoading, setPacksLoading] = React.useState(true);
  const [packsError, setPacksError] = React.useState("");
  const [pack, setPack] = React.useState("");

  const loadPacks = React.useCallback(async () => {
    setPacksLoading(true);
    setPacksError("");
    try {
      const d = await fetchMillforgePacks();
      setPacks(d.packs || []);
    } catch (e) {
      setPacksError(errText(e));
    } finally {
      setPacksLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void loadPacks();
  }, [loadPacks]);

  // 无选中（或选中已删）→ 自动选首个（优先 INDEX 可解析的）。
  React.useEffect(() => {
    setPack((cur) => {
      if (packs.length === 0) return "";
      if (packs.some((p) => p.pack === cur)) return cur;
      return (packs.find((p) => p.index && !p.parse_error) || packs[0]).pack;
    });
  }, [packs]);

  const activePack: MillforgePack | null =
    packs.find((p) => p.pack === pack) || null;
  const index: MillforgeIndex | null = activePack?.index || null;

  const doImport = React.useCallback(async (): Promise<boolean> => {
    setImporting(true);
    setImportMsg(null);
    setSourceError("");
    try {
      const d = await millforgeImport(ref.trim() || "main");
      setImportMsg({
        ok: true,
        text: `导入成功：${d.pack}（${d.files} 个文件，commit ${String(d.commit || "").slice(0, 7)}${d.has_compiler ? "" : "，未含编译器"}）`,
      });
      await loadPacks();
      setPack(d.pack);
      return true;
    } catch (e) {
      const t = errText(e);
      setImportMsg({ ok: false, text: t });
      setSourceError(t);
      return false;
    } finally {
      setImporting(false);
    }
  }, [ref, loadPacks]);

  // ── B3 模板 spec（industry 单选 + domains 多选 + 整队组合 + members + lang）──
  const [spec, setSpec] = React.useState<MillforgeTemplateSpec>(EMPTY_SPEC);
  const [lang, setLang] = React.useState<"zh" | "en">("zh");
  // 整队组合级联校验提示（组合 domains 与所选行业不符 → 清空 + 提示）。
  const [comboWarning, setComboWarning] = React.useState("");

  const pickCombo = React.useCallback(
    (comboId: string) => {
      const combo = index?.teams.find((x) => x.id === comboId) || null;
      if (!combo) {
        setComboWarning("");
        setSpec((prev) => ({ ...prev, team_combo: "" }));
        return;
      }
      const num = (v: string, dft: number) => {
        const n = parseInt(String(v).replace(/\D/g, ""), 10);
        return Number.isFinite(n) && n > 0 ? n : dft;
      };
      // 级联：组合的 domains 须属于（组合自带/当前所选）industry；
      // INDEX 无 industry 字段（旧包）时跳过校验——诚实降级。
      const nextIndustry = combo.industry || spec.industry || "";
      let domains = combo.domains
        ? combo.domains.split(",").map((x) => x.trim()).filter(Boolean)
        : spec.domains || [];
      let warning = "";
      const domEntries = (index?.domain || []).filter((e) => e.id);
      const hasIndustryInfo = domEntries.some((e) => e.industry);
      if (nextIndustry && hasIndustryInfo && domains.length) {
        const belonging = new Set(
          domEntries.filter((e) => e.industry === nextIndustry).map((e) => e.id),
        );
        if (!domains.every((d) => belonging.has(d))) {
          domains = [];
          warning = tr("整队组合的领域不属于所选行业——已清空 domains（可手动补选）");
        }
      }
      setComboWarning(warning);
      setSpec({
        team_combo: combo.id,
        industry: nextIndustry,
        domains,
        members: {
          leader: num(combo.members.leader, spec.members?.leader || 1),
          workers: num(combo.members.workers, spec.members?.workers || 2),
          critic: num(combo.members.critic, spec.members?.critic || 0),
        },
      });
    },
    [index, spec, tr],
  );

  // ── B4 编译预览 ──
  const [build, setBuild] = React.useState<MillforgeBuildResult | null>(null);
  const [compiling, setCompiling] = React.useState(false);
  const [compileError, setCompileError] = React.useState("");

  const compileWithTemplate = React.useCallback(
    async (teamName: string): Promise<MfCompileOutcome> => {
      if (!pack) return { build: null, error: tr("尚未导入模板包——先选择源并导入") };
      setCompiling(true);
      setCompileError("");
      try {
        const b = await millforgeCompile({
          pack,
          team: teamName,
          lang,
          template: {
            team_combo: spec.team_combo || undefined,
            industry: spec.industry || undefined,
            domains: spec.domains || [],
            members: spec.members || EMPTY_SPEC.members,
          },
        });
        setBuild(b);
        return { build: b, error: "" };
      } catch (e) {
        const err = fmtCompileError(e);
        setBuild(null);
        setCompileError(err);
        return { build: null, error: err };
      } finally {
        setCompiling(false);
      }
    },
    [pack, lang, spec, tr],
  );

  const compileWithTeamJson = React.useCallback(
    async (teamName: string, teamJson: Record<string, unknown>): Promise<MfCompileOutcome> => {
      if (!pack) return { build: null, error: tr("尚未导入模板包——先选择源并导入") };
      setCompiling(true);
      setCompileError("");
      try {
        const b = await millforgeCompile({
          pack,
          team: teamName,
          lang,
          team_json: teamJson,
        });
        setBuild(b);
        return { build: b, error: "" };
      } catch (e) {
        const err = fmtCompileError(e);
        setBuild(null);
        setCompileError(err);
        return { build: null, error: err };
      } finally {
        setCompiling(false);
      }
    },
    [pack, lang, tr],
  );

  // ── B5 注入（mapping / create；逐项结果 + partial）──
  const [injectMode, setInjectMode] = React.useState<MfInjectMode>("mapping");
  const [mapping, setMapping] = React.useState<Record<string, string>>({});
  const [createRows, setCreateRows] = React.useState<MfCreateRow[]>([]);
  const [coreSkill, setCoreSkill] = React.useState(true);
  const [applySoul, setApplySoul] = React.useState(true);
  const [injecting, setInjecting] = React.useState(false);
  const [injectError, setInjectError] = React.useState("");
  const [injectResult, setInjectResult] = React.useState<MillforgeInjectResult | null>(null);

  // 新 build 产出 → 按角色初始化 mapping（空）/ createRows（名留空）。
  React.useEffect(() => {
    if (!build) {
      setMapping({});
      setCreateRows([]);
      return;
    }
    setMapping(Object.fromEntries(build.roles.map((r) => [r.role, ""])));
    setCreateRows(
      build.roles.map((r) => ({
        key: r.role,
        role_id: r.role,
        name: "",
        role: r.kind === "leader" ? "team_leader" : "worker",
        model: "",
      })),
    );
    setInjectResult(null);
    setInjectError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build?.build_id]);

  const doInject = React.useCallback(
    async (teamName: string): Promise<MillforgeInjectResult | null> => {
      if (!build) return null;
      if (injectMode === "mapping") {
        const m: Record<string, string> = {};
        for (const [k, v] of Object.entries(mapping)) {
          const w = (v || "").trim();
          if (w) m[k] = w;
        }
        if (!Object.keys(m).length) {
          setInjectError(tr("至少选择 1 个现有 Worker（mapping）"));
          return null;
        }
        setInjecting(true);
        setInjectError("");
        try {
          const res = await millforgeInject({
            build_id: build.build_id,
            team: teamName,
            mapping: m,
            create_workers: [],
            core_skill: coreSkill,
            apply_soul: applySoul,
          });
          setInjectResult(res);
          return res;
        } catch (e) {
          setInjectError(errText(e));
          return null;
        } finally {
          setInjecting(false);
        }
      }
      const rows = createRows.filter((r) => (r.name || "").trim());
      if (!rows.length) {
        setInjectError(tr("请填写至少 1 个新建 Worker 名（create_workers）"));
        return null;
      }
      const bad = rows.filter((r) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.name.trim()));
      if (bad.length) {
        setInjectError(
          tr("Worker 名须小写字母/数字/-（≤64 字符）：{list}", {
            list: bad.map((r) => r.name.trim()).join("、"),
          }),
        );
        return null;
      }
      setInjecting(true);
      setInjectError("");
      try {
        const res = await millforgeInject({
          build_id: build.build_id,
          team: teamName,
          mapping: {},
          create_workers: rows.map((r) => ({
            name: r.name.trim(),
            role_id: r.role_id,
            role: r.role,
            model: (r.model || "").trim() || undefined,
            runtime: "qwenpaw",
          })),
          core_skill: coreSkill,
          apply_soul: applySoul,
        });
        setInjectResult(res);
        return res;
      } catch (e) {
        setInjectError(errText(e));
        return null;
      } finally {
        setInjecting(false);
      }
    },
    [build, injectMode, mapping, createRows, coreSkill, applySoul, tr],
  );

  // ── D 自定义团队（描述需求 → 提示词 → LLM JSON 校验）──
  const [custom, setCustom] = React.useState<MfCustomState>(EMPTY_CUSTOM);

  const genPrompt = React.useCallback(async () => {
    if (!pack) {
      setCustom((c) => ({ ...c, promptError: tr("尚未导入模板包——先选择源并导入") }));
      return;
    }
    setCustom((c) => ({ ...c, promptBusy: true, promptError: "" }));
    try {
      const r = await millforgePrompt(pack, {
        members: custom.members,
        task_types: custom.task_types,
        runtime: custom.runtime,
        pains: custom.pains,
        team_name: custom.team_name,
      });
      setCustom((c) => ({ ...c, prompt: r.prompt }));
    } catch (e) {
      setCustom((c) => ({ ...c, promptError: errText(e) }));
    } finally {
      setCustom((c) => ({ ...c, promptBusy: false }));
    }
  }, [pack, custom.members, custom.task_types, custom.runtime, custom.pains, custom.team_name, tr]);

  const parseJson = React.useCallback(async () => {
    if (!pack) {
      setCustom((c) => ({ ...c, parseError: tr("尚未导入模板包——先选择源并导入") }));
      return;
    }
    if (!(custom.jsonText || "").trim()) {
      setCustom((c) => ({ ...c, parseError: tr("先粘贴 LLM 返回的 JSON 文本") }));
      return;
    }
    setCustom((c) => ({ ...c, parseBusy: true, parseError: "", parseResult: null }));
    try {
      const r = await millforgeParseTeamJson(pack, custom.jsonText);
      setCustom((c) => ({ ...c, parseResult: r }));
    } catch (e) {
      setCustom((c) => ({ ...c, parseError: errText(e) }));
    } finally {
      setCustom((c) => ({ ...c, parseBusy: false }));
    }
  }, [pack, custom.jsonText, tr]);

  // ── 注入历史（GET /millforge/injections）──
  const [injections, setInjections] = React.useState<MillforgeInjectionRec[]>([]);
  const [injLoading, setInjLoading] = React.useState(false);
  const loadInjections = React.useCallback(async () => {
    setInjLoading(true);
    try {
      const d = await fetchMillforgeInjections();
      setInjections(d.injections || []);
    } catch {
      /* 历史为只读辅助——失败静默（按钮可重试） */
    } finally {
      setInjLoading(false);
    }
  }, []);

  /** 建队成功后复位（清 build/注入结果/自定义校验态；源/pack/spec 保留）。 */
  const resetAfterCreate = React.useCallback(() => {
    setBuild(null);
    setCompileError("");
    setInjectResult(null);
    setInjectError("");
    setCustom(EMPTY_CUSTOM);
  }, []);

  return {
    // A 源
    source,
    sourceError,
    seg,
    changeSeg,
    persistRepo,
    persistCustomUrl,
    ref,
    setRef,
    importing,
    importMsg,
    doImport,
    loadSource,
    // pack
    packs,
    packsLoading,
    packsError,
    loadPacks,
    pack,
    setPack,
    activePack,
    index,
    // B3 spec
    spec,
    setSpec,
    pickCombo,
    comboWarning,
    setComboWarning,
    lang,
    setLang,
    // B4 编译
    build,
    compiling,
    compileError,
    compileWithTemplate,
    compileWithTeamJson,
    // B5 注入
    injectMode,
    setInjectMode,
    mapping,
    setMapping,
    createRows,
    setCreateRows,
    coreSkill,
    setCoreSkill,
    applySoul,
    setApplySoul,
    injecting,
    injectError,
    injectResult,
    doInject,
    // D 自定义
    custom,
    setCustom,
    genPrompt,
    parseJson,
    // 历史
    injections,
    injLoading,
    loadInjections,
    // 复位
    resetAfterCreate,
  };
}

export type MfCore = ReturnType<typeof useMillforgeCore>;

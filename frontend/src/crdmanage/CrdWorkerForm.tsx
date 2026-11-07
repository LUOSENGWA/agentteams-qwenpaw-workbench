// CrdManage 拆分（QC-196 方案 §5.2）· 新建 Worker 卡（Worker CRD 创建表单，
// 建队卡内折叠区独立成卡）——原主组件 JSX R4c 逐字搬移；props = 原闭包
// 变量名（零改写）。

import type * as ReactNS from "react";

import { fetchGatewayAiProviders, fetchGatewayAiRoutes } from "../api";
import {
  buildModelSelectionOptions,
  type LlmProviderLite,
  type ModelSelectionOption,
} from "../modelCatalog";
import {
  extractGatewayLists,
  modelVerdictText,
  providerModelMismatch,
  validateModelValue,
} from "../modelUnion";
import ModelPicker, { type ModelPickerProvider } from "../components/ModelPicker";
import type { ThemeColors } from "../theme";
import { CheckIcon, ClipIcon, CloseIcon, WarnIcon } from "../components/icons";
import FieldLabel from "./FieldLabel";
import type { NwForm, TrFn } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;


/** 创建表单状态（useTeamCrd 的 nw state）：NwForm + C1a-2 provider
 * （""=跟随默认；doCreateWorker 随 createWorker body 的 modelProvider 下发）。 */
type NwFormState = NwForm & { provider: string };

interface CrdWorkerFormProps {
  nw: NwFormState;
  setNw: ReactNS.Dispatch<ReactNS.SetStateAction<NwFormState>>;
  doCreateWorker: () => void | Promise<void>;
  modelOptions: { value: string }[];
  modelCandidates: string[];
  loadSoulFile: (
    file: File | null | undefined,
    role: string,
    onLoaded: (text: string) => void,
  ) => void;
  tr: TrFn;
  t: ThemeColors;
}

export default function CrdWorkerForm({
nw,
setNw,
doCreateWorker,
modelCandidates,
loadSoulFile,
tr,
t,
}: CrdWorkerFormProps) {
  // C1a-2 provider-first：Provider 名单 + 网关 alias→provider 映射（与
  // CrdCfgModal 同源数据，经 useModelCatalog().providers 注入方式同形）。
  // 父组件（建队卡接线）不在本单白名单、传不进 props → 叶子直调
  // 请求缓存包裹的取数：gateway/ai-routes & gateway/ai-providers 均
  // cachedRequest（30s TTL + in-flight 去重）+ LRU，同屏 catalog 实例
  // 挂载即已拉取 → 命中缓存/复用同 key 在途 Promise，零新增网络请求。
  const [providers, setProviders] = React.useState<LlmProviderLite[]>([]);
  const [gatewayOpts, setGatewayOpts] = React.useState<
    ModelSelectionOption[] | null
  >(null);

  // ModelPicker 的 Provider→Model 候选（网关 alias 按 binding.providerName 归组）。
  const pickerProviders: ModelPickerProvider[] = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const p of providers) map.set(p.name, new Set());
    for (const o of gatewayOpts ?? []) {
      const pn = o.binding?.providerName;
      if (!pn) continue;
      if (!map.has(pn)) map.set(pn, new Set());
      map.get(pn)?.add(o.alias);
    }
    return [...map.entries()].map(([name, set]) => ({ name, models: [...set].sort() }));
  }, [providers, gatewayOpts]);
  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [routes, provs] = await Promise.all([
          fetchGatewayAiRoutes(),
          fetchGatewayAiProviders(),
        ]);
        if (!live) return;
        if (!routes.available || !provs.available) {
          setGatewayOpts(null); // 无 Console 会话=正常降级（非错误）
          setProviders([]);
          return;
        }
        // 共享解包 + 共享构建（与 useModelCatalog 同源零分叉）。
        const { routesList, providersList } = extractGatewayLists(
          routes.data,
          provs.data,
        );
        setGatewayOpts(buildModelSelectionOptions(routesList, providersList));
        setProviders(providersList);
      } catch {
        if (live) {
          setGatewayOpts(null);
          setProviders([]);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return (
      <antd.Card
        size="small"
        title={
          <span style={{ fontWeight: 700 }}>
            {tr("新建 Worker（Worker CRD）")}
          </span>
        }
        styles={{ body: { padding: 10 } }}
      >
        <div style={{ display: "grid", gap: 6 }}>
          {/* 独立 Worker 路径显式化：此表单不指定团队 → 建出的 Worker
不参与任何团队任务；回头路 = 团队设置「加入 Worker」。 */}
          <antd.Alert
            type="info"
            showIcon
            style={{ fontSize: 11 }}
            message={tr("不指定团队创建的 Worker 是独立 Worker：它能运行、能被私聊，但不参与任何团队任务。建好后可在团队设置里把它加进团队。")}
          />
          <FieldLabel>{tr("Worker 名（唯一，小写字母/数字/-）")}</FieldLabel>
          <antd.Input
            size="small"
            placeholder={tr("Worker 名（唯一，小写字母/数字/-）")}
            value={nw.name}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setNw((p) => ({ ...p, name: e.target.value }))
            }
          />
          {/* 运行时下拉 4 项——copaw 退役移除、
deepseek-harness 补上（上游 RuntimeDeepSeekHarness 常量实锤）、
默认 qwenpaw（安装脚本 AGENTTEAMS_DEFAULT_WORKER_RUNTIME:-qwenpaw）。 */}
          <FieldLabel>{tr("运行时")}</FieldLabel>
          <antd.Select
            size="small"
            value={nw.runtime}
            onChange={(v: string) => setNw((p) => ({ ...p, runtime: v }))}
            options={[
              { value: "openclaw", label: "OpenClaw" },
              { value: "hermes", label: "Hermes" },
              { value: "qwenpaw", label: "QwenPaw" },
              { value: "deepseek-harness", label: "DeepSeek Harness" },
            ]}
            style={{ width: "100%" }}
          />
          {/* C1a-2 provider-first：唯一 ModelPicker（Provider → Model，候选按
Provider 过滤）——实际转发由 Provider 决定，model 只是 alias。 */}
          <FieldLabel>{tr("模型（留空=跟随集群默认）")}</FieldLabel>
          <ModelPicker
            tr={tr}
            allowEmpty
            providers={pickerProviders}
            provider={nw.provider}
            model={nw.model}
            providerPlaceholder={tr("Provider（留空=跟随默认）")}
            modelPlaceholder={tr("模型（留空=跟随集群默认）")}
            onChange={(p: string, m: string) => setNw((prev) => ({ ...prev, provider: p, model: m }))}
          />
          {providerModelMismatch(
            gatewayOpts ?? [],
            nw.model,
            nw.provider,
          ) ? (
            <div style={{ fontSize: 10.5, color: "#faad14" }}>
              {tr("该模型不属于所选 Provider（可直接保存，以 Provider 为准）")}
            </div>
          ) : null}
          {(() => {
            const mv = validateModelValue(nw.model, modelCandidates);
            if (mv.level === "ok" && !(nw.model || "").trim()) return null;
            return (
              <div
                style={{
                  fontSize: 10.5,
                  color:
                    mv.level === "error"
                      ? "#f5222d"
                      : mv.level === "warn"
                        ? "#fa8c16"
                        : "#52c41a",
                }}
              >
                {mv.level === "ok" ? <CheckIcon size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} /> : mv.level === "error" ? <CloseIcon size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} /> : <WarnIcon size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} />}
                {modelVerdictText(tr, mv, nw.model, modelCandidates)}
              </div>
            );
          })()}
          <FieldLabel>{tr("SOUL（可选，多行，worker≤150 行）")}</FieldLabel>
          <antd.Input.TextArea
            size="small"
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={tr("SOUL（可选，多行；可上传 .md/.txt，worker≤150 行）")}
            value={nw.soul}
            onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
              setNw((p) => ({ ...p, soul: e.target.value }))
            }
          />
          <antd.Upload
            showUploadList={false}
            beforeUpload={(f: File) => {
              loadSoulFile(f, "worker", (t) =>
                setNw((p) => ({ ...p, soul: t })),
              );
              return false;
            }}
          >
            <antd.Button size="small" type="text" style={{ padding: 0, height: "auto" }}>
              <ClipIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {tr("上传 SOUL 文件")}
            </antd.Button>
          </antd.Upload>
          <antd.Button
            size="small"
            type="primary"
            loading={nw.busy}
            onClick={() => void doCreateWorker()}
          >
            {tr("创建 Worker")}
          </antd.Button>
          <div style={{ fontSize: 10.5, color: t.textSecondary, lineHeight: 1.7 }}>
            {tr("创建后由 Controller 调和器拉镜像起容器（数分钟就绪）。")}
            {" "}
            {tr("加入团队请在团队配置的成员列表中操作")}
          </div>
        </div>
      </antd.Card>
  );
}

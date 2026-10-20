// CrdManage 拆分（QC-196 方案 §5.2）· 新建 Worker 卡（Worker CRD 创建表单，
// 建队卡内折叠区独立成卡）——原主组件 JSX R4c 逐字搬移；props = 原闭包
// 变量名（零改写）。

import type * as ReactNS from "react";

import { modelVerdictText, validateModelValue } from "../modelUnion";
import type { ThemeColors } from "../theme";
import { CheckIcon, ClipIcon, CloseIcon, WarnIcon } from "../components/icons";
import FieldLabel from "./FieldLabel";
import type { NwForm, TrFn } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;


interface CrdWorkerFormProps {
  nw: NwForm;
  setNw: ReactNS.Dispatch<ReactNS.SetStateAction<NwForm>>;
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
modelOptions,
modelCandidates,
loadSoulFile,
tr,
t,
}: CrdWorkerFormProps) {
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
          <FieldLabel>{tr("模型（留空=跟随集群默认）")}</FieldLabel>
          <antd.AutoComplete
            size="small"
            placeholder={tr("模型（留空=跟随集群默认；下拉=在服∪在用∪Higress alias）")}
            options={modelOptions as { value: string }[]}
            value={nw.model}
            onChange={(v: string) =>
              setNw((p) => ({ ...p, model: v }))
            }
            style={{ width: "100%" }}
          />
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
            {tr("创建并加入团队")}
          </antd.Button>
          <div style={{ fontSize: 10.5, color: t.textSecondary }}>
            {tr("创建后由 Controller 调和器拉镜像起容器（数分钟就绪）；可先保存团队，Worker 就绪后自动生效。")}
          </div>
        </div>
      </antd.Card>
  );
}

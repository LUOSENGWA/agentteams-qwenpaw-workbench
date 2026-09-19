// 12.13 P7b「添加提供商 / 添加路由」（罗总 9/19 ⑤）：插件模型页写面。
// 字段形状与 dashboard models-section 的 serializeProviderForm /
// serializeRouteForm 对齐：
//   provider → { name, type, protocol, tokens[], tokenFailoverConfig?,
//                rawConfigs{openaiCustomUrl?, pathPrefix?, modelMapping?} }
//   route    → { name, pathPredicate(PRE), upstreams[{provider,weight,
//                modelMapping}], modelPredicates[{matchType(EQUAL|PRE),
//                matchValue}], authConfig{enabled,allowedCredentialTypes,
//                allowedConsumers?} }
// 写面经连接器 /gateway/* POST 透传到 Higress Console（console_session）。

import type * as ReactNS from "react";

import { createGatewayAiProvider, createGatewayAiRoute } from "./api";
import { useT } from "./i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 与 dashboard PROVIDER_TYPES 同源的常用类型（选择+可搜索）。 */
const PROVIDER_TYPE_OPTIONS = [
  "openai", "azure", "claude", "qwen", "deepseek", "gemini", "groq", "grok",
  "openrouter", "ollama", "vllm", "moonshot", "baichuan", "yi", "zhipuai",
  "baidu", "hunyuan", "stepfun", "minimax", "spark", "mistral", "cohere",
  "doubao", "together-ai", "github", "bedrock", "vertex", "cloudflare", "coze",
].map((v) => ({ value: v, label: v }));

const LBL: React.CSSProperties = {
  fontSize: 12,
  color: "#888",
  marginBottom: 4,
};

/** "pattern=目标模型" 每行一条 → { pattern: target }（空行/半条忽略）。 */
function parseMappings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/** "EQUAL:模型 / PRE:前缀" 每行一条；裸值按 EQUAL。 */
function parsePredicates(text: string): { matchType: string; matchValue: string }[] {
  const out: { matchType: string; matchValue: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(EQUAL|PRE|EXACT)\s*[:：]\s*(.+)$/i);
    if (m) {
      out.push({
        matchType: m[1].toUpperCase() === "PRE" ? "PRE" : "EQUAL",
        matchValue: m[2].trim(),
      });
    } else {
      out.push({ matchType: "EQUAL", matchValue: t });
    }
  }
  return out.filter((p) => p.matchValue);
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function ProviderCreateModal({ open, onClose, onCreated }: ModalProps) {
  const tr = useT();
  const [name, setName] = React.useState("");
  const [ptype, setPtype] = React.useState("openai");
  const [protocol, setProtocol] = React.useState<string>("openai/v1");
  const [tokensText, setTokensText] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [pathPrefix, setPathPrefix] = React.useState("");
  const [mappingsText, setMappingsText] = React.useState("");
  const [failover, setFailover] = React.useState(false);
  const [failoverModel, setFailoverModel] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const reset = () => {
    setName("");
    setPtype("openai");
    setProtocol("openai/v1");
    setTokensText("");
    setBaseUrl("");
    setPathPrefix("");
    setMappingsText("");
    setFailover(false);
    setFailoverModel("");
  };

  const submit = async () => {
    const nm = name.trim();
    if (!nm) {
      antd.message.error(tr("名称不能为空"));
      return;
    }
    const tokens = tokensText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      antd.message.error(tr("至少需要一个凭据"));
      return;
    }
    const rawConfigs: Record<string, unknown> = {};
    if (baseUrl.trim()) rawConfigs.openaiCustomUrl = baseUrl.trim();
    if (pathPrefix.trim() && pathPrefix.trim() !== "/v1") {
      rawConfigs.pathPrefix = pathPrefix.trim();
    }
    const mapping = parseMappings(mappingsText);
    if (Object.keys(mapping).length > 0) rawConfigs.modelMapping = mapping;
    const body: Record<string, unknown> = { name: nm, type: ptype, protocol, tokens };
    if (failover) {
      body.tokenFailoverConfig = {
        enabled: true,
        failureThreshold: 3,
        successThreshold: 2,
        healthCheckInterval: 3,
        healthCheckModel: failoverModel.trim(),
      };
    }
    if (Object.keys(rawConfigs).length > 0) body.rawConfigs = rawConfigs;
    setBusy(true);
    try {
      const res = await createGatewayAiProvider(body);
      if (res.available) {
        antd.message.success(tr("已创建提供商「{n}」", { n: nm }));
        reset();
        onCreated();
        onClose();
      } else {
        antd.message.error(res.detail || res.reason || tr("创建失败"));
      }
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("创建失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <antd.Modal
      title={tr("添加提供商")}
      open={open}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onOk={() => void submit()}
      okText={tr("创建")}
      cancelText={tr("取消")}
      confirmLoading={busy}
      width={560}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={LBL}>{tr("名称")}</div>
          <antd.Input
            value={name}
            onChange={(e: { target: { value: string } }) => setName(e.target.value)}
            placeholder="deepseek-cloud"
          />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={LBL}>{tr("类型")}</div>
            <antd.Select
              style={{ width: "100%" }}
              showSearch
              value={ptype}
              options={PROVIDER_TYPE_OPTIONS}
              onChange={(v: string) => setPtype(v)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={LBL}>{tr("协议")}</div>
            <antd.Select
              style={{ width: "100%" }}
              value={protocol}
              options={[
                { value: "openai/v1", label: "openai/v1" },
                { value: "original", label: "original" },
              ]}
              onChange={(v: string) => setProtocol(v)}
            />
          </div>
        </div>
        <div>
          <div style={LBL}>{tr("令牌（每行一个）")}</div>
          <antd.Input.TextArea
            rows={3}
            value={tokensText}
            onChange={(e: { target: { value: string } }) => setTokensText(e.target.value)}
            placeholder="sk-..."
          />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={LBL}>{tr("Base URL（可选）")}</div>
            <antd.Input
              value={baseUrl}
              onChange={(e: { target: { value: string } }) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com"
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={LBL}>{tr("路径前缀（可选）")}</div>
            <antd.Input
              value={pathPrefix}
              onChange={(e: { target: { value: string } }) => setPathPrefix(e.target.value)}
              placeholder="/v1"
            />
          </div>
        </div>
        <div>
          <div style={LBL}>{tr("模型映射（每行 pattern=目标模型，可选）")}</div>
          <antd.Input.TextArea
            rows={2}
            value={mappingsText}
            onChange={(e: { target: { value: string } }) => setMappingsText(e.target.value)}
            placeholder="deepseek-v4-flash=deepseek-chat"
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <antd.Switch checked={failover} onChange={(v: boolean) => setFailover(v)} />
          <span>{tr("令牌故障转移（可选）")}</span>
          {failover ? (
            <antd.Input
              style={{ width: 220 }}
              value={failoverModel}
              onChange={(e: { target: { value: string } }) => setFailoverModel(e.target.value)}
              placeholder={tr("健康检查模型（可选）")}
            />
          ) : null}
        </div>
      </div>
    </antd.Modal>
  );
}

interface UpstreamRow {
  provider: string;
  weight: number;
  mapping: string;
}

export function RouteCreateModal({
  open,
  onClose,
  onCreated,
  providerNames,
}: ModalProps & { providerNames: string[] }) {
  const tr = useT();
  const [name, setName] = React.useState("");
  const [pathValue, setPathValue] = React.useState("/");
  const [predsText, setPredsText] = React.useState("");
  const [rows, setRows] = React.useState<UpstreamRow[]>([
    { provider: "", weight: 100, mapping: "" },
  ]);
  const [authEnabled, setAuthEnabled] = React.useState(true);
  const [keyAuth, setKeyAuth] = React.useState(true);
  const [consumersText, setConsumersText] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const reset = () => {
    setName("");
    setPathValue("/");
    setPredsText("");
    setRows([{ provider: "", weight: 100, mapping: "" }]);
    setAuthEnabled(true);
    setKeyAuth(true);
    setConsumersText("");
  };

  const updateRow = (idx: number, patch: Partial<UpstreamRow>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const submit = async () => {
    const nm = name.trim();
    if (!nm) {
      antd.message.error(tr("名称不能为空"));
      return;
    }
    const ups = rows.filter((r) => r.provider.trim());
    if (ups.length === 0) {
      antd.message.error(tr("至少需要一个上游"));
      return;
    }
    if (
      ups.length > 1 &&
      ups.reduce((s, r) => s + (Number(r.weight) || 0), 0) !== 100
    ) {
      antd.message.error(tr("多个上游的权重总和必须为 100"));
      return;
    }
    const credTypes = authEnabled ? (keyAuth ? ["key-auth"] : []) : [];
    if (authEnabled && credTypes.length === 0) {
      antd.message.error(tr("认证启用时至少需要一种凭据类型"));
      return;
    }
    const consumers = consumersText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const body: Record<string, unknown> = {
      name: nm,
      pathPredicate: { matchType: "PRE", matchValue: pathValue.trim() || "/" },
      upstreams: ups.map((r) => ({
        provider: r.provider.trim(),
        weight: Number(r.weight) || 100,
        modelMapping: parseMappings(r.mapping),
      })),
      modelPredicates: parsePredicates(predsText),
      authConfig: {
        enabled: authEnabled,
        allowedCredentialTypes: credTypes,
        ...(consumers.length > 0 ? { allowedConsumers: consumers } : {}),
      },
    };
    setBusy(true);
    try {
      const res = await createGatewayAiRoute(body);
      if (res.available) {
        antd.message.success(tr("已创建路由「{n}」", { n: nm }));
        reset();
        onCreated();
        onClose();
      } else {
        antd.message.error(res.detail || res.reason || tr("创建失败"));
      }
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("创建失败"));
    } finally {
      setBusy(false);
    }
  };

  const providerOptions = providerNames.map((n) => ({ value: n }));

  return (
    <antd.Modal
      title={tr("添加路由")}
      open={open}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onOk={() => void submit()}
      okText={tr("创建")}
      cancelText={tr("取消")}
      confirmLoading={busy}
      width={640}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={LBL}>{tr("名称")}</div>
            <antd.Input
              value={name}
              onChange={(e: { target: { value: string } }) => setName(e.target.value)}
              placeholder="deepseek-route"
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={LBL}>{tr("路径匹配")}</div>
            <antd.Input
              value={pathValue}
              onChange={(e: { target: { value: string } }) => setPathValue(e.target.value)}
              placeholder="/"
            />
          </div>
        </div>
        <div>
          <div style={LBL}>{tr("请求模型匹配（每行 EQUAL:模型 / PRE:前缀，可选）")}</div>
          <antd.Input.TextArea
            rows={2}
            value={predsText}
            onChange={(e: { target: { value: string } }) => setPredsText(e.target.value)}
            placeholder={"EQUAL:deepseek-v4-flash\nPRE:qwen-"}
          />
        </div>
        <div>
          <div style={LBL}>{tr("上游")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((r, idx) => (
              <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <antd.AutoComplete
                  style={{ width: 210 }}
                  options={providerOptions}
                  value={r.provider}
                  onChange={(v: string) => updateRow(idx, { provider: v })}
                  placeholder={tr("提供商")}
                />
                <antd.InputNumber
                  style={{ width: 90 }}
                  min={1}
                  max={100}
                  value={r.weight}
                  onChange={(v: number | null) => updateRow(idx, { weight: Number(v) || 0 })}
                />
                <antd.Input
                  style={{ flex: 1 }}
                  value={r.mapping}
                  onChange={(e: { target: { value: string } }) => updateRow(idx, { mapping: e.target.value })}
                  placeholder={tr("模型映射 pattern=目标（可选）")}
                />
                <antd.Button
                  size="small"
                  danger
                  disabled={rows.length <= 1}
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== idx))}
                >
                  {tr("删除")}
                </antd.Button>
              </div>
            ))}
            <div>
              <antd.Button
                size="small"
                onClick={() => setRows((prev) => [...prev, { provider: "", weight: 100, mapping: "" }])}
              >
                {tr("添加上游")}
              </antd.Button>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <antd.Switch checked={authEnabled} onChange={(v: boolean) => setAuthEnabled(v)} />
          <span>{tr("启用认证")}</span>
          {authEnabled ? (
            <>
              <antd.Checkbox checked={keyAuth} onChange={(e: { target: { checked: boolean } }) => setKeyAuth(e.target.checked)}>
                Key Auth
              </antd.Checkbox>
              <antd.Input
                style={{ width: 240 }}
                value={consumersText}
                onChange={(e: { target: { value: string } }) => setConsumersText(e.target.value)}
                placeholder={tr("授权 Consumer（每行一个，可选）")}
              />
            </>
          ) : null}
        </div>
      </div>
    </antd.Modal>
  );
}

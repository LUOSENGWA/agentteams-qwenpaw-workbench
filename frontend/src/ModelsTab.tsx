// v0.5.0-beta.12.9（P7，罗总 9/18 ⑥「插件要加上和 dashboard 一样的模型
// 配置页面」）：模型网关配置页（插件版，只读 v1）。
//
// 数据面双源（与 dashboard A2「controller-first 只读降级」同语义）：
//   ① Higress Console 会话可用 → fetchGatewayAiRoutes/AiProviders 透传读
//      （alias 层完整：路由 predicate + 上游 modelMapping + providers）
//   ② 无会话 → fetchGatewayRouteCatalog（controller #1242 只读路由目录，
//      controller token 鉴权，L1-only）
//   ③ 旧 controller（404）→ 目录节隐藏 + 原因说明（版本门控，零报错）
//
// v1 只读：路由/提供商编辑（Console 写面透传）不在本版——写面依赖后端代理
// 白名单扩展，另排（P7b 待拍板）。页面价值 = 无 dashboard 时看模型网关
// 实况 + Console 会话失效时的只读兜底（与 dashboard models-section A2 同）。

import type * as ReactNS from "react";

import {
  fetchGatewayAiProviders,
  fetchGatewayAiRoutes,
  fetchGatewayRouteCatalog,
  type GatewayRouteCatalog,
} from "./api";
import { extractGatewayLists } from "./modelUnion";
import type { AiRouteLite, LlmProviderLite } from "./modelCatalog";
import { useThemeColors } from "./theme";
import { useT } from "./i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Source = "console" | "controller" | "none";

interface RouteRow {
  name: string;
  upstreams: string;
  aliases: string;
  /** P7b（9/19 全套抄 dashboard）：授权 consumer 与请求模型 alias 分列
   * （原先 controller 源把 allowedConsumers 填进 alias 列，语义错位）。 */
  consumers: string;
}

function routeRowOf(r: AiRouteLite): RouteRow {
  const ups = (r.upstreams || [])
    .map((u) => (u.weight != null ? `${u.provider}（${u.weight}%）` : u.provider))
    .join("、");
  // 装验反馈 9/19（P7）：preds 原先是 join("、") 后的字符串，下面
  // [...preds] spread 字符串 = 逐字符拆开（"d、e、p、s、k、-"）。
  // 拆成 predsArr（数组）+ 显示串两段，spread 用数组。
  const predsArr = (r.modelPredicates || []).map(
    (p) => `${p.matchType === "PRE" ? "前缀:" : ""}${String(p.matchValue)}`,
  );
  const preds = predsArr.join("、");
  const mappingKeys = (r.upstreams || [])
    .flatMap((u) => Object.keys(u.modelMapping ?? {}))
    .filter((k) => k && !k.includes("*"));
  const aliasSet = [...new Set([...mappingKeys, ...predsArr])];
  return {
    name: r.name,
    upstreams: ups || "—",
    aliases: aliasSet.join("、") || (preds ? "（按路由匹配）" : "—"),
    consumers: (r.allowedConsumers || [])
      .map((c) => c.replace(/^@/, ""))
      .join("、") || "—",
  };
}

function providerRowName(p: LlmProviderLite): string {
  const mapping = p.rawConfigs?.modelMapping as
    | Record<string, string>
    | undefined;
  const keys = mapping ? Object.keys(mapping).filter((k) => !k.includes("*")) : [];
  return keys.length ? `${p.name}（${keys.length} 映射）` : p.name;
}

export default function ModelsTab() {
  const t = useThemeColors();
  const tr = useT();
  const [loading, setLoading] = React.useState(false);
  const [source, setSource] = React.useState<Source>("none");
  const [consoleRoutes, setConsoleRoutes] = React.useState<AiRouteLite[]>([]);
  const [consoleProviders, setConsoleProviders] = React.useState<
    LlmProviderLite[]
  >([]);
  const [catalog, setCatalog] = React.useState<GatewayRouteCatalog | null>(null);
  const [note, setNote] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setNote("");
    try {
      const [routes, providers] = await Promise.all([
        fetchGatewayAiRoutes(),
        fetchGatewayAiProviders(),
      ]);
      if (routes.available && providers.available) {
        const { routesList, providersList } = extractGatewayLists(
          routes.data,
          providers.data,
        );
        setConsoleRoutes(routesList);
        setConsoleProviders(providersList);
        setSource("console");
        setCatalog(null);
        return;
      }
      // Console 会话不可用（token 模式 / 会话失效）→ controller 只读目录降级。
      const cat = await fetchGatewayRouteCatalog();
      setCatalog(cat);
      setSource("controller");
      setConsoleRoutes([]);
      setConsoleProviders([]);
      if (!cat.routes || cat.routes.length === 0) {
        setNote(tr("路由目录为空——检查 Higress 是否已配置 AI 路由"));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("403")) {
        // L2 会话：#1242 只读目录仅 L1 可读。
        setSource("none");
        setNote(tr("仅 L1 管理员可查看只读路由目录（当前会话无权限）"));
      } else if (msg.includes("404")) {
        // 旧 controller（#1242 未部署）/ Console 均不可用。
        setSource("none");
        setNote(
          tr("模型网关数据不可用——Console 会话未配置且 Controller 版本过旧（需含 #1242 路由目录端点）"),
        );
      } else {
        setSource("none");
        setNote(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [tr]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const routeRows: RouteRow[] =
    source === "console"
      ? consoleRoutes.map(routeRowOf)
      : (catalog?.routes || []).map((r) => ({
          name: r.name,
          upstreams: (r.upstreams || [])
            .map((u) =>
              u.weight != null ? `${u.provider}（${u.weight}%）` : u.provider,
            )
            .join("、") || "—",
          // controller 源（#1242 目录）无 predicate/modelMapping → alias 不可知。
          aliases: "—（目录源无 alias 数据）",
          consumers: (r.allowedConsumers || [])
            .map((c) => c.replace(/^@/, ""))
            .join("、") || "—",
        }));

  const routeColumns = [
    { title: tr("路由"), dataIndex: "name", key: "name" },
    {
      title:
        source === "controller" ? tr("上游提供商") : tr("上游提供商（权重）"),
      dataIndex: "upstreams",
      key: "upstreams",
    },
    {
      // P7a（9/19）：alias 逐字拆开 bug 修后，本列正常显示请求模型别名。
      title: tr("请求模型（alias）"),
      dataIndex: "aliases",
      key: "aliases",
    },
    { title: tr("授权 Consumer"), dataIndex: "consumers", key: "consumers" },
  ];

  return (
    <div style={{ padding: 16, maxWidth: 1000 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <antd.Typography.Title level={4} style={{ margin: 0 }}>
          {tr("模型网关配置")}
        </antd.Typography.Title>
        <antd.Tag color={source === "console" ? "blue" : "orange"}>
          {source === "console"
            ? tr("Higress Console（透传）")
            : source === "controller"
              ? tr("Controller 只读目录（#1242）")
              : tr("数据不可用")}
        </antd.Tag>
        <antd.Tag>{tr("只读")}</antd.Tag>
        <antd.Button size="small" onClick={() => void load()} loading={loading}>
          {tr("刷新")}
        </antd.Button>
      </div>

      <antd.Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message={tr("本页面为只读视图——路由/提供商编辑请使用 Higress Console 或 dashboard 模型管理面")}
      />

      {note ? (
        <antd.Alert
          type={source === "none" ? "warning" : "info"}
          showIcon
          style={{ marginBottom: 14 }}
          message={note}
        />
      ) : null}

      {loading ? (
        <div style={{ padding: 30 }}>
          <antd.Spin />
        </div>
      ) : source === "none" ? (
        <antd.Empty description={tr("暂无模型网关数据")} />
      ) : (
        <>
          <antd.Typography.Text strong style={{ display: "block", margin: "10px 0 6px" }}>
            {tr("AI 路由（{n}）", { n: routeRows.length })}
          </antd.Typography.Text>
          <antd.Table
            size="small"
            rowKey="name"
            columns={routeColumns}
            dataSource={routeRows}
            pagination={routeRows.length > 10 ? { pageSize: 10 } : false}
            locale={{ emptyText: tr("暂无 AI 路由") }}
          />
          {source === "console" ? (
            <>
              {/* P7b（9/19 全套抄 dashboard）：可请求模型（alias）全集——
                  路由 predicate/mapping 去重聚合，即 Worker 模型下拉的
                  「网关 alias」分组内容（dashboard 模型页同信息）。 */}
              {(() => {
                const all = [...new Set(routeRows.flatMap((r) =>
                  r.aliases
                    .split("、")
                    .map((a) => a.trim())
                    .filter((a) => a && a !== "（按路由匹配）"),
                ))].sort();
                if (all.length === 0) return null;
                return (
                  <>
                    <antd.Typography.Text
                      strong
                      style={{ display: "block", margin: "16px 0 6px" }}
                    >
                      {tr("可请求模型（alias 全集，{n}）", { n: all.length })}
                    </antd.Typography.Text>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {all.map((a) => (
                        <antd.Tag key={a} style={{ margin: 0, fontFamily: "monospace" }}>
                          {a}
                        </antd.Tag>
                      ))}
                    </div>
                  </>
                );
              })()}
              <antd.Typography.Text
                strong
                style={{ display: "block", margin: "16px 0 6px" }}
              >
                {tr("LLM Provider（{n}）", { n: consoleProviders.length })}
              </antd.Typography.Text>
              <antd.Table
                size="small"
                rowKey="name"
                columns={[
                  {
                    title: tr("Provider"),
                    key: "p",
                    render: (_: unknown, p: LlmProviderLite) => providerRowName(p),
                  },
                ]}
                dataSource={consoleProviders}
                pagination={consoleProviders.length > 10 ? { pageSize: 10 } : false}
                locale={{ emptyText: tr("暂无 Provider") }}
              />
            </>
          ) : null}
        </>
      )}
      {/* 主题引用保留（表格外框与页面底色一致）——防 t 未用告警。 */}
      <div style={{ display: "none", background: t.bg }} />
    </div>
  );
}

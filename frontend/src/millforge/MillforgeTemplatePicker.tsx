// 千锻模板选择（任务书 B3）——industry 单选 + domains 多选 + 可选整队
// 组合（INDEX teams，选中自动填 members 比例/domains）+ members 成员数 +
// lang。附紧凑浏览：四组 INDEX 条目点选 → 单文件只读预览
// （GET /millforge/packs/{pack}/file，原 TemplatesCard 能力内嵌保留）。

import type * as ReactNS from "react";

import { fetchMillforgePackFile } from "../api";
import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import type { MfCore } from "./useMillforgeCore";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface Props {
  core: MfCore;
  tr: TrFn;
  t: ThemeColors;
}

const SECTIONS: { key: "skeletons" | "industry" | "domain" | "fragments"; label: string }[] = [
  { key: "skeletons", label: "skeletons（骨架）" },
  { key: "industry", label: "industry（行业）" },
  { key: "domain", label: "domain（领域）" },
  { key: "fragments", label: "fragments（片段）" },
];

export default function MillforgeTemplatePicker({ core, tr, t }: Props) {
  const { spec, setSpec, pickCombo, comboWarning, setComboWarning, lang, setLang, index, pack } = core;

  const [browseSec, setBrowseSec] = React.useState<string>("industry");
  const [browseFile, setBrowseFile] = React.useState("");
  const [preview, setPreview] = React.useState<{ path: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState("");

  // pack/INDEX 变化 → 复位浏览选择。
  React.useEffect(() => {
    setBrowseFile("");
    setPreview(null);
    setPreviewError("");
  }, [pack, index]);

  const secEntries = index ? (index[browseSec as "skeletons" | "industry" | "domain" | "fragments"] || []) : [];
  const selEntry = secEntries.find((e) => e.file === browseFile) || null;

  React.useEffect(() => {
    if (!pack || !selEntry?.file) {
      setPreview(null);
      setPreviewError("");
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    setPreviewError("");
    fetchMillforgePackFile(pack, selEntry.file)
      .then((d) => {
        if (alive) setPreview({ path: d.path, content: d.content });
      })
      .catch((e) => {
        if (alive) setPreviewError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setPreviewLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack, selEntry?.file]);

  const members = spec.members || { leader: 1, workers: 2, critic: 0 };
  const total = (members.leader || 0) + (members.workers || 0) + (members.critic || 0);
  const setMember = (k: "leader" | "workers" | "critic", n: number | null) => {
    setSpec((prev) => ({
      ...prev,
      members: { leader: 1, workers: 2, critic: 0, ...prev.members, [k]: n ?? 0 },
    }));
  };

  // 行业 → 领域级联：已选 industry 时 domains 只显示该行业下的域；
  // 未选 industry 或 INDEX 无 industry 字段（旧包）→ 全显（诚实降级，不空列表）。
  const domainEntries = (index?.domain || []).filter((e) => e.id);
  const hasIndustryInfo = domainEntries.some((e) => e.industry);
  const cascadedDomains =
    spec.industry && hasIndustryInfo
      ? domainEntries.filter((e) => e.industry === spec.industry)
      : domainEntries;

  const onIndustryChange = (v: string | undefined) => {
    const next = v || "";
    setSpec((prev) => {
      // 级联：切换行业清掉不属于新行业的已选 domains。
      let domains = prev.domains || [];
      if (next && hasIndustryInfo) {
        const belonging = new Set(
          domainEntries.filter((e) => e.industry === next).map((e) => e.id),
        );
        domains = domains.filter((d) => belonging.has(d));
      }
      return { ...prev, industry: next, domains };
    });
    if (comboWarning) setComboWarning("");
  };

  const onDomainsChange = (v: string[]) => {
    setSpec((prev) => ({ ...prev, domains: v }));
    if (comboWarning) setComboWarning("");
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {/* 整队组合（可选——选中自动填 members 比例/domains） */}
      {index && index.teams.length > 0 ? (
        <>
          <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
            {tr("整队组合（可选，选中自动填成员比例/领域）")}
          </div>
          <antd.Select
            size="small"
            allowClear
            style={{ width: "100%" }}
            placeholder={tr("不选 = 按下方 industry/domains/members 组装")}
            value={spec.team_combo || undefined}
            onChange={(v: string | undefined) => pickCombo(v || "")}
            options={index.teams.map((c) => ({
              value: c.id,
              label: `${c.name || c.id}（${c.industry || "—"} · L${c.members.leader || "?"}/W${c.members.workers || "?"}/C${c.members.critic || "?"}${c.experimental === "true" || c.source === "llm" ? ` · ${tr("实验")}` : ""}）`,
            }))}
          />
          {comboWarning ? (
            <antd.Alert type="warning" showIcon message={comboWarning} />
          ) : null}
        </>
      ) : null}

      {/* industry 单选 + domains 多选（级联：domains 只显示所选 industry 下的域） */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px", display: "grid", gap: 4 }}>
          <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
            {tr("行业（industry，单选）")}
          </div>
          <antd.Select
            size="small"
            allowClear
            style={{ width: "100%" }}
            placeholder={tr("不选 = 通用")}
            value={spec.industry || undefined}
            onChange={onIndustryChange}
            options={(index?.industry || [])
              .filter((e) => e.id)
              .map((e) => ({ value: e.id, label: e.id }))}
          />
        </div>
        <div style={{ flex: "1 1 200px", display: "grid", gap: 4 }}>
          <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
            {tr("领域（domains，多选）")}
          </div>
          <antd.Select
            size="small"
            mode="multiple"
            allowClear
            style={{ width: "100%" }}
            placeholder={tr("不选 = 不附加领域片段")}
            value={spec.domains || []}
            onChange={onDomainsChange}
            options={cascadedDomains.map((e) => ({ value: e.id, label: e.id }))}
          />
        </div>
      </div>

      {/* members 成员数 + lang */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
          {tr("成员（leader/workers/critic）")}
        </span>
        <antd.InputNumber
          size="small"
          min={1}
          max={8}
          value={members.leader ?? 1}
          onChange={(v: number | null) => setMember("leader", v)}
          addonBefore={tr("Leader")}
          style={{ width: 130 }}
        />
        <antd.InputNumber
          size="small"
          min={0}
          max={8}
          value={members.workers ?? 2}
          onChange={(v: number | null) => setMember("workers", v)}
          addonBefore={tr("Worker")}
          style={{ width: 130 }}
        />
        <antd.InputNumber
          size="small"
          min={0}
          max={8}
          value={members.critic ?? 0}
          onChange={(v: number | null) => setMember("critic", v)}
          addonBefore={tr("Critic")}
          style={{ width: 130 }}
        />
        <span style={{ fontSize: 11, color: total >= 2 && total <= 8 ? t.textSecondary : "#f5222d" }}>
          {total >= 2 && total <= 8 ? tr("合计 {n} 个角色", { n: total }) : tr("角色总数须 2-8")}
        </span>
        <div style={{ flex: 1 }} />
        <antd.Segmented
          size="small"
          value={lang}
          onChange={(v: unknown) => setLang(v as "zh" | "en")}
          options={[
            { label: "中文", value: "zh" },
            { label: "EN", value: "en" },
          ]}
        />
      </div>

      {/* 模板浏览 + 单文件只读预览（原 TemplatesCard 能力内嵌保留） */}
      <antd.Collapse
        ghost
        size="small"
        items={[
          {
            key: "browse",
            label: <span style={{ fontSize: 12 }}>{tr("浏览模板条目（只读预览）")}</span>,
            children: (
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <antd.Select
                    size="small"
                    style={{ width: 170 }}
                    value={browseSec}
                    onChange={(v: string) => {
                      setBrowseSec(v);
                      setBrowseFile("");
                    }}
                    options={SECTIONS.map((s) => ({ value: s.key, label: tr(s.label) }))}
                  />
                  <antd.Select
                    size="small"
                    style={{ flex: "1 1 220px" }}
                    allowClear
                    placeholder={tr("选择条目查看文件预览")}
                    value={selEntry ? (selEntry.id || selEntry.file) : undefined}
                    onChange={(v: string | undefined) => setBrowseFile(v || "")}
                    options={secEntries
                      .filter((e) => e.file)
                      .map((e) => ({ value: e.file, label: e.id || e.file }))}
                  />
                </div>
                {previewError ? (
                  <antd.Alert type="error" showIcon message={tr("读取模板文件失败")} description={<span style={{ fontSize: 11, fontFamily: "monospace" }}>{previewError}</span>} />
                ) : previewLoading ? (
                  <antd.Spin size="small" />
                ) : preview ? (
                  <pre
                    style={{
                      margin: 0,
                      padding: 8,
                      background: t.mode === "dark" ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
                      border: `1px solid ${t.border}`,
                      borderRadius: 6,
                      fontFamily: "monospace",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 320,
                      overflow: "auto",
                      color: t.text,
                    }}
                  >
                    {preview.content}
                  </pre>
                ) : (
                  <div style={{ color: t.textSecondary, fontSize: 12 }}>
                    {tr("选择左侧条目查看文件预览（只读）")}
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

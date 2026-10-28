// 千锻自定义团队（任务书 D）——描述需求表单（成员/任务类型/运行时/最痛
// 3 问题/团队名）→「生成提示词」（POST /millforge/prompt）+ 复制按钮；
// 粘贴 LLM 返回 JSON →「校验」（POST /millforge/parse-team-json）→ 字段
// 级错误列表；校验通过 →「编译」（team_json 路径，同 B4 预览/注入）。

import type * as ReactNS from "react";

import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import { CheckIcon } from "../components/icons";
import type { MfCore } from "./useMillforgeCore";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface Props {
  core: MfCore;
  /** 编译 team 字段兜底（表单团队名留空时用现有团队 CR 名）。 */
  fallbackTeamName: string;
  tr: TrFn;
  t: ThemeColors;
}

export default function MillforgeCustomTab({ core, fallbackTeamName, tr, t }: Props) {
  const { custom, setCustom, genPrompt, parseJson, compileWithTeamJson, compiling, pack } = core;

  const set = (patch: Partial<MfCore["custom"]>) => setCustom((c) => ({ ...c, ...patch }));

  // 校验结果派生（可选字段收敛到局部常量，防 undefined 渗透）。
  const parseTeam = custom.parseResult?.ok ? custom.parseResult.team : undefined;
  const parseErrors =
    custom.parseResult && !custom.parseResult.ok ? custom.parseResult.errors || [] : [];
  const nRoles = parseTeam && Array.isArray(parseTeam.roles) ? parseTeam.roles.length : 0;

  const copyPrompt = () => {
    const done = () => antd.message.success(tr("已复制"));
    try {
      void navigator.clipboard.writeText(custom.prompt).then(done).catch(done);
    } catch {
      done();
    }
  };

  const teamName = (custom.team_name || "").trim() || fallbackTeamName || "team";

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {/* 描述需求表单 */}
      <div style={{ display: "grid", gap: 4 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
          <div style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>{tr("成员（成员/任务类型/运行时 之一）")}</span>
            <antd.Input.TextArea
              size="small"
              rows={2}
              placeholder={tr("例：3 个前端工程师 + 1 个测试 + 1 个架构评审")}
              value={custom.members}
              onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) => set({ members: e.target.value })}
            />
          </div>
          <div style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>{tr("任务类型（members 缺省时必填）")}</span>
            <antd.Input.TextArea
              size="small"
              rows={2}
              placeholder={tr("例：React 组件开发、接口联调、回归测试")}
              value={custom.task_types}
              onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) => set({ task_types: e.target.value })}
            />
          </div>
          <div style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>{tr("运行时（选填）")}</span>
            <antd.Input
              size="small"
              placeholder="qwenpaw"
              value={custom.runtime}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => set({ runtime: e.target.value })}
            />
          </div>
          <div style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>{tr("团队名（选填）")}</span>
            <antd.Input
              size="small"
              placeholder={tr("留空用现有团队名")}
              value={custom.team_name}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => set({ team_name: e.target.value })}
            />
          </div>
        </div>
        <div style={{ display: "grid", gap: 3 }}>
          <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>{tr("最痛的 3 个问题（必填）")}</span>
          <antd.Input.TextArea
            size="small"
            rows={3}
            placeholder={tr("例：1) 联调环境不稳 2) 回归全靠人 3) 架构决策没记录")}
            value={custom.pains}
            onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) => set({ pains: e.target.value })}
          />
        </div>
      </div>

      {/* 生成提示词 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <antd.Button
          size="small"
          type="primary"
          loading={custom.promptBusy}
          disabled={!pack}
          onClick={() => void genPrompt()}
        >
          {tr("生成提示词")}
        </antd.Button>
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("把提示词发给 LLM，将其返回的 JSON 粘回下方「校验」")}
        </span>
      </div>
      {custom.promptError ? (
        <antd.Alert type="error" showIcon message={tr("生成提示词失败")} description={<span style={{ fontSize: 11, fontFamily: "monospace" }}>{custom.promptError}</span>} />
      ) : null}
      {custom.prompt ? (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>{tr("提示词（发给 LLM）")}</span>
            <antd.Button size="small" onClick={copyPrompt}>
              {tr("复制")}
            </antd.Button>
          </div>
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
              maxHeight: 260,
              overflow: "auto",
              color: t.text,
            }}
          >
            {custom.prompt}
          </pre>
        </div>
      ) : null}

      {/* LLM JSON 粘贴 + 校验 */}
      <div style={{ display: "grid", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
            {tr("LLM 返回的 JSON（粘贴）")}
          </span>
          <antd.Button
            size="small"
            loading={custom.parseBusy}
            disabled={!pack}
            onClick={() => void parseJson()}
          >
            {tr("校验")}
          </antd.Button>
          {parseTeam ? (
            <antd.Button
              size="small"
              type="primary"
              loading={compiling}
              disabled={!pack}
              onClick={() => void compileWithTeamJson(teamName, parseTeam)}
            >
              {tr("编译（team_json）")}
            </antd.Button>
          ) : null}
        </div>
        <antd.Input.TextArea
          size="small"
          rows={5}
          placeholder={tr("粘贴 LLM 返回的 JSON 全文")}
          value={custom.jsonText}
          onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) => set({ jsonText: e.target.value, parseError: "", parseResult: null })}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
        {custom.parseError ? (
          <antd.Alert type="error" showIcon message={tr("校验失败")} description={<span style={{ fontSize: 11, fontFamily: "monospace" }}>{custom.parseError}</span>} />
        ) : null}
        {/* 字段级错误 */}
        {parseErrors.length ? (
          <antd.Alert
            type="error"
            showIcon
            message={tr("校验未通过（{n} 处）", { n: parseErrors.length })}
            description={
              <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11, fontFamily: "monospace" }}>
                {parseErrors.map((er, i) => (
                  <li key={`${er.path}-${i}`} style={{ color: "#f5222d" }}>
                    {er.path} — {er.message}
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
        {parseTeam ? (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "#52c41a" }}>
            <CheckIcon size={11} />
            {tr("校验通过（{n} 个角色）——点「编译（team_json）」进入预览", { n: nRoles })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

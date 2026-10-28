// 千锻源切换 + pack 选择（任务书 A + B2）——内嵌建队表单/「千锻注入」
// 对话框共用。Segmented（GitHub/GitCode/自定义，自定义才显 URL 输入）+
// 派生 resolved_url + 「导入 / 更新」（POST /millforge/import，ref 默认
// main）；切换即 PUT /millforge/source 持久化；无 pack → 就地引导导入。

import type * as ReactNS from "react";

import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import { fmtRfc3339 } from "../components/WorkerManageShared";
import type { MfCore } from "./useMillforgeCore";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface Props {
  core: MfCore;
  tr: TrFn;
  t: ThemeColors;
}

export default function MillforgeSourcePack({ core, tr, t }: Props) {
  const {
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
    packs,
    packsLoading,
    packsError,
    pack,
    setPack,
    activePack,
  } = core;

  // 文本输入本地草稿（失焦/回车才 PUT——避免逐键持久化）。
  const [repoDraft, setRepoDraft] = React.useState("");
  const [urlDraft, setUrlDraft] = React.useState("");
  React.useEffect(() => {
    setRepoDraft(source?.repo || "");
  }, [source?.repo]);
  React.useEffect(() => {
    setUrlDraft(source?.custom_url || "");
  }, [source?.custom_url]);

  const hasPack = packs.length > 0;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {/* 源行：Segmented + repo/URL + resolved_url */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <antd.Segmented
          size="small"
          value={seg}
          onChange={(v: unknown) => changeSeg(v as "github" | "gitcode" | "custom")}
          options={[
            { label: tr("GitHub"), value: "github" },
            { label: tr("GitCode"), value: "gitcode" },
            { label: tr("自定义"), value: "custom" },
          ]}
        />
        {seg === "custom" ? (
          <antd.Input
            size="small"
            style={{ flex: "2 1 280px" }}
            placeholder={tr("自定义仓库 URL（https）")}
            value={urlDraft}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setUrlDraft(e.target.value)}
            onBlur={() => {
              if (urlDraft.trim() !== (source?.custom_url || "")) persistCustomUrl(urlDraft.trim());
            }}
            onPressEnter={(e: ReactNS.KeyboardEvent<HTMLInputElement>) => {
              const el = e.currentTarget;
              el.blur();
            }}
          />
        ) : (
          <antd.Input
            size="small"
            style={{ flex: "2 1 280px" }}
            placeholder={tr("repo（org/repo）")}
            value={repoDraft}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setRepoDraft(e.target.value)}
            onBlur={() => {
              if (repoDraft.trim() !== (source?.repo || "")) persistRepo(repoDraft.trim());
            }}
            onPressEnter={(e: ReactNS.KeyboardEvent<HTMLInputElement>) => {
              const el = e.currentTarget;
              el.blur();
            }}
          />
        )}
        <antd.Input
          size="small"
          style={{ width: 120 }}
          placeholder={tr("分支 / Tag（ref）")}
          value={ref}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setRef(e.target.value)}
        />
        <antd.Button size="small" type="primary" loading={importing} onClick={() => void doImport()}>
          {hasPack ? tr("更新") : tr("导入")}
        </antd.Button>
      </div>
      {source?.resolved_url ? (
        <div style={{ fontSize: 11, color: t.textSecondary, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {tr("派生 URL")}：{source.resolved_url}
        </div>
      ) : null}
      {sourceError ? (
        <antd.Alert type="error" showIcon message={tr("源配置失败")} description={<span style={{ fontSize: 12, fontFamily: "monospace" }}>{sourceError}</span>} />
      ) : null}
      {importMsg ? (
        <antd.Alert type={importMsg.ok ? "success" : "error"} showIcon message={importMsg.text} />
      ) : null}
      {packsError ? (
        <antd.Alert type="error" showIcon message={tr("模板包列表加载失败")} description={<span style={{ fontSize: 12, fontFamily: "monospace" }}>{packsError}</span>} />
      ) : null}

      {/* pack 选择（无 pack → 就地引导导入） */}
      {hasPack ? (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
            {tr("模板包（pack）")}
          </div>
          <antd.Select
            size="small"
            style={{ width: "100%" }}
            value={pack || undefined}
            placeholder={tr("选择已导入的模板包")}
            onChange={(v: string) => setPack(v)}
            options={packs.map((p) => ({
              value: p.pack,
              label: `${p.pack}${p.meta?.commit ? ` · ${String(p.meta.commit).slice(0, 7)}` : ""}${p.parse_error ? `（${tr("INDEX 解析失败")}）` : ""}`,
            }))}
          />
          {activePack ? (
            <div style={{ fontSize: 11, color: t.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {activePack.meta?.url ? `${activePack.meta.url}${activePack.meta.ref ? ` · ref ${activePack.meta.ref}` : ""}` : ""}
              {activePack.meta?.imported_at ? ` · ${tr("导入时间")} ${fmtRfc3339(activePack.meta.imported_at)}` : ""}
              {activePack.parse_error ? ` · ${tr("INDEX 解析失败")}: ${activePack.parse_error}` : ""}
            </div>
          ) : null}
        </div>
      ) : (
        !packsLoading ? (
          <antd.Alert
            type="info"
            showIcon
            message={tr("尚未导入模板包——选择源（GitHub / GitCode / 自定义）后点「导入」")}
          />
        ) : null
      )}
    </div>
  );
}

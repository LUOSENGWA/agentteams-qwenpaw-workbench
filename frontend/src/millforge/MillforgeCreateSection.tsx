// 建队表单「千锻模板（可选）」折叠区（任务书 B）——默认收起；
// 展开 = 启用（16.11：头内冗余 Switch 已删，收起 = enabled=false 不参与建队）：
// 源切换（A）→ 模板选择（B3）→ 注入方式（core 技能默认开，C）→ 可选编译
// 预览（B4）→ 注入面板（B5，embedded：无独立注入按钮，提交建队时自动
// 编译 → 注入 → 建队）。

import type * as ReactNS from "react";

import type { WorkerInfo } from "../api";
import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import MillforgeSourcePack from "./MillforgeSourcePack";
import MillforgeTemplatePicker from "./MillforgeTemplatePicker";
import MillforgeBuildPreview from "./MillforgeBuildPreview";
import MillforgeInjectPanel from "./MillforgeInjectPanel";
import type { MfCreate } from "./useMillforgeCreate";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface Props {
  mf: MfCreate;
  workers: WorkerInfo[];
  /** 建队表单团队 ID（inject/compile 的 team 字段；空 = 按钮禁用）。 */
  teamName: string;
  tr: TrFn;
  t: ThemeColors;
}

export default function MillforgeCreateSection({ mf, workers, teamName, tr, t }: Props) {
  const { core, enabled, setEnabled } = mf;
  const name = teamName.trim();

  return (
    <antd.Collapse
      ghost
      size="small"
      activeKey={enabled ? ["mf"] : []}
      onChange={(keys: string[] | string) => {
        const k = Array.isArray(keys) ? keys : [keys];
        setEnabled(k.includes("mf"));
      }}
      items={[
        {
          key: "mf",
          label: (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{tr("千锻模板（可选）")}</span>
              <span style={{ fontSize: 11, color: t.textSecondary }}>
                {tr("展开后：选源 → 选模板 →（可选）编译预览 → 选注入方式")}
              </span>
              {enabled ? (
                <antd.Tag color="blue" style={{ marginInlineEnd: 0 }}>{tr("已启用")}</antd.Tag>
              ) : null}
            </span>
          ),
          children: (
            <div style={{ display: "grid", gap: 8 }}>
              <MillforgeSourcePack core={core} tr={tr} t={t} />
              <MillforgeTemplatePicker core={core} tr={tr} t={t} />
              {/* 注入方式——core 技能（默认开；编译前即可见，C） */}
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                  {tr("注入方式（提交建队时自动执行）")}
                </div>
                <antd.Space size={4}>
                  <antd.Checkbox
                    checked={core.coreSkill}
                    onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                      core.setCoreSkill(e.target.checked)
                    }
                  />
                  <span style={{ fontSize: 12 }}>{tr("core 技能打包（millforge-core，scope=team）")}</span>
                </antd.Space>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <antd.Button
                    size="small"
                    type="primary"
                    loading={core.compiling}
                    disabled={!core.pack || !name}
                    onClick={() => void core.compileWithTemplate(name)}
                  >
                    {tr("编译预览")}
                  </antd.Button>
                  <span style={{ fontSize: 11, color: t.textSecondary }}>
                    {tr("可不预览——提交建队时自动编译 → 注入 → 创建")}
                  </span>
                </div>
              </div>
              {core.compileError ? (
                <antd.Alert
                  type="error"
                  showIcon
                  message={tr("编译失败")}
                  description={
                    <pre
                      style={{
                        margin: 0,
                        fontSize: 11,
                        fontFamily: "monospace",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                        maxHeight: 180,
                        overflow: "auto",
                      }}
                    >
                      {core.compileError}
                    </pre>
                  }
                />
              ) : null}
              {core.build ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <MillforgeBuildPreview build={core.build} tr={tr} t={t} />
                  <MillforgeInjectPanel
                    core={core}
                    workers={workers}
                    teamName={name}
                    embedded
                    tr={tr}
                    t={t}
                  />
                </div>
              ) : null}
            </div>
          ),
        },
      ]}
    />
  );
}

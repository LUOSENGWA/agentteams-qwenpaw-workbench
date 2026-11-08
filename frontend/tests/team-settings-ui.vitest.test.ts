/**
 * 团队设置 UI 改造（折叠分区 / 大触控按钮 / SVG 图标 / 竖屏适配）静态门。
 *
 * 渲染环境限制：本仓 vitest = node 环境，未装 jsdom / @testing-library
 * （本单禁装依赖）；CrdCfgForm 需要 window.QwenPaw.host 注入（真 React +
 * antd）+ 域层取数，静态渲染收益低、桩维护成本高。沿用
 * manage-checkpoint-card / m2-modules 先例做源码级断言：锁定本次改造的
 * 几何契约（折叠默认态 / 按钮高度与图标 / 窄屏分支），防回退到
 * 「散落灰字 + small 按钮 + 固定 780/420/240 宽度」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (rel: string): string =>
  readFileSync(join(process.cwd(), "src", rel), "utf8");

const icons = src("components/icons.tsx");
const cfg = src("crdmanage/CrdCfgModal.tsx");
const pane = src("manage/TeamSettingsPane.tsx");

describe("PlusIcon（按钮新增图标）", () => {
  it("以 24 网格 stroke 图标导出，路径走 currentColor", () => {
    const m = icons.match(/export const PlusIcon = mkIcon\(([\s\S]*?)\n\);/);
    expect(m, "PlusIcon 未导出（mkIcon 工厂）").not.toBeNull();
    const body = m![1];
    expect(body).toContain('d="M12 5.5v13M5.5 12h13"');
    expect(body).toContain('stroke="currentColor"');
  });

  it("两处「添加/加入」按钮都用 PlusIcon，不再用全角「＋」字符", () => {
    expect(cfg).toMatch(/icon=\{<PlusIcon size=\{16\} \/>\}[\s\S]{0,300}添加 Worker/);
    expect(pane).toMatch(/icon=\{<PlusIcon size=\{15\} \/>\}[\s\S]{0,300}加入本团队/);
    expect(cfg).not.toContain("＋");
    expect(pane).not.toContain("＋");
  });
});

describe("折叠分区（团队设置表单）", () => {
  it("默认展开 基本信息 / LLM 调优 / 团队成员，团队技能默认收起", () => {
    const m = cfg.match(/export const CFG_SECTIONS_OPEN[^=]*=\s*\[([^\]]*)\]/);
    expect(m, "CFG_SECTIONS_OPEN 未导出").not.toBeNull();
    const keys = m![1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    expect(keys).toEqual(["basic", "llm", "members"]);
    // 分区键顺序 = 渲染顺序（技能区殿后且不在默认展开集合里）。
    const keysDecl = cfg.match(/export const CFG_SECTION_KEYS = \[([^\]]*)\]/);
    expect(keysDecl![1].replace(/[",]/g, " ").trim().split(/\s+/)).toEqual([
      "basic",
      "llm",
      "members",
      "skills",
    ]);
  });

  it("四段按 基本信息 → LLM 调优 → 团队成员 → 团队技能 顺序渲染", () => {
    expect(cfg).toContain("defaultActiveKey={CFG_SECTIONS_OPEN}");
    const order = ["basic", "llm", "members", "skills"].map((k) =>
      cfg.indexOf(`key: "${k}"`),
    );
    expect(order.every((i) => i >= 0), "分区键缺失").toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("分区头 minHeight 48 / 分隔线 / ghost（不再套 Card 边框阴影）", () => {
    expect(cfg).toMatch(
      /minHeight: 48,\s*padding: narrow \? "10px 12px" : "12px 10px"/,
    );
    expect(cfg).toContain("borderTop: i === 0 ? undefined : `1px solid ${t.border}`");
    expect(cfg).toMatch(/<antd\.Collapse\s+ghost/);
    expect(cfg).not.toMatch(/<antd\.Card/);
  });

  it("标题图标：基本信息 TeamIcon / LLM 调优 BrainIcon / 成员 UsersIcon / 技能 BrickIcon 17", () => {
    expect(cfg).toMatch(/icon=\{<TeamIcon size=\{15\} \/>\}[\s\S]{0,120}基本信息/);
    expect(cfg).toMatch(/icon=\{<BrainIcon size=\{15\} \/>\}[\s\S]{0,120}LLM 调优/);
    expect(cfg).toMatch(/icon=\{<UsersIcon size=\{15\} \/>\}[\s\S]{0,120}团队成员/);
    expect(cfg).toMatch(/icon=\{<BrickIcon size=\{17\} \/>\}[\s\S]{0,120}团队技能/);
  });

  it("成员区标题带人数徽标，原漂浮灰字收进副标题", () => {
    expect(cfg).toContain('badge={tr("{n} 人", { n: cfgRows.length })}');
    expect(cfg).toContain('hint={tr("保存 = 全量替换成员列表")}');
  });
});

describe("技能中心分区", () => {
  it("容器 maxHeight min(460px, 60vh) + padding 8 + 内滚动", () => {
    expect(cfg).toContain('maxHeight: "min(460px, 60vh)"');
    const i = cfg.indexOf('maxHeight: "min(460px, 60vh)"');
    const around = cfg.slice(i, i + 220);
    expect(around).toContain("overflowY: \"auto\"");
    expect(around).toContain("padding: 8");
    expect(cfg).toContain("<SkillCenter onlyTeam={cfgTeam.name} />");
  });
});

describe("按钮几何（≥44 触控目标 + SVG 图标）", () => {
  it("页面保存 = 48 高 / 104 宽 / 14 号字 / CheckIcon 16", () => {
    expect(pane).toMatch(
      /icon=\{<CheckIcon size=\{16\} \/>\}[\s\S]{0,160}minHeight: 48, minWidth: 104, fontSize: 14/,
    );
  });

  it("行内「改模型」与批量「设置模型」= 44 高 / EditIcon 15", () => {
    expect(cfg).toMatch(/icon=\{<EditIcon size=\{15\} \/>\}[\s\S]{0,400}改模型/);
    expect(cfg).toMatch(/icon=\{<EditIcon size=\{15\} \/>\}[\s\S]{0,400}设置模型/);
    expect(cfg).toContain("minHeight: 44, flexShrink: 0, whiteSpace: \"nowrap\"");
    // 旧文案「编辑」「设置」已不存在（避免 small 按钮回潮）。
    expect(cfg).not.toContain('tr("编辑")');
    expect(cfg).not.toContain('tr("设置")');
  });

  it("添加 Worker / 加入本团队 = 44 高", () => {
    expect(cfg).toMatch(/icon=\{<PlusIcon size=\{16\} \/>\}\s*style=\{\{ minHeight: 44 \}\}/);
    expect(pane).toMatch(
      /icon=\{<PlusIcon size=\{15\} \/>\}\s*style=\{\{ minHeight: 44, whiteSpace: "nowrap" \}\}/,
    );
  });

  it("危险区删除团队 = 48 高 / TrashIcon 16 / 13.5 号字", () => {
    expect(pane).toMatch(
      /icon=\{<TrashIcon size=\{16\} \/>\}[\s\S]{0,160}minHeight: 48,\s*justifyContent: "flex-start",\s*fontSize: 13\.5/,
    );
  });

  it("「打开 Worker 模型设置」= 44 高 / SettingsIcon 16", () => {
    expect(pane).toMatch(/icon=\{<SettingsIcon size=\{16\} \/>\}[\s\S]{0,200}打开 Worker 模型设置/);
  });

  it("配置团队弹窗 footer 取消/保存 = 44 高，保存带 CheckIcon", () => {
    expect(cfg).toMatch(/footer=\{[\s\S]{0,200}minHeight: 44/);
    expect(cfg).toMatch(
      /type="primary"\s*loading=\{cfgBusy\}\s*icon=\{<CheckIcon size=\{16\} \/>\}/,
    );
  });
});

describe("竖屏 / 触屏适配", () => {
  it("表单与页面外壳都按 useWbViewport().narrow 分流", () => {
    expect(cfg).toMatch(/const \{ narrow \} = useWbViewport\(\)/);
    expect(pane).toMatch(/const \{ narrow \} = useWbViewport\(\)/);
  });

  it("批量模型网格：窄屏单列、宽屏两列自适应", () => {
    expect(cfg).toMatch(
      /gridTemplateColumns: narrow\s*\?\s*"1fr"\s*:\s*"repeat\(auto-fit, minmax\(min\(220px, 100%\), 1fr\)\)"/,
    );
  });

  it("模型摘要/输入不再钉死 240 / 420（窄屏 100%）", () => {
    expect(cfg).toContain('maxWidth: narrow ? "100%" : 240');
    expect(cfg).toContain('maxWidth: narrow ? "100%" : 420');
    // 成员行摘要与批量格摘要各自的基础宽度（按钮不挤压 → flexShrink 0）。
    expect(cfg).toContain('flex="1 1 180px"');
    expect(cfg).toContain('flex="1 1 140px"');
  });

  it("成员行可换行（窄屏下摘要与按钮不互相挤压）", () => {
    expect(cfg).toMatch(/flexWrap: "wrap",\s*minWidth: 0/);
  });

  it("配置团队弹窗宽度跟随视口，窄屏贴顶", () => {
    expect(cfg).toContain('width="min(780px, calc(100vw - 24px))"');
    expect(cfg).toMatch(/top: narrow \? 8 : 48/);
    expect(cfg).toContain('maxWidth: "calc(100vw - 12px)"');
  });

  it("团队设置外层 padding 窄屏 4px 2px 12px", () => {
    expect(pane).toContain('padding: narrow ? "4px 2px 12px" : "4px 4px 12px"');
  });
});

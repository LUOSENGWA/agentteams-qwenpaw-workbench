// WorkbenchPage 拆分模块——共享常量/工具组件/主样式。
// 自 WorkbenchPage 单体原样搬移（技术债批次 D3b）；逻辑零改动，
// 壳持有的 React state 经 ctx 传入，标识符保持原名。

import {
  requestJson,
  type L3RoomResult,
  type SelfCheckResult,
  type WorkbenchConfig,
} from "./api";
import { NARROW_MAX_W } from "./WbViewportContext";
import { useThemeColors } from "./theme";
import { useT } from "./i18n";
import { CheckIcon, CloseIcon, WarnIcon, BulbIcon } from "./components/icons";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const { message } = antd;

export const PRIMARY = "var(--app-accent, #FF7F16)"; // 品牌主色

function StatusIcon({ ok, warn }: { ok: boolean; warn?: boolean }) {
  // 14.34：warn=预期态（结构性 401 等，非故障）——琥珀 ⚠️，
  // 不再红 ❌（此前 level-1 管理员的 L2 恒 401 显红叉，用户误读
  // 成密码错反复重填）。
  if (warn)
    return (
      <span style={{ color: "#faad14", display: "inline-flex" }}>
        <WarnIcon size={14} />
      </span>
    );
  return (
    <span style={{ color: ok ? "#52c41a" : "#ff4d4f", display: "inline-flex" }}>
      {ok ? <CheckIcon size={14} /> : <CloseIcon size={14} />}
    </span>
  );
}

function CheckList({ result }: { result: SelfCheckResult | null }) {
  const t = useThemeColors(); 
  if (!result) return null;
  const levels: SelfCheckResult[] = result.levels ? result.levels : [result];
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {levels.map((lv, i) => (
        <div
          key={`${lv.level}-${i}`}
          style={{
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            padding: "12px 16px",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            <StatusIcon ok={lv.ok} /> {lv.level}
          </div>
          {(lv.checks || []).map((c, j) => (
            <div
              key={`${c.name}-${j}`}
              style={{
                display: "grid",
                gridTemplateColumns: "24px 1fr",
                gap: 4,
                padding: "4px 0",
                fontSize: 13,
              }}
            >
              <StatusIcon ok={c.ok} warn={c.warn} />
              <div>
                <span style={{ fontWeight: 600 }}>{c.name}</span>
                {c.detail ? (
                  <span style={{ color: "#666", marginLeft: 8 }}>{c.detail}</span>
                ) : null}
                {c.hint ? (
                  <div style={{ color: "#fa8c16", fontSize: 12, marginTop: 2 }}>
                    <BulbIcon size={12} style={{ verticalAlign: "-1px" }} /> {c.hint}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RoomResultTable({ rooms }: { rooms: L3RoomResult[] }) {
  const tr = useT();
  const t = useThemeColors(); 
  if (!rooms || rooms.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 700 }}>房间实测结果</div>
      {rooms.map((r) => (
        <div
          key={r.room_id}
          style={{
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            padding: "10px 14px",
            display: "grid",
            gap: 6,
            fontSize: 13,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <StatusIcon ok={r.ping_ok && r.reply?.ok} />
            <span style={{ fontWeight: 600, wordBreak: "break-all" }}>
              {r.room_id}
            </span>
            {r.members != null ? (
              <antd.Tag style={{ margin: 0 }}>{r.members} 人</antd.Tag>
            ) : null}
            <antd.Tag color={r.ping_ok ? "green" : "red"} style={{ margin: 0 }}>
              发送 {r.ping_ok ? <CheckIcon size={11} style={{ verticalAlign: "-1px" }} /> : <CloseIcon size={11} style={{ verticalAlign: "-1px" }} />}
            </antd.Tag>
            <antd.Tag color={r.reply?.ok ? "green" : "orange"} style={{ margin: 0 }}>
              回复 {r.reply?.ok ? <CheckIcon size={11} style={{ verticalAlign: "-1px" }} /> : <CloseIcon size={11} style={{ verticalAlign: "-1px" }} />}
            </antd.Tag>
          </div>
          {r.ping_error ? (
            <div style={{ color: "#ff4d4f" }}>发送失败：{r.ping_error}</div>
          ) : null}
          {r.reply?.ok ? (
            <div style={{ color: "#666" }}>
              {r.reply.sender}：{r.reply.body}
            </div>
          ) : (
            <div style={{ color: "#fa8c16" }}>
              <BulbIcon size={12} style={{ verticalAlign: "-1px" }} /> {r.reply?.detail || tr("无回复")}
              —— 可能被权限墙静默拦截（allowlist 不含你），或 Agent 未响应
            </div>
          )}
          {r.artifact ? (
            <div style={{ color: r.artifact.ok ? "#52c41a" : "#888" }}>
              产物：{r.artifact.detail}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** 12.14：聊天布局客户端诊断（自检页）——分栏/滚动问题的数字现场。 */
function ChatLayoutDiagCard({
  layout,
}: {
  layout?: { wide: boolean; forced: boolean; threshold: number };
}) {
  const tr = useT();
  const [lines, setLines] = React.useState<string[]>([]);
  const measure = React.useCallback(() => {
    const out: string[] = [];
    out.push(`window.innerWidth = ${window.innerWidth}px`);
    const main = document.querySelector(".wb-main") as HTMLElement | null;
    if (main) {
      out.push(`容器 .wb-main = ${main.clientWidth} × ${main.clientHeight}px`);
      // 15.18：父链每层 clientWidth（2412px 横屏误判窄屏根因修——定位哪层变窄
      // 把 visible 拉低；最窄层决定窄/宽判定）。
      const chain: string[] = [];
      let cel: HTMLElement | null = main;
      while (cel) {
        const cls =
          cel.className && typeof cel.className === "string"
            ? "." + cel.className.trim().split(/\s+/).slice(0, 1).join(".")
            : "";
        // 0 宽层标注：宿主 compat 层 display:contents（不产生 box）恒 0，
        // measure 已跳过 0 层；标注出来供复发时直接定位。
        const w = cel.clientWidth;
        chain.push(
          `${cel.tagName.toLowerCase()}${cls}=${w}${w === 0 ? "(0宽·不计)" : ""}`,
        );
        if (cel.tagName === "BODY") break;
        cel = cel.parentElement;
      }
      out.push(`父链(最窄非零层定判定): ${chain.join(" ← ")}`);
    }
    if (layout) {
      out.push(
        `模式 = ${layout.wide ? "宽屏分栏" : "窄屏单列"}（横屏且≥${layout.threshold}px 才分栏${layout.forced ? "；已强制分栏" : ""}）`,
      );
    }
    if (main) {
      out.push(
        `长宽比 = ${(main.clientHeight / Math.max(main.clientWidth, 1)).toFixed(2)}（${main.clientWidth >= main.clientHeight ? "横屏" : "竖屏"}）`,
      );
    }
    const left = document.querySelector(
      '.wb-main div[style*="overscroll"]',
    ) as HTMLElement | null;
    if (left && left.clientHeight > 0) {
      out.push(
        `左栏: 可视高 ${left.clientHeight}px / 内容高 ${left.scrollHeight}px / overflowY=${getComputedStyle(left).overflowY} → ${left.scrollHeight > left.clientHeight ? "内容超限（应可滚动）" : "内容未超限"}`,
      );
    } else {
      out.push(
        "左栏未渲染或聊天 tab 未激活（先点「聊天」tab 再回自检点「重新测量」可测左栏滚动数据）",
      );
    }
    setLines(out);
  }, [layout]);
  React.useEffect(() => {
    measure();
  }, [measure]);
  return (
    <antd.Card
      size="small"
      title={tr("聊天布局诊断（客户端）")}
      extra={
        <antd.Button size="small" onClick={measure}>
          {tr("重新测量")}
        </antd.Button>
      }
    >
      <pre
        style={{
          margin: 0,
          fontSize: 12,
          whiteSpace: "pre-wrap",
          lineHeight: 1.7,
        }}
      >
        {lines.join("\n") || "…"}
      </pre>
      <div style={{ fontSize: 11, color: "#888", marginTop: 6 }}>
        {tr("排查「聊天分栏/滚动」问题时：把上面几行原样发我（数字即现场）。")}
      </div>
    </antd.Card>
  );
}

// 面板级 memo（同 SettingsTab）。
export const SelfCheckTab = React.memo(function SelfCheckTab({
  config,
  layout,
}: {
  config: WorkbenchConfig | null;
  layout?: { wide: boolean; forced: boolean; threshold: number };
}) {
  const tr = useT();
  const [result, setResult] = React.useState<SelfCheckResult | null>(null);
  const [running, setRunning] = React.useState<string | null>(null);

  const run = async (level: string) => {
    setRunning(level);
    try {
      const payload = await requestJson(`/agentteams-proxy/selfcheck/${level}`, {
        method: "POST",
      });
      setResult(payload as SelfCheckResult);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("自检失败"));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 760 }}>
      <ChatLayoutDiagCard layout={layout} />
      <antd.Space wrap>
        <antd.Button loading={running === "l0"} onClick={() => void run("l0")}>
          L0 本地环境
        </antd.Button>
        <antd.Button loading={running === "l1"} onClick={() => void run("l1")}>
          L1 连通性
        </antd.Button>
        <antd.Button loading={running === "l2"} onClick={() => void run("l2")}>
          L2 认证/API
        </antd.Button>
        <antd.Button
          type="primary"
          loading={running === "all"}
          onClick={() => void run("all")}
        >
          全部自检
        </antd.Button>
      </antd.Space>
      <antd.Space wrap>
        <antd.Button
          loading={running === "l3"}
          onClick={() => void run("l3")}
        >
          L3 房间实测（会发 [selfcheck] ping）
        </antd.Button>
        <antd.Button loading={running === "l4"} onClick={() => void run("l4")}>
          L4 端到端（L3 + 产物检查）
        </antd.Button>
      </antd.Space>
      {!config?.matrix_homeservers?.length ? (
        <div style={{ color: "#fa8c16", display: "flex", alignItems: "center", gap: 4 }}>
          <BulbIcon size={12} style={{ flexShrink: 0 }} /> {tr("尚未配置 Matrix 地址——先去「配置」tab 填写并保存，再跑自检。")}
        </div>
      ) : null}
      <CheckList result={result} />
      <RoomResultTable rooms={result?.rooms || []} />
      <div style={{ fontSize: 12, color: "#888" }}>
        L0=插件环境 / L1=连通性（自动探测生效地址） / L2=登录与 API 权限 /
        L3=每个房间发一条 [selfcheck] ping 并等回复（约 45 秒，检测权限墙静默拦截）/
        L4=端到端 + 产物检查。
      </div>
    </div>
  );
});

/** 12.14：聊天分栏最小容器宽——1024→600（宿主内嵌面板/窄窗场景
 * 1024 下判定窄屏、曾报告「无分栏」；600 以下=手机竖屏语义）。
 * 12.16：宽窄判定「长宽比优先」——竖屏（高>宽）一律单列，横屏且 ≥600 才分栏。 */
/** 聊天分栏最小容器宽（13.8：600→800——双栏可用性下限：列表 160 + 聊天
 * ≥320 + 拖柄；16:9 全屏恒过线，竖屏手机不过线）。 */
// 单一事实源 = WbViewportContext.NARROW_MAX_W（团队表卡片化 / 表渐隐共用）。
// 聊天单栏/双栏阈值即此：容器可见宽 < 800 = 单栏 = 窄。
export const CHAT_SPLIT_MIN_CONTAINER_W = NARROW_MAX_W;

// mergeMessagePages 退役 → roomHistory.mergeForward
//（语义原样迁移，单一出处）。
/** 12.16→13.10：宽窄判定基准 = **窗口宽**（window.innerWidth）。
 * * 旧判定 w>=600 且 w>=h——宽高比项在「定高内嵌容器/高分屏」下误判
 * （容器高度随内容或视口变化，宽 ≥ 高不成立→单栏）。改纯宽度阈值。
 * （13.9 「窄屏行为识别不了，框拖到最窄也不行；
 * 窗口横向拉满就行；上一版横向全屏被识别成竖屏」）：容器测量被宿主
 * 左右留空（面板 padding/导航）压窄 → 窗口横向拉满时容器仍 <800 被误判
 * 窄屏；且宿主窗口最小宽 + 留空使「拖最窄」永远过不了阈值（窄屏行为
 * 识别不了）。以**窗口**横向宽为准——横向拉满=分栏，真窄
 * 窗口（<800）=单栏；窄内嵌面板逃生口=「强制分栏」开关 + ⟨ 收起列表。 */
/** 13.11（13.10 宽窄屏没修，只需容器能横向铺满）：宽窄双基准——
 * win = 浏览器/webview 窗口宽，cont = 插件容器实测宽（宿主可能只给
 * 半窗/带留白）。**min(win, cont) ≥ 800 才分栏**：窗口满宽时容器随宿主
 * 铺满（主容器 width:100%）→ 分栏；宿主给窄容器或真窄窗口 → 聊天页
 * 自动单栏（不硬塞双栏）。13.9 容器单基准被宿主留白压窄误判、13.10
 * 窗口单基准在半窗面板误判——双基准取交集，两边都宽才是"真宽"。 */
export function isWideLayout(win: number, cont: number): boolean {
  return Math.min(win, cont) >= CHAT_SPLIT_MIN_CONTAINER_W;
}

// ── @mention 发送侧（— Element 三件套，我点击的 @mention 不是正确格式）──
// 此前发送只有裸 body 文本（短 @name）：无 m.mentions 三元组 → 收端不通知/不高亮；
// 无 formatted_body → 标准客户端不认。Element 口径：body 保留人类可读短名，
// formatted_body 用 matrix.to 链接，`m.mentions.user_ids` 三元组负责通知
// （服务端 _require_mention 也认三元组——13.7 已实证）。
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 从文本提取被 @ 的房间成员（localpart 精确 / displayname 精确，与 @ 弹层同口径；
 * 词边界防 @sys 误中 @sys-dev）。 */
export function detectMentions(
  text: string,
  members?: Record<string, { display_name?: string }>,
): string[] {
  const out: string[] = [];
  if (!members) return out;
  const lower = text.toLowerCase();
  for (const [mxid, member] of Object.entries(members)) {
    const local = (mxid.split(":")[0] || mxid).replace(/^@/, "").toLowerCase();
    const disp = (member?.display_name || "").trim().toLowerCase();
    const reLocal = new RegExp(`@${escapeRe(local)}(?![\\w.=-])`, "i");
    const reDisp = disp
      ? new RegExp(`@${escapeRe(disp)}(?![\\w.=-])`, "i")
      : null;
    if (reLocal.test(lower) || (reDisp && reDisp.test(lower))) out.push(mxid);
  }
  return out;
}

export const WB_MAIN_CSS = `
        /* 宽元素防撑链（全视口，）：flex/grid 项默认 min-width:auto，
 不可收缩内容（长 Tag/长占位符）会把 Col→Row→容器撑宽 → min-width:0
 断链：内容自行换行/内滚，容器恒宽、顶屏刚刚好。 */
        .wb-main .ant-row,
        .wb-main .ant-row .ant-col,
        .wb-main .ant-card,
        .wb-main .ant-card-body,
        .wb-main .qwenpaw-row,
        .wb-main .qwenpaw-row .qwenpaw-col,
        .wb-main .qwenpaw-card,
        .wb-main .qwenpaw-card-body { min-width: 0; max-width: 100%; }
        /* 行内 Select 默认 min-width:auto=内容宽（长占位符撑行）
 → 强制可收缩（内容自行裁剪），断「创建团队卡溢出」最后一条链。 */
        .wb-main .ant-select,
        .wb-main .qwenpaw-select { min-width: 0; }
 /* （P8a）：聊天分栏左右独立滚动——antd Tabs 内部
 content 链默认无高度（auto 跟随内容）→ 分栏容器 height:100%
 塌陷、房间列表撑高被 wb-main overflow:hidden 裁掉。锁定
 content holder/content/tabpane 高度链（chatWide 分栏专用；
 其他 tab 内容自身有高度约束；12.11 起 tabpane 加 overflow-y:auto
 回退滚动、内容区容器 flex 化——整链真正接通）。 */
        /* 12.15 真机复现（宿主实测）：QwenPaw 宿主是自家前缀的 antd 分支
 （qwenpaw-tabs-*，无 .ant-tabs-*）——上面整条链在真宿主从未命中
 （左栏被撑到 8193px、整页滚动 4 轮复报的确证根因）。双前缀双写。 */
        .wb-main .ant-tabs-content-holder,
        .wb-main .qwenpaw-tabs-content-holder { flex: 1; min-height: 0; }
        .wb-main .ant-tabs-content,
        .wb-main .qwenpaw-tabs-content { height: 100%; }
        .wb-main .ant-tabs-tabpane-active,
        .wb-main .qwenpaw-tabs-tabpane-active { height: 100%; min-height: 0; overflow-y: auto; }
        /* ：antd 断点最小档 xs=576px——
 390px 手机低于一切断点，Col 无任何断点样式 → 基础 width:100%
 + flex-shrink 把「员工入职/创建团队」两卡挤成 50/50（各 174px，
 内容需 330+ → 整条溢出链的源头）。<576px 强制单列通宽。 */
        @media (max-width: 575px) {
          .wb-main .ant-row > .ant-col,
          .wb-main .qwenpaw-row > .qwenpaw-col {
            flex: 0 0 100% !important;
            max-width: 100% !important;
          }
        }
        /* ：无列模板的 display:grid
 单 auto 列宽=max-min-content（创建团队表单被撑到 490px>390 视口）
 → minmax(0,1fr) 锁轨道=容器宽、item 可收缩。内联
 gridTemplateColumns 的网格不受影响（inline 优先级更高）。 */
        .wb-main [style*="display:grid"],
        .wb-main [style*="display: grid"] { grid-template-columns: minmax(0, 1fr); }
        /* 卡片标题：flex item min-width:auto 撑宽（"员工入职（Human CRD）"
 166>136 溢出）→ 允许收缩换行。 */
        .wb-main .ant-card-head-title,
        .wb-main .qwenpaw-card-head-title { min-width: 0; }
        @media (max-width: 700px) {
          .wb-main { padding: 8px 10px 12px !important; gap: 8px !important; }
          .wb-main .ant-card-body, .wb-main .qwenpaw-card-body { padding: 10px !important; }
          .wb-main .ant-table-cell, .wb-main .qwenpaw-table-cell { padding-left: 6px !important; padding-right: 6px !important; }
          .wb-main .ant-table-thead > tr > th, .wb-main .qwenpaw-table-thead > tr > th { padding-left: 6px !important; padding-right: 6px !important; }
          .wb-main .ant-tag, .wb-main .qwenpaw-tag { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
          .wb-main pre, .wb-main code { white-space: pre-wrap; word-break: break-all; }
        }
        /* ══ 浮层（Modal/Drawer）窄视口防溢出 ══
   固定像素宽（420~780）的 Modal/Drawer 在窄视口（手机 390）会横向溢出屏外
   ——antd 把 width 设成 inline，用 max-width 约束「有效宽 = min(设定宽, 视口)」：
   宽视口下 min 取设定宽 = 桌面零变化；窄视口下取视口 = 不溢出。max-width 只收缩
   从不撑宽，纯保护性（对任何浮层都只防超宽，无副作用）。
   antd Drawer/Modal portal 到 body（脱离 .wb-main 作用域）→ 选择器不加 .wb-main
   前缀；宿主 antd=自家前缀分支，双前缀双写。 */
        .ant-modal, .qwenpaw-modal { max-width: calc(100vw - 16px) !important; }
        .ant-drawer-content-wrapper, .qwenpaw-drawer-content-wrapper { max-width: 100vw !important; }
        /* ══ 窄屏弹窗内容（wbc-narrow：NarrowSheet 内容包裹层）══
   弹窗内固定宽控件（140~220px）+ 表单行 150px 固定 label 列 超出弹窗内容宽
   （~280px）→ 横向拖。正解=业界移动表单模式：
   ①表单行转纵向（label 上、控件下整宽）②所有 antd 控件 max-width 限到容器宽
   （inline width 被 max-width 钳住；宽控件在宽屏弹窗同样安全——只收缩不撑宽）。
   portal 在 body → 不带 .wb-main 前缀；双前缀双写。 */
        .wbc-narrow .wbc-cfgrow { grid-template-columns: 1fr !important; gap: 4px !important; }
        .wbc-narrow .ant-select, .wbc-narrow .qwenpaw-select,
        .wbc-narrow .ant-input, .wbc-narrow .qwenpaw-input,
        .wbc-narrow .ant-input-affix-wrapper, .wbc-narrow .qwenpaw-input-affix-wrapper,
        .wbc-narrow .ant-input-number, .wbc-narrow .qwenpaw-input-number,
        .wbc-narrow .ant-picker, .wbc-narrow .qwenpaw-picker { max-width: 100% !important; }
        .wbc-narrow .ant-slider, .wbc-narrow .qwenpaw-slider { margin: 6px 8px 2px !important; }
        /* 无列模板的 display:grid 隐式 auto 轨按 item min-content 撑宽
   （.wb-main 同款规则——portal 弹窗在 body 作用域外，须 wbc-narrow 镜像；
   CfgRow 的 150px 1fr 由 .wbc-cfgrow !important 规则优先，不受影响）。 */
        .wbc-narrow [style*="display:grid"],
        .wbc-narrow [style*="display: grid"] { grid-template-columns: minmax(0, 1fr); }
        /* 上方 tab 条独立横向滚动（触屏滑；~320px 弹窗宽下 6 域 tab 溢出
   不换行不截断，rc-tabs 自带左右箭头并存不冲突）：nav-wrap 触摸横滚 +
   隐藏滚动条 + 标签 nowrap。portal 在 body → 双前缀双写。 */
        .wbc-narrow .ant-tabs-nav-wrap, .wbc-narrow .qwenpaw-tabs-nav-wrap {
          overflow-x: auto !important;
          overflow-y: hidden !important;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
          /* 卡顿根修（窄屏横滑反馈）：触屏横滑手势先声明 pan-x——浏览器无需
     采样判定横/纵方向（省 ~100ms 手势延迟），且不再与 sheet body 的
     纵向滚抢手势；overscroll-behavior-x:contain 切断滚链（tab 条到头
     不再把 sheet body 带着滚）。业界横滚容器标准双件。 */
          touch-action: pan-x;
          overscroll-behavior-x: contain;
        }
        .wbc-narrow .ant-tabs-nav-wrap::-webkit-scrollbar,
        .wbc-narrow .qwenpaw-tabs-nav-wrap::-webkit-scrollbar { display: none; }
        .wbc-narrow .ant-tabs-nav-list, .wbc-narrow .qwenpaw-tabs-nav-list { flex-wrap: nowrap !important; }
        .wbc-narrow .ant-tabs-tab, .wbc-narrow .qwenpaw-tabs-tab { white-space: nowrap !important; }
        .wbc-narrow .ant-card, .wbc-narrow .qwenpaw-card,
        .wbc-narrow .ant-card-body, .wbc-narrow .qwenpaw-card-body { max-width: 100% !important; }
        /* ══ 触屏层（P0 触屏适配）══
   触控检测 = any-pointer:coarse（纯触屏+笔记本触屏混合设备都命中；
   不用 UA 嗅探，基础体验保持 input-agnostic——桌面路径零改动）。
   宿主 antd=自家前缀分支（qwenpaw-*，12.15 真机实锤）→ 双前缀双写。 */
        /* 1) 消双击缩放 + 点击延迟残留（现代 fastclick 等价 CSS）：
  所有可交互元素统一 manipulation（pan+pinch 保留，单点即点）。 */
        .wb-main button, .wb-main a, .wb-main [role="button"],
        .wb-main .ant-btn, .wb-main .qwenpaw-btn,
        .wb-main .ant-select, .wb-main .qwenpaw-select { touch-action: manipulation; }
        /* 2) 系统 tap 灰闪去掉，视觉反馈交给 antd :active 自带态
  （antd 5 按钮/输入自带 active 色，不重复造反馈）。 */
        .wb-main { -webkit-tap-highlight-color: transparent; }
        /* 3) 嵌套滚动区防滚动链传递（聊天窗/表格/列表内滚时
  不把惯性甩给宿主页面）。 */
        .wb-main .ant-table-body, .wb-main .qwenpaw-table-body,
        .wb-main [class*="-tabs-tabpane"] { overscroll-behavior: contain; }
        /* 4) 触控目标放大类（T3 高频路径挂 .wb-touch-lg）：
  伪元素负 inset 扩 hit-area 到 ≥44×44（视觉尺寸不变）——
  业界标准手法（GitHub/Material Web 同款）；密集表格行操作
  不挂此类（24px AA 底线 + 间距豁免，扩了会互相叠压）。 */
        @media (any-pointer: coarse) {
          .wb-main .wb-touch-lg { position: relative; }
          .wb-main .wb-touch-lg::before {
            content: "";
            position: absolute;
            top: -10px; left: -10px; right: -10px; bottom: -10px;
          }
        }
        /* 5) 底部 safe-area（notch/手势条）：置底钮等底部锚定元素挂
  .wb-safe-bottom——padding-bottom 取 env 与最小间距的较大者。 */
        .wb-main .wb-safe-bottom {
          padding-bottom: max(8px, env(safe-area-inset-bottom));
        }
        /* ══ Coding CLI 卡片触屏层（15.33：卡片化收放）══
   竖屏 NarrowSheet portal 在 body（.wb-main 作用域外）→ .wbc-narrow
   镜像，与 antd 双前缀双写同款手法。 */
        .wbc-narrow { -webkit-tap-highlight-color: transparent; }
        @media (any-pointer: coarse) {
          .wbc-narrow .wb-touch-lg { position: relative; }
          .wbc-narrow .wb-touch-lg::before {
            content: "";
            position: absolute;
            top: -10px; left: -10px; right: -10px; bottom: -10px;
          }
        }
        /* sheet 内 small 按钮（表单「保存改动」等）触屏高度底线 32px
   （antd small=24px 低于触控底线；仅窄 sheet 内放大，宽屏内联不变）。 */
        .wbc-narrow .ant-btn-sm, .wbc-narrow .qwenpaw-btn-sm { min-height: 32px; }
        /* 6) 纯触屏设备（hover:none）：hover-only 装饰态不渲染
  （hover 显现的操作按钮改常显——T5 逐处收口后统一由该类控制）。 */
        @media (hover: none) {
          .wb-main .wb-hover-only-action { opacity: 1 !important; }
        }
        /* 7) tab 栏横滚渐隐（P1）：11 tab 窄屏只装 ~4 个，可滚但无
  视觉提示 → mask-image 边缘渐变（业界 scroll-fade 的兼容版——
  animation-timeline iOS Safari 支持太晚）。JS scroll 事件切四态：
  both=两侧可滚 / l=仅左可滚（已滚到最右）/ r=仅右可滚（最左）/
  none=内容装得下。20px 渐变带，边缘内容淡出=「还有更多」信号。 */
        .wb-main .wb-tabs-fade-both {
          -webkit-mask-image: linear-gradient(90deg, transparent, #000 20px, #000 calc(100% - 20px), transparent);
          mask-image: linear-gradient(90deg, transparent, #000 20px, #000 calc(100% - 20px), transparent);
        }
        .wb-main .wb-tabs-fade-l {
          -webkit-mask-image: linear-gradient(90deg, transparent, #000 20px);
          mask-image: linear-gradient(90deg, transparent, #000 20px);
        }
        .wb-main .wb-tabs-fade-r {
          -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 20px), transparent);
          mask-image: linear-gradient(90deg, #000 calc(100% - 20px), transparent);
        }
        .wb-main .wb-tabs-fade-none {
          -webkit-mask-image: none;
          mask-image: none;
        }
        /* 8) 表格右缘渐隐（P3）：WbTableFade 包装器挂类——窄屏下
  scroll.x 表格恒可横滚，右缘 16px 灰透明渐变提示「还有更多」；
  bottom 留 17px 不盖横滚条。灰透明（128 系 12%）双主题通用。 */
        .wb-main .wb-table-fade-r { position: relative; }
        .wb-main .wb-table-fade-r::after {
          content: "";
          position: absolute;
          top: 0; right: 0;
          width: 16px;
          bottom: 17px;
          background: linear-gradient(90deg, transparent, rgba(128,128,128,0.12));
          pointer-events: none;
        }
      `;

// 聊天页 dashboard 对齐收尾（R1–R6）源扫回归：formatted_body 四处链 /
// 围栏表格解包 / run-ending 哨兵 / typing 指示器 / 刻度跨天 M/D / 房间名省略。
//
// 运行：cd frontend && node scripts/vitest-gate.mjs tests/chat-parity-finish.vitest.test.ts
// （静态 import vitest 顶层注册，禁 top-level await——esbuild CJS 打包不支持；
// 源文件经 process.cwd()=frontend 读取，与 a11y-static/i18n-coverage 同款）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it } from "vitest";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

describe("chat-parity-finish", () => {
  it("R1 api：RoomMessage 声明 formatted_body，m.replace 聚合与主路径均按 html format 判定", () => {
    const s = read("src/api/domains/chat.ts");
    assert.ok(s.includes("formatted_body?: string;"), "RoomMessage 缺 formatted_body 声明");
    assert.ok(s.includes('nc.format === "org.matrix.custom.html"'), "m.replace 聚合缺 format 判定");
    assert.ok(s.includes("(nc.formatted as string | undefined)"), "m.replace 聚合缺 formatted 读取");
    assert.ok(s.includes("content.format === \"org.matrix.custom.html\""), "主路径缺 format 判定");
    assert.ok(s.includes("formatted_body: redacted"), "主路径缺 redacted 守卫");
    assert.ok(s.includes("(content.formatted as string | undefined)"), "主路径缺 content.formatted 读取");
  });

  it("R1 connector：room_message 载荷 body 不截断 + formatted 仅 html 时携带", () => {
    const py = read("../agentteams_connector/sync_watcher.py");
    const i = py.indexOf('"type": "room_message"');
    assert.ok(i >= 0, "未找到 room_message 事件段");
    const j = py.indexOf("# ① 任务状态变化", i);
    assert.ok(j > i, "未找到 room_message 事件段边界");
    const section = py.slice(i, j);
    assert.ok(
      section.includes('"body": str(content.get("body") or ""),'),
      "body 缺或仍被截断",
    );
    assert.ok(!section.includes("[:500]"), "body 仍有 [:500] 截断");
    assert.ok(section.includes('"formatted": content.get("formatted")'), "缺 formatted 字段");
    assert.ok(section.includes('"org.matrix.custom.html"'), "formatted 缺 format 判定");
    assert.ok(section.includes("else None"), "非 html 时 formatted 应为 None");
    assert.ok(py.includes("[:120]"), "room_list_update 的 last_body [:120] 被误改");
  });

  it("R1 SSE 直合：evp.formatted → 活跃房/非活动房两处 formatted_body", () => {
    const s = read("src/WorkbenchPageEvents.ts");
    assert.ok(s.includes("formatted?: string | null;"), "事件类型缺 formatted 字段");
    assert.equal(
      (s.match(/\{ formatted_body: evp\.formatted \}/g) ?? []).length,
      2,
      "formatted_body 合并点应为 2 处（活跃房 + 非活动房）",
    );
  });

  it("R1 接线：主气泡/ATTENTION 分支/线程面板均传 formatted_body 给 MdText", () => {
    const b = read("src/components/RoomChatBubbles.tsx");
    assert.equal(
      (b.match(/formattedBody=\{msg\.formatted_body\}/g) ?? []).length,
      2,
      "RoomChatBubbles 应 2 处（ATTENTION 分支 + 主气泡）",
    );
    const th = read("src/components/RoomChatThread.tsx");
    assert.ok(
      th.includes("formattedBody={renderMsg.formatted_body}"),
      "线程面板缺 formatted_body 接线",
    );
  });

  it("R2 MdText：渲染源 = 围栏解包(formatted_body→纯文本 | text)，源确定后块解析前", () => {
    const s = read("src/components/MdText.tsx");
    assert.ok(
      s.includes('import { unwrapFencedTables } from "../lib/fencedTable";'),
      "缺 fencedTable import",
    );
    assert.ok(
      s.includes('import { htmlToPlainText } from "../lib/mdPlain";'),
      "缺 mdPlain import",
    );
    assert.ok(
      s.includes("unwrapFencedTables(formattedBody ? htmlToPlainText(formattedBody) : text)"),
      "渲染源三元缺失（formatted 优先、缺省回退 text、再套围栏解包）",
    );
    assert.ok(s.includes("formattedBody?: string;"), "缺 formattedBody prop 声明");
    assert.ok(
      s.includes("Math.round(source.length / 1024)"),
      "展开按钮 KB 应基于渲染源长度",
    );
  });

  it("R2 fencedTable：isGfmTableContent + unwrapFencedTables 纯函数移植（仅解包 GFM 表）", () => {
    const s = read("src/lib/fencedTable.ts");
    assert.ok(s.includes("SEPARATOR_ROW"), "缺分隔行正则");
    assert.ok(s.includes("export function isGfmTableContent"), "缺 isGfmTableContent");
    assert.ok(s.includes("export function unwrapFencedTables"), "缺 unwrapFencedTables");
    assert.ok(
      s.includes("isGfmTableContent(inner) ? inner.trimEnd() : whole"),
      "非表围栏应原样保留",
    );
  });

  it("R3 run-ending：3 哨兵精确相等判定 → 3 收尾文案（role=status/alert），位于 redacted 后 workflow 前", () => {
    const s = read("src/components/RoomChatBubbles.tsx");
    assert.ok(
      s.includes('sentinel === "已取消" || sentinel === "处理异常" || sentinel === "已处理"'),
      "缺哨兵三值精确相等判定（trim 后）",
    );
    assert.ok(s.includes('tr("已处理（无回复）")'), "缺「已处理（无回复）」文案");
    assert.ok(
      s.includes('tr("任务已取消")') && s.includes('tr("任务异常")'),
      "缺「任务已取消」/「任务异常」文案",
    );
    assert.ok(s.includes('role={cancelled ? "status" : "alert"}'), "缺 role=status/alert");
    const iRed = s.indexOf("if (msg.redacted)");
    const iSen = s.indexOf('const sentinel = (msg.body || "").trim();');
    const iWf = s.indexOf("if (msg.workflow)");
    assert.ok(
      iRed >= 0 && iSen > iRed && iWf > iSen,
      "哨兵分支位置错误（应在 redacted 早退后、workflow 分支前）",
    );
    const i18n = read("src/i18n/domains/chat.ts");
    assert.ok(i18n.includes('"已处理（无回复）": { en: "Processed (no reply)" }'), "i18n 缺已处理键");
    assert.ok(i18n.includes('"任务已取消": { en: "Task cancelled" }'), "i18n 缺任务已取消键");
    assert.ok(i18n.includes('"任务异常": { en: "Task failed" }'), "i18n 缺任务异常键");
  });

  it("R4 typing：3 档文案 + aria-live + rcTypingDot 动画，挂载 composer 上方", () => {
    const c = read("src/components/RoomChatTyping.tsx");
    assert.ok(c.includes('tr("{n} 正在输入"'), "缺 1 人档文案");
    assert.ok(c.includes('tr("{a} 和 {b} 正在输入"'), "缺 2 人档文案");
    assert.ok(c.includes('tr("{a} 等 {n} 人正在输入"'), "缺 >2 人档文案");
    assert.ok(c.includes('role="status"'), "缺 role=status");
    assert.ok(c.includes('aria-live="polite"'), "缺 aria-live=polite");
    assert.ok(c.includes("rcTypingDot 1.2s infinite"), "缺 3 点 CSS 动画引用");
    const r = read("src/components/RoomChat.tsx");
    const iT = r.indexOf("<RoomChatTyping");
    const iC = r.indexOf("<RoomChatComposer");
    assert.ok(iT >= 0 && iT < iC, "typing 应挂载在 composer 上方");
    const g = read("src/index.tsx");
    assert.ok(g.includes("@keyframes rcTypingDot"), "全局 keyframes 缺失");
    const i18n = read("src/i18n/domains/chat.ts");
    assert.ok(i18n.includes('"{n} 正在输入": { en: "{n} is typing" }'), "i18n 缺 1 人档键");
    assert.ok(i18n.includes('"{a} 和 {b} 正在输入": { en: "{a} and {b} are typing" }'), "i18n 缺 2 人档键");
    assert.ok(
      i18n.includes('"{a} 等 {n} 人正在输入": { en: "{a} and {x} others are typing" }'),
      "i18n 缺 >2 人档键",
    );
  });

  it("R5 刻度：跨天 → M/D（不补零），tooltip=完整日期时间+发送者，同日内维持 HH:mm", () => {
    const s = read("src/chat/TurnTimeline.tsx");
    assert.ok(s.includes("function dayKey(ts: number): string"), "缺 dayKey（跨天判定）");
    assert.ok(s.includes("function dayLabel(ts: number): string"), "缺 dayLabel（M/D）");
    assert.ok(s.includes("function formatFull(ts: number): string"), "缺 formatFull（tooltip）");
    assert.ok(
      s.includes("dayKey(t.startTime) !== dayKey(prev.startTime)"),
      "缺跨天比较（与前一 turn 日期键）",
    );
    assert.ok(s.includes("d.getMonth() + 1}/${d.getDate()}"), "M/D 不应补零");
    assert.ok(
      s.includes("formatFull(t.startTime)} ${senderShortName(t.sender, props.room ?? null)"),
      "tooltip 应为完整日期时间+发送者名",
    );
    assert.ok(
      s.includes("showDay ? dayLabel(t.startTime) : formatTime(t.startTime)"),
      "同日内应维持 HH:mm（formatTime）",
    );
  });

  it("R6 房间名：窄宽 ellipsis + title 全名（非 no-op）", () => {
    const s = read("src/components/RoomChatHeader.tsx");
    const i = s.indexOf("antd.Typography.Title");
    assert.ok(i >= 0, "未找到房间名 Title");
    const block = s.slice(i, s.indexOf("ChatSwitcher", i));
    assert.ok(block.length > 0, "Title 切片失败");
    assert.ok(block.includes("title={room.name}"), "缺 title 全名");
    assert.ok(block.includes('textOverflow: "ellipsis"'), "缺 ellipsis");
    assert.ok(block.includes("minWidth: 0"), "缺 minWidth:0（flex 行收缩前提）");
    assert.ok(block.includes('whiteSpace: "nowrap"'), "缺 nowrap（ellipsis 前提）");
  });
});

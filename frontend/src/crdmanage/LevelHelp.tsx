// LevelHelp — 权限档位 ? 帮助（15.36 D）：按当前档位显说明 tooltip。
// 档位说明文字在此集中（HumanAccessModal / CrdHumanForm 两处共用）；
// Select label 本身精简为「L1 · 管理员」式短文案（admin.ts 15.36 D 键）。
import type * as ReactNS from "react";

import HelpDot from "../components/HelpDot";
import type { TrFn } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export const LEVEL_HELP: Record<number, string> = {
  1: "管理员（L1）。Matrix 登录拿不到 L1，需用管理员 token。",
  2: "团队成员（L2）。Matrix 登录即 L2，可看本团队。",
  3: "Worker 级。",
};

export default function LevelHelp({
  level,
  tr,
}: {
  level: number;
  tr: TrFn;
}) {
  const text = LEVEL_HELP[level] ?? "";
  return text ? <HelpDot title={tr(text)} /> : null;
}

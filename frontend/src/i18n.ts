import type * as ReactNS from "react";
import { adminDict } from "./i18n/domains/admin";
import { attentionDict } from "./i18n/domains/attention";
import { chatDict } from "./i18n/domains/chat";
import { credsDict } from "./i18n/domains/creds";
import { generalDict } from "./i18n/domains/general";
import { kbDict } from "./i18n/domains/kb";
import { settingsDict } from "./i18n/domains/settings";
import { teamDict } from "./i18n/domains/team";
import { upgradeDict } from "./i18n/domains/upgrade";
import { workerDict } from "./i18n/domains/worker";
import { workflowDict } from "./i18n/domains/workflow";

const host = window.QwenPaw.host;

/** 双语字典。key 用中文原文（zh 为源语言），en 为英文对照。
 * 由 i18n/domains/* 十个域字典合并（1616 键，键集与拆分前逐键恒等）。 */
const DICT: Record<string, { en: string }> = {
  ...adminDict,
  ...attentionDict,
  ...chatDict,
  ...credsDict,
  ...generalDict,
  ...kbDict,
  ...settingsDict,
  ...teamDict,
  ...upgradeDict,
  ...workerDict,
  ...workflowDict,
};


type Lang = "zh" | "en";

/** 当前语言（host.useLocale；非 zh 一律 en）。 */
export function useLang(): Lang {
  let locale = "";
  try {
    if (typeof host.useLocale === "function") {
      locale = String(host.useLocale() || "");
    }
  } catch {
    locale = "";
  }
  return locale && !locale.toLowerCase().startsWith("zh") ? "en" : "zh";
}

/** 翻译函数（hooks 版）。t("发送") → "Send"（en 模式）。
 * 必须记忆化（useMemo）——原实现每次 render 返回新函数，
 * 组件里 `useCallback(fn, [tr])` + `useEffect([...load])` 会无限循环
 * fetch（用户报告：技能中心「一直刷 worker 名字」= 该循环 + 目录接口
 * 404 每轮重复；全库仅 SkillCenter 踩中此模式）。
 */
export function useT(): (text: string, vars?: Record<string, string | number>) => string {
  const lang = useLang();
  // 宿主 React 实例（blob-URL 执行环境禁裸 import——历史事故教训）。
  return host.React.useMemo(
    () =>
      (text: string, vars?: Record<string, string | number>) => {
        let out = text;
        if (lang === "en" && DICT[text]) {
          out = DICT[text].en;
        }
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            out = out.split(`{${k}}`).join(String(v));
          }
        }
        return out;
      },
    [lang],
  );
}

export type { ReactNS };

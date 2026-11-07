// #1514 模型授权强制：错误五分类 + 统一文案 + 授权过滤「access=null 不过滤」
// 语义回归。错误消息形态 = requestJsonFull 的 `HTTP {status}: {detail}`，
// detail 内嵌后端 code 前缀（httputil.WriteError，无独立 code 字段）。

import { describe, expect, it } from "vitest";

import {
  classifyModelGrantError,
  modelGrantErrorText,
} from "../src/lib/modelGrantErrors";
import { grantedPairs, pairAllowed } from "../src/lib/modelAccess";

/** 后端 model_grant.go / worker_coding_cli.go 的逐字错误消息。 */
const MESSAGES = {
  pairRequired:
    "HTTP 403: model_pair_required: provider must be sent with model",
  unresolvable:
    "HTTP 403: model_pair_unresolvable: model \"qwen3\" not resolvable to a gateway provider",
  overflow:
    'HTTP 409: model_grant_overflow: worker "w" carries 33 implicit model grants, the annotation cap is 32; reduce the agentteams.io/model-access annotation',
  notAllowed: "HTTP 403: model_not_allowed: openai/gpt-4o",
  inheritNotGranted: "HTTP 403: inherit_not_granted: spawn",
  leaderReadonly:
    "HTTP 403: team leaders have read-only access to worker coding CLIs",
} as const;

describe("classifyModelGrantError（①四类 code 分类）", () => {
  it("三个 grant 专属 code 各自命中", () => {
    expect(classifyModelGrantError(new Error(MESSAGES.pairRequired))).toBe(
      "pair_required",
    );
    expect(classifyModelGrantError(new Error(MESSAGES.unresolvable))).toBe(
      "unresolvable",
    );
    expect(classifyModelGrantError(new Error(MESSAGES.overflow))).toBe(
      "overflow",
    );
  });

  it("已知 403 code（model_not_allowed / inherit_not_granted）归 forbidden", () => {
    expect(classifyModelGrantError(new Error(MESSAGES.notAllowed))).toBe(
      "forbidden",
    );
    expect(classifyModelGrantError(new Error(MESSAGES.inheritNotGranted))).toBe(
      "forbidden",
    );
  });

  it("②未知 403 → forbidden", () => {
    expect(classifyModelGrantError(new Error(MESSAGES.leaderReadonly))).toBe(
      "forbidden",
    );
    // 无 detail 的裸 403。
    expect(classifyModelGrantError(new Error("HTTP 403"))).toBe("forbidden");
    // 403 但 detail 非 "code:" 形态（普通拒绝文案）。
    expect(
      classifyModelGrantError(new Error("HTTP 403: permission denied")),
    ).toBe("forbidden");
  });

  it("③非 403 → other（透传，不猜）", () => {
    expect(classifyModelGrantError(new Error("HTTP 500: internal error"))).toBe(
      "other",
    );
    expect(classifyModelGrantError(new Error("HTTP 404: worker not found"))).toBe(
      "other",
    );
    // 409 但非 overflow code。
    expect(classifyModelGrantError(new Error("HTTP 409: conflict"))).toBe(
      "other",
    );
    // 非 HTTP 形态（超时/网络）。
    expect(
      classifyModelGrantError(
        new Error("请求超时（30s）——网络或后端冷启动中，稍后点刷新重试"),
      ),
    ).toBe("other");
  });

  it("显式 status/code 属性优先于消息解析（MetaApiError 同款形态）", () => {
    class GrantError extends Error {
      status: number;
      code?: string;
      constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = "GrantError";
        this.status = status;
        this.code = code;
      }
    }
    expect(
      classifyModelGrantError(
        new GrantError("whatever", 403, "model_pair_required"),
      ),
    ).toBe("pair_required");
    // code 优先：消息里没有 code 前缀也认。
    expect(
      classifyModelGrantError(new GrantError("x", 409, "model_grant_overflow")),
    ).toBe("overflow");
    // 显式 code 不在 grant 表 → 看 status。
    expect(
      classifyModelGrantError(new GrantError("x", 403, "model_not_allowed")),
    ).toBe("forbidden");
    expect(
      classifyModelGrantError(new GrantError("x", 409, "other_code")),
    ).toBe("other");
  });

  it("非 Error 值 → other（不抛）", () => {
    expect(classifyModelGrantError(null)).toBe("other");
    expect(classifyModelGrantError(undefined)).toBe("other");
    expect(classifyModelGrantError("HTTP 403: model_pair_required: x")).toBe(
      "other",
    );
    expect(classifyModelGrantError({ message: "boom" })).toBe("other");
  });
});

describe("modelGrantErrorText（四条统一文案）", () => {
  const tr = (s: string): string => s;

  it("四分类各自返回任务书文案", () => {
    expect(modelGrantErrorText(new Error(MESSAGES.pairRequired), tr)).toBe(
      "需同时选择 Provider 和模型",
    );
    expect(modelGrantErrorText(new Error(MESSAGES.unresolvable), tr)).toBe(
      "该模型无法绑定到网关 Provider（请选择具体 Provider 模型）",
    );
    expect(modelGrantErrorText(new Error(MESSAGES.overflow), tr)).toBe(
      "授权记录过多（>32），请联系管理员清理",
    );
    expect(modelGrantErrorText(new Error(MESSAGES.leaderReadonly), tr)).toBe(
      "无权限修改该 Worker 的模型",
    );
  });

  it("other → null（调用方回退原错误文本）", () => {
    expect(modelGrantErrorText(new Error("HTTP 500: internal"), tr)).toBeNull();
    expect(modelGrantErrorText(new Error("请求超时"), tr)).toBeNull();
  });

  it("tr 注入生效（非中文 locale）", () => {
    expect(
      modelGrantErrorText(new Error(MESSAGES.pairRequired), () => "i18n"),
    ).toBe("i18n");
  });
});

describe("④授权过滤函数在 access=null 时不过滤（兼容旧控制器）", () => {
  it("grantedPairs：null/undefined/空 surfaces → 空数组（=无限制语义）", () => {
    expect(grantedPairs(null, "main")).toEqual([]);
    expect(grantedPairs(undefined, "main")).toEqual([]);
    expect(grantedPairs({}, "main")).toEqual([]);
    expect(grantedPairs(null, "spawn")).toEqual([]);
    expect(grantedPairs(null, "codingCli", "claude-code")).toEqual([]);
  });

  it("pairAllowed：空 pairs → 一律放行（不过滤）", () => {
    expect(pairAllowed([], "any-provider", "any-model")).toBe(true);
    expect(pairAllowed([], "", "")).toBe(true);
  });

  it("pairAllowed：非空 pairs → 必须成对命中（反向验证过滤生效）", () => {
    const pairs = [{ provider: "openai", model: "gpt-4o" }];
    expect(pairAllowed(pairs, "openai", "gpt-4o")).toBe(true);
    expect(pairAllowed(pairs, "openai", "other")).toBe(false);
    expect(pairAllowed(pairs, "anthropic", "gpt-4o")).toBe(false);
  });

  it("grantedPairs：形状非法条目被丢弃", () => {
    expect(
      grantedPairs(
        {
          main: {
            entries: [
              { provider: "p", model: "m" },
              { provider: 1, model: "m" },
              "junk",
              null,
              { provider: "p" },
            ],
          },
        },
        "main",
      ),
    ).toEqual([{ provider: "p", model: "m" }]);
  });
});

// #1536 资源控制入口收敛单测（vitest 面：*.vitest.test.ts 约定，无需改配置）。
//
// 上游 #1536：创建/删除 Team/Human/Worker 只保留给 Manager/Admin
// （permissionLevel === 1，L1）；L2/L3 调用后端 403 → 前端入口
// disabled + 统一 Tooltip（保留可发现性，不隐藏）。本文件覆盖：
// ① canControlResources 判定（仅 === 1 放行，未知 fail closed）；
// ② useCallerLevel 派生（无 token / 未登录 / 找不到 self / 档位缺失
//    → null；命中 → 档位值）；
// ③ 统一提示文案 i18n 词条（en 在 manage 域字典，zh 直通）。
//
// 三个被测模块均为纯函数/纯对象（无 window、无拨号），直接 import。
//
// 运行：npx --no-install vitest run

import { describe, expect, it } from "vitest";

import {
  canControlResources,
  resourceControlDeniedHint,
} from "../src/lib/resourceControl";
import { useCallerLevel } from "../src/hooks/useCallerLevel";
import { manageDict } from "../src/i18n/domains/manage";
import type { AdminData, HumanInfo } from "../src/api";

// ── 测试夹具 ────────────────────────────────────────────────────────
function human(name: string, mxid: string, level?: number): HumanInfo {
  return {
    name,
    phase: "Running",
    displayName: name,
    matrixUserID: mxid,
    message: "",
    ...(typeof level === "number" ? { permissionLevel: level } : {}),
  };
}

function admin(humans: HumanInfo[]): AdminData {
  return { workers: [], teams: [], humans, managers: [] };
}

const SELF = "@self:local";
const L1_ADMIN = admin([
  human("boss", SELF, 1),
  human("member", "@member:local", 2),
]);

// ── ① canControlResources：仅 L1 放行，未知 fail closed ─────────────
describe("canControlResources", () => {
  it("L1（permissionLevel 1）→ true", () => {
    expect(canControlResources(1)).toBe(true);
  });
  it("L2（2）/ L3（3）→ false", () => {
    expect(canControlResources(2)).toBe(false);
    expect(canControlResources(3)).toBe(false);
  });
  it("未知档位（0 / null / undefined）→ false（fail closed）", () => {
    expect(canControlResources(0)).toBe(false);
    expect(canControlResources(null)).toBe(false);
    expect(canControlResources(undefined)).toBe(false);
  });
});

// ── ② useCallerLevel：从 admin 数据派生调用者档位 ──────────────────
describe("useCallerLevel", () => {
  it("无 Controller 管理员 token（admin=null）→ null", () => {
    expect(
      useCallerLevel({ admin: null, myUserId: SELF, hasToken: false }),
    ).toBeNull();
  });
  it("hasToken=false（admin 残留数据）→ null", () => {
    expect(
      useCallerLevel({ admin: L1_ADMIN, myUserId: SELF, hasToken: false }),
    ).toBeNull();
  });
  it("未登录（myUserId 空）→ null", () => {
    expect(
      useCallerLevel({ admin: L1_ADMIN, myUserId: "", hasToken: true }),
    ).toBeNull();
    expect(
      useCallerLevel({ admin: L1_ADMIN, hasToken: true }),
    ).toBeNull();
  });
  it("登录账号不在 humans 列表 → null", () => {
    expect(
      useCallerLevel({
        admin: L1_ADMIN,
        myUserId: "@nobody:local",
        hasToken: true,
      }),
    ).toBeNull();
  });
  it("self 存在但 permissionLevel 缺失 → null", () => {
    expect(
      useCallerLevel({
        admin: admin([human("boss", SELF)]),
        myUserId: SELF,
        hasToken: true,
      }),
    ).toBeNull();
  });
  it("self 为 L1 → 1", () => {
    expect(
      useCallerLevel({ admin: L1_ADMIN, myUserId: SELF, hasToken: true }),
    ).toBe(1);
  });
  it("self 为 L2 → 2（判定由 canControlResources 收口）", () => {
    expect(
      useCallerLevel({
        admin: L1_ADMIN,
        myUserId: "@member:local",
        hasToken: true,
      }),
    ).toBe(2);
  });
  it("端到端：L1 true / L2 false / 未知 false", () => {
    expect(
      canControlResources(
        useCallerLevel({ admin: L1_ADMIN, myUserId: SELF, hasToken: true }),
      ),
    ).toBe(true);
    expect(
      canControlResources(
        useCallerLevel({
          admin: L1_ADMIN,
          myUserId: "@member:local",
          hasToken: true,
        }),
      ),
    ).toBe(false);
    expect(
      canControlResources(
        useCallerLevel({ admin: null, myUserId: SELF, hasToken: false }),
      ),
    ).toBe(false);
  });
});

// ── ③ 统一提示文案（i18n 键在 manage 域，en 词条必须存在）─────────
describe("resourceControlDeniedHint", () => {
  const KEY = "仅管理员可创建或删除资源";
  it("manage 域字典含 en 词条（i18n 覆盖门同源口径）", () => {
    expect(manageDict[KEY]?.en).toBe(
      "Only admins can create or delete resources",
    );
  });
  it("zh 直通 tr → 中文键原样", () => {
    expect(resourceControlDeniedHint((s) => s)).toBe(KEY);
  });
  it("en tr（字典查表）→ 英文", () => {
    expect(resourceControlDeniedHint((k) => manageDict[k]?.en ?? k)).toBe(
      "Only admins can create or delete resources",
    );
  });
});

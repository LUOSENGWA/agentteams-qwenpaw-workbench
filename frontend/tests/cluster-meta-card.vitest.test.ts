/**
 * 集群页「控制器」卡（/status 计数 + /version 版本）渲染与取数单测。
 *
 * 渲染环境同 manage-checkpoint-card 先例：node 环境 + 注入 window.QwenPaw.host
 * （真 React + 最小 antd 桩）→ renderToStaticMarkup 静态渲染（effects 不跑）。
 *
 * 覆盖：
 * - 计数 / kubeMode / 版本渲染；dev 版本显式标注「镜像未注入版本」；
 * - 失败静默：状态失败 → 计数 "—"，版本照显；两者全失败 → 全 "—"；
 * - /status 401/403 → 整卡隐藏（不报错）；
 * - 加载中骨架；
 * - 接线：ClusterSection 顶部挂载、无轮询（只挂载拉一次）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const srcText = (rel: string): string =>
  readFileSync(join(here, "..", "src", rel), "utf8");
const E = React.createElement;

vi.mock("../src/api/domains/cluster", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/api/domains/cluster")>();
  return {
    ...actual,
    fetchClusterStatus: vi.fn(),
    fetchControllerVersion: vi.fn(),
  };
});

(globalThis as Record<string, unknown>).window = {
  innerWidth: 1200,
  innerHeight: 900,
  QwenPaw: {
    host: {
      kind: "server",
      React,
      antd: {
        Skeleton: () => E("div", { "data-skeleton": "1" }),
      },
      antdIcons: {},
      useLocale: () => "zh",
      useTheme: () => "light",
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      }),
      getApiUrl: (p: string) => p,
      getApiToken: () => "",
    },
  },
};
(globalThis as Record<string, unknown>).document = {
  hidden: false,
  documentElement: {},
};

let Body: typeof import("../src/manage/ClusterMetaCard").ClusterMetaCardBody;
let loadClusterMeta: typeof import("../src/manage/ClusterMetaCard").loadClusterMeta;
let cluster: typeof import("../src/api/domains/cluster");

beforeAll(async () => {
  const mod = await import("../src/manage/ClusterMetaCard");
  Body = mod.ClusterMetaCardBody;
  loadClusterMeta = mod.loadClusterMeta;
  cluster = await import("../src/api/domains/cluster");
});

const status = {
  kubeMode: "kube",
  totalWorkers: 4,
  totalTeams: 2,
  totalHumans: 7,
};

const html = (state: unknown): string =>
  renderToStaticMarkup(E(Body, { state: state as never }));

describe("ClusterMetaCardBody 渲染", () => {
  it("loading → 骨架（不显示计数）", () => {
    const out = html({ kind: "loading" });
    expect(out).toContain('data-skeleton="1"');
    expect(out).toContain("控制器");
    expect(out).not.toContain("Workers");
  });

  it("ready → kubeMode / Workers / Teams / Humans / 版本", () => {
    const out = html({
      kind: "ready",
      status,
      version: { controller: "1.2.5", kubeMode: "kube" },
    });
    expect(out).toContain("部署模式");
    expect(out).toContain(">kube<");
    expect(out).toContain("Workers");
    expect(out).toContain(">4<");
    expect(out).toContain("Teams");
    expect(out).toContain(">2<");
    expect(out).toContain("Humans");
    expect(out).toContain(">7<");
    expect(out).toContain("1.2.5");
  });

  it("dev 版本 → 标注「镜像未注入版本」", () => {
    const out = html({
      kind: "ready",
      status,
      version: { controller: "dev", kubeMode: "kube" },
    });
    expect(out).toContain("dev（镜像未注入版本）");
  });

  it("状态失败（非鉴权）→ 计数 —，版本照显（静默降级）", () => {
    const out = html({
      kind: "ready",
      status: null,
      version: { controller: "1.2.5", kubeMode: "kube" },
    });
    expect(out).toContain("Workers");
    expect(out).toContain("—");
    expect(out).toContain("1.2.5");
  });

  it("两端点全失败 → 全 —（保留卡片壳）", () => {
    const out = html({ kind: "ready", status: null, version: null });
    expect(out.split("—").length - 1).toBeGreaterThanOrEqual(5);
    expect(out).not.toContain("undefined");
  });

  it("hidden（/status 401/403）→ 整卡不渲染", () => {
    expect(html({ kind: "hidden" })).toBe("");
  });
});

describe("loadClusterMeta 取数与失败语义", () => {
  beforeEach(() => {
    vi.mocked(cluster.fetchClusterStatus).mockReset();
    vi.mocked(cluster.fetchControllerVersion).mockReset();
  });

  it("并行拨两端点 → ready", async () => {
    vi.mocked(cluster.fetchClusterStatus).mockResolvedValue(status);
    vi.mocked(cluster.fetchControllerVersion).mockResolvedValue({
      controller: "1.2.5",
      kubeMode: "kube",
    });
    const out = await loadClusterMeta();
    expect(cluster.fetchClusterStatus).toHaveBeenCalledTimes(1);
    expect(cluster.fetchControllerVersion).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      kind: "ready",
      status,
      version: { controller: "1.2.5", kubeMode: "kube" },
    });
  });

  it("/status 401 → hidden（不抛）；403 同", async () => {
    vi.mocked(cluster.fetchControllerVersion).mockResolvedValue({
      controller: "1.2.5",
      kubeMode: "kube",
    });
    vi.mocked(cluster.fetchClusterStatus).mockRejectedValue(
      new Error("HTTP 401: no token"),
    );
    await expect(loadClusterMeta()).resolves.toEqual({ kind: "hidden" });
    vi.mocked(cluster.fetchClusterStatus).mockRejectedValue(
      new Error("HTTP 403: forbidden"),
    );
    await expect(loadClusterMeta()).resolves.toEqual({ kind: "hidden" });
  });

  it("/status 5xx → ready + status null（其余内容保留）", async () => {
    vi.mocked(cluster.fetchClusterStatus).mockRejectedValue(
      new Error("HTTP 502: bad gateway"),
    );
    vi.mocked(cluster.fetchControllerVersion).mockResolvedValue({
      controller: "dev",
      kubeMode: "kube",
    });
    await expect(loadClusterMeta()).resolves.toEqual({
      kind: "ready",
      status: null,
      version: { controller: "dev", kubeMode: "kube" },
    });
  });

  it("版本失败 → ready + version null；两败 → 都 null（永不 reject）", async () => {
    vi.mocked(cluster.fetchClusterStatus).mockResolvedValue(status);
    vi.mocked(cluster.fetchControllerVersion).mockRejectedValue(
      new Error("HTTP 500"),
    );
    await expect(loadClusterMeta()).resolves.toEqual({
      kind: "ready",
      status,
      version: null,
    });
    vi.mocked(cluster.fetchClusterStatus).mockRejectedValue(new Error("boom"));
    await expect(loadClusterMeta()).resolves.toEqual({
      kind: "ready",
      status: null,
      version: null,
    });
  });
});

describe("接线", () => {
  it("ClusterSection 顶部挂载控制器卡（在 OpsOverview 之前）", () => {
    const section = srcText("manage/ClusterSection.tsx");
    expect(section).toContain('import ClusterMetaCard from "./ClusterMetaCard";');
    expect(section.indexOf("<ClusterMetaCard />")).toBeGreaterThan(-1);
    expect(section.indexOf("<ClusterMetaCard />")).toBeLessThan(
      section.indexOf("<OpsOverview active />"),
    );
  });

  it("卡片只在挂载时拉一次（无轮询 / 无定时器）", () => {
    const card = srcText("manage/ClusterMetaCard.tsx");
    expect(card).not.toContain("usePoller");
    expect(card).not.toContain("setInterval");
    expect(card).toContain("void loadClusterMeta()");
  });
});

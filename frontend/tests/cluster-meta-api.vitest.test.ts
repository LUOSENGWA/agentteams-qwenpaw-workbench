/**
 * 集群控制器元信息域（/status + /version）单测：
 * - 载荷映射（缺失/脏数据降级为空串/0；卡片显 "—" 而非 undefined）；
 * - 60s 内存缓存（同刻两次只拨一次；过期后重新拨号）；
 * - 失败不写缓存（原样抛，下次仍回源）；
 * - 两个端点都走现有 proxy（路径固定，卡片不直连 Controller）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { jsonMock } = vi.hoisted(() => ({ jsonMock: vi.fn() }));

vi.mock("../src/api/shared", () => ({ requestJson: jsonMock }));

import {
  CLUSTER_META_TTL_MS,
  fetchClusterStatus,
  fetchControllerVersion,
  mapClusterStatus,
  mapControllerVersion,
} from "../src/api/domains/cluster";
import { __clearCacheForTest } from "../src/requestCache";

const STATUS_PATH = "/agentteams-proxy/controller/api/v1/status";
const VERSION_PATH = "/agentteams-proxy/controller/api/v1/version";

beforeEach(() => {
  jsonMock.mockReset();
  __clearCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mapClusterStatus", () => {
  it("标准载荷逐字段映射", () => {
    expect(
      mapClusterStatus({
        kubeMode: "kube",
        totalWorkers: 5,
        totalTeams: 3,
        totalHumans: 9,
      }),
    ).toEqual({
      kubeMode: "kube",
      totalWorkers: 5,
      totalTeams: 3,
      totalHumans: 9,
    });
  });

  it("缺字段 / 类型异常 / null → 空串与 0（不抛）", () => {
    expect(mapClusterStatus(null)).toEqual({
      kubeMode: "",
      totalWorkers: 0,
      totalTeams: 0,
      totalHumans: 0,
    });
    expect(
      mapClusterStatus({ kubeMode: 1, totalWorkers: "5", totalHumans: NaN }),
    ).toEqual({
      kubeMode: "",
      totalWorkers: 0,
      totalTeams: 0,
      totalHumans: 0,
    });
  });
});

describe("mapControllerVersion", () => {
  it("标准载荷 + 老控制器 dev", () => {
    expect(mapControllerVersion({ controller: "dev", kubeMode: "kube" })).toEqual(
      { controller: "dev", kubeMode: "kube" },
    );
  });

  it("非对象 → 空串", () => {
    expect(mapControllerVersion("nope")).toEqual({
      controller: "",
      kubeMode: "",
    });
  });
});

describe("60s 缓存", () => {
  it("同刻两次只拨一次，返回映射后的对象", async () => {
    vi.useFakeTimers();
    jsonMock.mockResolvedValue({ kubeMode: "kube", totalWorkers: 2 });
    const a = await fetchClusterStatus();
    const b = await fetchClusterStatus();
    expect(jsonMock).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledWith(STATUS_PATH, undefined, 30000);
    expect(a).toEqual(b);
    expect(a).toEqual({
      kubeMode: "kube",
      totalWorkers: 2,
      totalTeams: 0,
      totalHumans: 0,
    });
  });

  it("TTL 内复用、过期后回源（60s 边界）", async () => {
    vi.useFakeTimers();
    jsonMock.mockResolvedValue({ controller: "1.2.5", kubeMode: "kube" });
    await fetchControllerVersion();
    vi.advanceTimersByTime(CLUSTER_META_TTL_MS - 1);
    await fetchControllerVersion();
    expect(jsonMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await fetchControllerVersion();
    expect(jsonMock).toHaveBeenCalledTimes(2);
    expect(jsonMock).toHaveBeenLastCalledWith(VERSION_PATH, undefined, 30000);
  });

  it("失败原样抛且不写缓存（下次重新拨号）", async () => {
    vi.useFakeTimers();
    jsonMock.mockRejectedValue(new Error("HTTP 403: nope"));
    await expect(fetchClusterStatus()).rejects.toThrow("HTTP 403: nope");
    await expect(fetchClusterStatus()).rejects.toThrow("HTTP 403: nope");
    expect(jsonMock).toHaveBeenCalledTimes(2);
  });
});

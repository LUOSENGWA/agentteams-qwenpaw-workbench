import type * as ReactNS from "react";

import {
  clearExportPassword,
  entryUrl,
  exportFullConfig,
  exportPasswordStatus,
  httpErrorStatus,
  importFullConfig,
  requestJson,
  setExportPassword,
  testAddresses,
  verifyAdmin,
} from "../api";
import type {
  AddressEntry,
  ConfigTestResponse,
  VerifyAdminResult,
  WorkbenchConfig,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { copyText } from "../util";
import { useWbViewport } from "../WbViewportContext";
import {
  buildAuthEntry,
  entryToAuthDraft,
  EMPTY_ADDR_AUTH,
} from "./SettingsTabShared";
import type { AddrAuthDraft } from "./SettingsTabShared";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const { message } = antd;

export function useSettingsTabCore({
  config,
  onConfigChange,
  onLoginSuccess,
}: {
  config: WorkbenchConfig | null;
  // config 加载态（加载中横幅 / 失败+重试 / 保存钮门控）。
  configLoadState: "loading" | "ready" | "failed";
  onRetryConfig: () => void;
  onConfigChange: () => void;
  // 登录（账号切换）成功后 → 清本地旧账号数据 + 全量刷新。
  onLoginSuccess?: () => void;
  // 12.14：聊天分栏强制开关（忽略宽度判定）。
  chatForceWide?: boolean;
  onChatForceWideChange?: (v: boolean) => void;
  // (S1-4)：事件流连接态（设置页可见——排障一眼定位 S1 类问题）。
  sseState?: { status: "connected" | "reconnecting"; since: number };
}) {
  const tr = useT();
  // 设置页 UI 整理——分节卡片底色跟随主题（宿主配色）。
  const t = useThemeColors();
  const { narrow } = useWbViewport();
  const cardBox: React.CSSProperties = {
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    padding: 12,
    background: t.cardBg,
  };
  const [matrixLan, setMatrixLan] = React.useState("");
  const [matrixWan, setMatrixWan] = React.useState("");
  // 地址手动固定档（auto=自动切换[默认] / lan=固定内网 / wan=固定外网）。
  const [addressMode, setAddressMode] = React.useState<"auto" | "lan" | "wan">("auto");
  const [controllerLan, setControllerLan] = React.useState("");
  const [controllerWan, setControllerWan] = React.useState("");
  const [controllerToken, setControllerToken] = React.useState("");
  // token 文件路径字段已删（「文件路径可以删掉了，
  // 留个命令就行」）——获取方式=下方命令提示 + 粘贴；env 作部署期注入兜底。
  // Higress Console 会话（admin 账号+密码，验证通过才
  // 由 verify-admin 持久化；普通保存不提交凭据）。密码不回填（脱敏），
  // 留空=保持已存值。
  const [adminUsername, setAdminUsername] = React.useState("");
  const [adminPassword, setAdminPassword] = React.useState("");
  // Higress 双地址——gatewayAdminUrl=内网（变量名保持省
  // diff），gatewayWan=外网（内网不可达时自动降级）。
  const [gatewayAdminUrl, setGatewayAdminUrl] = React.useState("");
  const [gatewayWan, setGatewayWan] = React.useState("");
  // 控制台特效三档（默认 light；取代旧
  // consoleCalm bool——light=动画保留+模糊封顶 / off=全停 / full=原样）。
  const [fxMode, setFxMode] = React.useState<"light" | "off" | "full">(
    "light",
  );
  const [verifying, setVerifying] = React.useState(false);
  const [verifyRes, setVerifyRes] = React.useState<VerifyAdminResult | null>(null);
  // 验证来源标记（10/17 用户：admin token 认证与 Higress 认证是两回事——
  // 错误回报各归各自块，不共享锚点）。
  const [verifySource, setVerifySource] = React.useState<
    "controller" | "higress" | null
  >(null);
  // 可选模块：集群负载（L1 专属）
  const [sglangEnabled, setSglangEnabled] = React.useState(false);
  // SGLang 双地址（内网/外网）——与 matrix/controller 同构。
  const [sglangLan, setSglangLan] = React.useState("");
  const [sglangWan, setSglangWan] = React.useState("");
  // 每地址公网凭据（key=<kind>:<idx>，idx 0=内网 1=外网）。
  const [addrAuth, setAddrAuth] = React.useState<Record<string, AddrAuthDraft>>(
    () => ({
      "matrix:0": EMPTY_ADDR_AUTH,
      "matrix:1": EMPTY_ADDR_AUTH,
      "controller:0": EMPTY_ADDR_AUTH,
      "controller:1": EMPTY_ADDR_AUTH,
      "sglang:0": EMPTY_ADDR_AUTH,
      "sglang:1": EMPTY_ADDR_AUTH,
    }),
  );
  const setAddrAuthFor = React.useCallback(
    (key: string, v: AddrAuthDraft) =>
      setAddrAuth((prev) => ({ ...prev, [key]: v })),
    [],
  );
  // 表单当前值 → 提交条目（URL + 可选凭据；空=空串，后端合并时丢弃）。
  // gateway 族（Higress 双地址，同构）。
  const buildAddrEntries = React.useCallback(
    (kind: "matrix" | "controller" | "sglang" | "gateway"): AddressEntry[] => {
      const urls =
        kind === "matrix"
          ? [matrixLan, matrixWan]
          : kind === "controller"
            ? [controllerLan, controllerWan]
            : kind === "gateway"
              ? [gatewayAdminUrl, gatewayWan]
              : [sglangLan, sglangWan];
      return [0, 1].map((i) =>
        buildAuthEntry(urls[i], addrAuth[`${kind}:${i}`] || EMPTY_ADDR_AUTH),
      );
    },
    [
      matrixLan,
      matrixWan,
      controllerLan,
      controllerWan,
      gatewayAdminUrl,
      gatewayWan,
      sglangLan,
      sglangWan,
      addrAuth,
    ],
  );
  // Controller 认证双模式（Matrix 登录 L2 / 管理员 token L1）。
  const [ctlMode, setCtlMode] = React.useState<"matrix" | "token">("matrix");
  const [loginUser, setLoginUser] = React.useState("");
  const [loginPassword, setLoginPassword] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [loggingIn, setLoggingIn] = React.useState(false);
  // 连通性测试（手动触发；后台每 120s 自动重排，此处只看结果）
  const [connTest, setConnTest] = React.useState<ConfigTestResponse | null>(null);
  const [testing, setTesting] = React.useState(false);
  const importInputRef = React.useRef<HTMLInputElement | null>(null);
  // 备份与恢复（含凭据完整配置）——导出=弹窗
  // 全文本（复制按钮）；导入=粘贴+确认（后端校验+先自动备份当前态+覆盖）。
  const [exportOpen, setExportOpen] = React.useState(false);
  const [exportText, setExportText] = React.useState("");
  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  // 完整备份门密码（P0：宿主鉴权可关 + 8088 绑 0.0.0.0 → 防匿名局域网
  // dump 整集群凭据）。pwHas=是否已设；exportPwOpen/exportPw=导出前密码
  // 输入弹窗；importPw=导入弹窗内的密码字段；setPwOpen/setPw/setPwConfirm=
  // 设置/修改密码弹窗。
  const [pwHas, setPwHas] = React.useState<boolean | null>(null);
  const [exportPwOpen, setExportPwOpen] = React.useState(false);
  const [exportPw, setExportPw] = React.useState("");
  const [importPw, setImportPw] = React.useState("");
  const [setPwOpen, setSetPwOpen] = React.useState(false);
  const [setPw, setSetPw] = React.useState("");
  const [setPwConfirm, setSetPwConfirm] = React.useState("");

  const downloadJson = React.useCallback(
    (filename: string, data: unknown) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [],
  );

  const exportConfig = React.useCallback(async () => {
    try {
      const cfg = await requestJson("/agentteams-proxy/config");
      downloadJson("agentteams-qwenpaw-workbench-config.json", cfg);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("导出失败"));
    }
  }, [downloadJson]);

  const importConfig = React.useCallback(
    async (e: ReactNS.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // 重置 input.value——同一文件可再次选择
      if (!file) return;
      try {
        const text = await file.text();
        const cfg = JSON.parse(text) as Record<string, unknown>;
        // 走专用 import 端点（非 PUT /config）——导入=用户显式整盘
        // 替换语义，自带「覆盖前状态备份」回滚点，且不受修订号门控
        // （14.30 无 rev 保存 409；导入不需要也不应需要旧页面状态）。
        await requestJson("/agentteams-proxy/config/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cfg),
        });
        message.success(tr("配置已导入"));
        onConfigChange();
      } catch (err) {
        message.error(
          err instanceof Error ? err.message : tr("导入失败（JSON 格式错误？）"),
        );
      }
    },
    [onConfigChange],
  );

  // 完整配置导出（含凭据）→ 门密码校验 → 弹窗全文本。
  // P0：宿主鉴权可关 + 8088 绑 0.0.0.0 → 导出含整集群明文凭据，须门密码。
  const exportFull = React.useCallback(async () => {
    try {
      const st = await exportPasswordStatus();
      setPwHas(st.has_password);
      if (!st.has_password) {
        message.warning(tr("请先设置完整备份密码（见下方「备份与恢复」）"));
        return;
      }
      setExportPw("");
      setExportPwOpen(true);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("读取备份密码状态失败"));
    }
  }, [tr]);

  // 输入门密码后真正执行导出。
  const doExportWithPw = React.useCallback(async () => {
    if (!exportPw) {
      message.warning(tr("请输入完整备份密码"));
      return;
    }
    setExportPwOpen(false);
    try {
      const cfg = await exportFullConfig(exportPw);
      setExportText(JSON.stringify(cfg, null, 2));
      setExportOpen(true);
      setExportPw("");
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("导出失败"));
    }
  }, [exportPw, tr]);

  // 设置/修改门密码（≥8 位，两次输入一致）。
  const openSetPw = React.useCallback(() => {
    setSetPw("");
    setSetPwConfirm("");
    setSetPwOpen(true);
  }, []);

  const doSetPw = React.useCallback(async () => {
    if (setPw !== setPwConfirm) {
      message.warning(tr("两次输入的密码不一致"));
      return;
    }
    try {
      await setExportPassword(setPw);
      setPwHas(true);
      setSetPwOpen(false);
      message.success(tr("完整备份密码已设置"));
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("设置失败"));
    }
  }, [setPw, setPwConfirm, tr]);

  const clearPw = React.useCallback(async () => {
    try {
      await clearExportPassword();
      setPwHas(false);
      message.success(tr("完整备份密码已清除（导出/导入将重新要求先设置）"));
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("清除失败"));
    }
  }, [tr]);

  // 组件挂载时读一次门密码状态（驱动「已设置/未设置」显示）。
  React.useEffect(() => {
    void exportPasswordStatus()
      .then((st) => setPwHas(st.has_password))
      .catch(() => setPwHas(null));
  }, []);

  // 复制兜底：navigator.clipboard 不可用（宿主 webview 差异）→ execCommand。
  const copySettingText = React.useCallback(
    (text: string) => {
      const done = () => message.success(tr("已复制到剪贴板"));
      const fail = () => message.error(tr("复制失败——请手动全选复制"));
      // typeof 守卫（与真值判断语义一致）：TS 5.9 对「函数引用真值判断 + 分支内
      // 普通函数调用」误报 TS2774，真值写法在分支体含函数调用时不可用。
      if (typeof navigator.clipboard?.writeText === "function") {
        copyText(text, (ok) => {
          if (ok) done();
          else fail();
        });
        return;
      }
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand("copy")) done();
        else fail();
      } catch {
        fail();
      } finally {
        document.body.removeChild(ta);
      }
    },
    [tr],
  );

  // 完整配置导入——粘贴 JSON → 后端校验 +
  // 自动备份当前配置 + 覆盖（失败 400 可读错误经 message 透出）。
  const doImportFull = React.useCallback(async () => {
    const text = importText.trim();
    if (!text) {
      message.warning(tr("请先粘贴配置 JSON"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      message.error(tr("导入失败（JSON 格式错误？）"));
      return;
    }
    if (!importPw) {
      message.warning(tr("请输入完整备份密码"));
      return;
    }
    setImporting(true);
    try {
      const res = await importFullConfig(parsed, importPw);
      message.success(
        res.restart === "none"
          ? tr("配置已导入（同步已自动重启）")
          : tr("配置已导入（建议刷新页面确认生效）"),
      );
      setImportOpen(false);
      setImportText("");
      setImportPw("");
      onConfigChange();
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("导入失败"));
    } finally {
      setImporting(false);
    }
  }, [importText, importPw, tr, onConfigChange]);

  const exportDiagnostic = React.useCallback(async () => {
    try {
      const [cfg, selfcheck] = await Promise.all([
        requestJson("/agentteams-proxy/config"),
        requestJson("/agentteams-proxy/selfcheck/all", { method: "POST" }),
      ]);
      downloadJson("agentteams-qwenpaw-workbench-diagnostic.json", {
        exported_at: new Date().toISOString(),
        config: cfg,
        selfcheck,
        version:
          (window as unknown as Record<string, unknown>)
            .__AGENTTEAMS_WORKBENCH_VERSION__ || "unknown",
      });
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("诊断包导出失败"));
    }
  }, [downloadJson]);

  // 回填 effect 冻结——首载（或换账号）
  // 后初始化一次，之后 config 引用变化（保存/验证/登录都触发 onConfigChange
  // → 主组件 re-GET → 新对象）不再重置表单草稿。此前用户未保存的凭据编辑
  // （如填了 Higress 密码、改了控制器 basic 密码）会被任意一次验证/保存
  // 引发的 config 刷新整体冲掉（「输完 Higress 账号密码，控制器的
  // basic 认证又要重新输入」）。换账号=doLogin→onLoginSuccess 清数据+重挂载，
  // 新实例自然重新初始化；user_id 变化兜底（同实例热切账号场景）。
  const backfillKeyRef = React.useRef<string>("");
  React.useEffect(() => {
    if (!config) return;
    const uid =
      ((config.matrix as { user_id?: string } | undefined)?.user_id as
        | string
        | undefined) || "";
    const key = uid || "__not-logged-in__";
    if (backfillKeyRef.current === key) return;
    backfillKeyRef.current = key;
    setMatrixLan(entryUrl(config.matrix_homeservers?.[0]));
    setMatrixWan(entryUrl(config.matrix_homeservers?.[1]));
    // 每地址凭据回填（脱敏 *** 不进
    // 输入框，存 stored 标记——空框=保持不变）。
    setAddrAuth({
      "matrix:0": entryToAuthDraft(config.matrix_homeservers?.[0]),
      "matrix:1": entryToAuthDraft(config.matrix_homeservers?.[1]),
      "controller:0": entryToAuthDraft(config.controller_urls?.[0]),
      "controller:1": entryToAuthDraft(config.controller_urls?.[1]),
      "sglang:0": entryToAuthDraft(config.sglang?.urls?.[0]),
      "sglang:1": entryToAuthDraft(config.sglang?.urls?.[1]),
      // Higress 双地址凭据（四地址族同构）。
      "gateway:0": entryToAuthDraft(config.gateway_admin_urls?.[0]),
      "gateway:1": entryToAuthDraft(config.gateway_admin_urls?.[1]),
    });
    // 地址模式回填（垃圾值后端已降级 auto）。
    setAddressMode(config.address_mode || "auto");
    setControllerLan(entryUrl(config.controller_urls?.[0]));
    setControllerWan(entryUrl(config.controller_urls?.[1]));
    // token 脱敏 *** 不进输入框（同密码协议：空框=
    // 保持不变；此前字面量回显 + 不清空直接输入 = 拼接串覆盖真 token）。
    setControllerToken(
      config.controller_token && config.controller_token !== "***"
        ? config.controller_token
        : "",
    );
    // admin 账号 / 网关地址回填；密码只标记「已配置」不回填。
    setAdminUsername(config.admin_username || "");
    // Higress 双地址（内/外网），legacy 单值回退内网框。
    setGatewayAdminUrl(
      entryUrl(config.gateway_admin_urls?.[0]) || config.gateway_admin_url || "",
    );
    setGatewayWan(entryUrl(config.gateway_admin_urls?.[1]));
    // 特效三档回填（旧 console_calm
    // bool 迁移：显式 false=full，其余=light）+ 门控属性同步（模块级已先写
    // light，此处以配置覆写；旧 data-wb-calm 已退役）。
    const _fxMode =
      config.console_effects ?? (config.console_calm === false ? "full" : "light");
    setFxMode(_fxMode);
    document.documentElement.dataset.wbFx = _fxMode;
    setAdminPassword("");
    setSglangEnabled(config.sglang?.enabled || false);
    // 双地址读取；旧配置单地址 url 回退（后端亦会迁移）。
    setSglangLan(entryUrl(config.sglang?.urls?.[0]) || config.sglang?.url || "");
    setSglangWan(entryUrl(config.sglang?.urls?.[1]) || "");
    // 已有 token（本地配置粘贴 / 宿主 env）的用户默认落在 L1 模式。
    if (
      config.controller_token ||
      config.controllerTokenSource === "env"
    )
      setCtlMode("token");
  }, [config]);

  const save = async () => {
    setSaving(true);
    try {
      const resp = await requestJson("/agentteams-proxy/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // 并发写保护——页面加载时的修订号；保存前磁盘配置已被外部
          // 改动 → 409（下方 catch 显形提示）。
          config_rev: config?.config_rev ?? undefined,
          // 损坏态（defaults-fallback）显式恢复：健康横幅已警示「当前
          // 在跑默认值」，用户仍选择保存=确认用表单值重建文件 → 放行
          // 防呆守卫（不传=守卫照常拦截，防误覆盖损坏现场）。
          force_persist:
            config?.config_health?.state === "defaults-fallback" || undefined,
          config: {
            // 条目 str | {url, auth?}（凭据随条目走）。
            matrix_homeservers: buildAddrEntries("matrix"),
            controller_urls: buildAddrEntries("controller"),
            // token 空=不覆盖已存（后端字段合并保留
            // 旧值；空串/脱敏 *** 都不落盘）——此前回显 *** 字面量+拼接=覆盖。
            controller_token: controllerToken || undefined,
            // 地址模式（auto/lan/wan）——保存后不重启即生效。
            address_mode: addressMode,
            // 特效三档直存。
            console_effects: fxMode,
            sglang: {
              enabled: sglangEnabled,
              urls: buildAddrEntries("sglang"),
            },
            // Higress 双地址（凭据随条目，四族同构）。
            gateway_admin_urls: buildAddrEntries("gateway"),
          },
        }),
      });
      // 凭据回读校验——落盘形态（str=无凭据/basic/
      // bearer）与表单意图逐位置对表，不一致=当场显形（「已保存但没
      // 记住」不再无痕：成功 toast 后紧跟警告列出异常位置）。
      const check: Record<string, string[] | undefined> =
        (resp as { credential_check?: Record<string, string[]> })
          ?.credential_check || {};
      const mismatch: string[] = [];
      const expect = (fam: "matrix" | "controller" | "sglang" | "gateway") => {
        const rows = buildAddrEntries(fam);
        const got = check[fam] || [];
        rows.forEach((entry, i) => {
          const isObj = typeof entry === "object" && entry !== null;
          const want = isObj
            ? (entry as { auth?: { type?: string } }).auth?.type || "str"
            : "str";
          if ((got[i] || "str") !== want) {
            mismatch.push(
              `${{ matrix: "Matrix", controller: "Controller", sglang: "SGLang", gateway: "Higress" }[fam]} 第 ${i + 1} 个地址`,
            );
          }
        });
      };
      (["matrix", "controller", "sglang", "gateway"] as const).forEach(expect);
      if (mismatch.length > 0) {
        message.warning(
          tr("部分地址凭据未按预期保存：{where}——请重新填写并保存", {
            where: mismatch.join("、"),
          }),
          6,
        );
      }
      message.success(tr("配置已保存（已自动探测生效地址）"));
      onConfigChange();
      // 保存后立即连通性测试——用户当场看到两条路径的延迟与状态。
      // 草稿凭据随测（未保存也能当场验证公网门）。
      // gateway=Higress 探测（诊断面）。
      void runConnTest(
        buildAddrEntries("matrix"),
        buildAddrEntries("controller"),
        buildAddrEntries("sglang"),
        buildAddrEntries("gateway"),
      );
    } catch (e) {
      // 409=页面打开后配置被外部改动——
      // 显性提示刷新重存，而不是把错误吞成一句「保存失败」。
      if (httpErrorStatus(e) === 409) {
        onConfigChange();
        message.error(
          tr(
            "配置已被外部修改——本页显示的是打开时的旧值，已放弃本次保存。请核对最新配置后再保存。",
          ),
          8,
        );
        return;
      }
      message.error(e instanceof Error ? e.message : tr("保存失败"));
    } finally {
      setSaving(false);
    }
  };

  // 连通性测试——测表单当前值（可未保存）；后端并行探测测延迟，
  // 列表与已配置一致时顺手按最快可达重排生效地址（applied）。
  // gateway=Higress 探测（可达性+会话三态，诊断面）。
  const runConnTest = React.useCallback(
    async (
      matrix?: AddressEntry[],
      controller?: AddressEntry[],
      sglang?: AddressEntry[],
      gateway?: AddressEntry[],
    ) => {
      setTesting(true);
      try {
        const res = await testAddresses(matrix, controller, sglang, gateway);
        setConnTest(res);
      } catch (e) {
        message.error(
          e instanceof Error ? e.message : tr("连通性测试失败"),
        );
      } finally {
        setTesting(false);
      }
    },
    [],
  );

  // L1 验证（Controller token / Higress 账号两块独立，验证通过才持久化凭据）。
  const runVerify = React.useCallback(
    async (body: {
      admin_username?: string;
      admin_password?: string;
      controller_token?: string;
      gateway_admin_url?: string;
      // Higress 双地址（列表优先；空框已过滤）。
      gateway_admin_urls?: string[];
    }) => {
      setVerifying(true);
      setVerifyRes(null);
      setVerifySource(
        body.admin_username || body.admin_password
          ? "higress"
          : "controller",
      );
      try {
        const res = await verifyAdmin(body);
        setVerifyRes(res);
        if (res.ok) {
          // token 模式带来源说明（config/env——env 不落盘，轮换=更新宿主 env）。
          message.success(
            res.mode === "token" && res.message
              ? tr("{msg}", { msg: res.message })
              : tr("验证通过（{mode}）", {
                  mode:
                    res.mode === "password"
                      ? tr("admin 账号密码（Higress Console 会话已持有）")
                      : tr("管理员 token"),
                }),
          );
          onConfigChange();
        }
      } catch (e) {
        setVerifyRes({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setVerifying(false);
      }
    },
    [onConfigChange, tr],
  );

  const doLogin = async () => {
    if (!loginUser || !loginPassword) {
      message.warning(tr("先填写 Matrix 账号和密码"));
      return;
    }
    setLoggingIn(true);
    try {
      await requestJson("/agentteams-proxy/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: loginUser, password: loginPassword }),
      });
      message.success(tr("登录成功"));
      onConfigChange();
      // 切账号 = 数据源切换。后端 /login 已同步清 60s 聚合缓存 +
      // 重置 sync 游标；前端本地旧账号的房间/树/管理数据必须清掉并重取，
      // 否则切完账号屏幕还挂着上一个账号的内容（真机反馈）。
      onLoginSuccess?.();
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("登录失败"));
    } finally {
      setLoggingIn(false);
    }
  };

  return {
    tr,
    t,
    narrow,
    cardBox,
    matrixLan,
    setMatrixLan,
    matrixWan,
    setMatrixWan,
    addressMode,
    setAddressMode,
    controllerLan,
    setControllerLan,
    controllerWan,
    setControllerWan,
    controllerToken,
    setControllerToken,
    adminUsername,
    setAdminUsername,
    adminPassword,
    setAdminPassword,
    gatewayAdminUrl,
    setGatewayAdminUrl,
    gatewayWan,
    setGatewayWan,
    fxMode,
    setFxMode,
    verifying,
    setVerifying,
    verifyRes,
    setVerifyRes,
    verifySource,
    setVerifySource,
    sglangEnabled,
    setSglangEnabled,
    sglangLan,
    setSglangLan,
    sglangWan,
    setSglangWan,
    addrAuth,
    setAddrAuth,
    setAddrAuthFor,
    buildAddrEntries,
    ctlMode,
    setCtlMode,
    loginUser,
    setLoginUser,
    loginPassword,
    setLoginPassword,
    saving,
    setSaving,
    loggingIn,
    setLoggingIn,
    connTest,
    setConnTest,
    testing,
    setTesting,
    importInputRef,
    exportOpen,
    setExportOpen,
    exportText,
    setExportText,
    importOpen,
    setImportOpen,
    importText,
    setImportText,
    importing,
    setImporting,
    pwHas,
    setPwHas,
    exportPwOpen,
    setExportPwOpen,
    exportPw,
    setExportPw,
    importPw,
    setImportPw,
    setPwOpen,
    setSetPwOpen,
    setPw,
    setSetPw,
    setPwConfirm,
    setSetPwConfirm,
    downloadJson,
    exportConfig,
    importConfig,
    exportFull,
    doExportWithPw,
    openSetPw,
    doSetPw,
    clearPw,
    copySettingText,
    doImportFull,
    exportDiagnostic,
    backfillKeyRef,
    save,
    runConnTest,
    runVerify,
    doLogin,
  };
}

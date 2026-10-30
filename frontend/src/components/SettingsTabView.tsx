import type * as ReactNS from "react";

import { requestJson } from "../api";
import type { AddressEntry } from "../api";
import { formatTimeOfDay } from "../util";
import {
  CheckIcon,
  RefreshIcon,
  SearchIcon,
  WarnIcon,
} from "./icons";
import { useSettingsTabCore } from "./SettingsTabCore";
import {
  AddrAuthEditor,
  ConnRow,
  EffectiveBadge,
  EMPTY_ADDR_AUTH,
  StartupPrefRow,
} from "./SettingsTabShared";
import HelpDot from "./HelpDot";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const { message } = antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const DownloadIcon = pick("DownloadOutlined");
const UploadIcon = pick("UploadOutlined");
const FileZipOutlined = pick("FileZipOutlined");
// 备份与恢复——导出弹窗复制按钮。
const CopyIcon = pick("CopyOutlined");

// 15.36 D：地址模式/特效档说明（label 精简后完整语义进 ? tooltip；
// 原选项文案逐字保留为 tooltip 文字，creds.ts 对应键继续登记）。
const ADDR_MODE_HELP: Record<"auto" | "lan" | "wan", string> = {
  auto: "自动（默认：最快可达自动切换）",
  lan: "固定内网（失败不自动切换）",
  wan: "固定外网（失败不自动切换）",
};
const FX_MODE_HELP: Record<"light" | "off" | "full", string> = {
  light: "轻量（默认：动画保留，模糊半径封顶，省 GPU）",
  off: "关闭特效（最省电：动画与模糊全停）",
  full: "完整特效（上游原样，最费 GPU）",
};

export function SettingsTabView(props: {
  p: Parameters<typeof useSettingsTabCore>[0];
  c: ReturnType<typeof useSettingsTabCore>;
}) {
  const { p, c } = props;
  const {
    config,
    configLoadState,
    onRetryConfig,
    onConfigChange,
    chatForceWide,
    onChatForceWideChange,
    sseState,
  } = p;
  const {
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
    verifyRes,
    verifySource,
    sglangEnabled,
    setSglangEnabled,
    sglangLan,
    setSglangLan,
    sglangWan,
    setSglangWan,
    addrAuth,
    setAddrAuthFor,
    buildAddrEntries,
    ctlMode,
    setCtlMode,
    loginUser,
    setLoginUser,
    loginPassword,
    setLoginPassword,
    saving,
    loggingIn,
    connTest,
    testing,
    importInputRef,
    exportOpen,
    setExportOpen,
    exportText,
    importOpen,
    setImportOpen,
    importText,
    setImportText,
    importing,
    pwHas,
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
    save,
    runConnTest,
    runVerify,
    doLogin,
  } = c;
  return (
    /* 10/30：配置页卡片按屏幕宽度自动排列——外层通栏承载横幅（通栏语义），
       内层卡片区 auto-fit（宽屏 2–3 列、窄屏自动 1 列），不再单列 720px 定宽。 */
    <div style={{ display: "grid", gap: 24, maxWidth: 1280 }}>
      {/* config 加载态横幅——加载中/失败必须显式。
 静默吞错会让用户把默认态当成已保存值（「没有记忆」事故根因）。 */}
      {config === null && (
        <div
          style={{
            ...cardBox,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
            color: configLoadState === "failed"
              ? (t.mode === "dark" ? "#ff7875" : "#d4380d")
              : t.textSecondary,
            border:
              configLoadState === "failed"
                ? `1px solid ${t.mode === "dark" ? "rgba(255,77,79,0.35)" : "#ffccc7"}`
                : undefined,
          }}
        >
          {configLoadState === "failed" ? (
            <>
              <span>
                {tr(
                  "配置加载失败（插件后端可能正在重载）。页面上显示的是默认值，不是你的已保存配置——请勿直接保存，以免覆盖。",
                )}
              </span>
              {/* 按钮对齐 QwenPaw 风格——antd Button
  继承主题 token（主色/圆角/悬停/焦点环），不再手写边框。 */}
              <antd.Button
                size="small"
                danger
                onClick={onRetryConfig}
              >
                {tr("重试")}
              </antd.Button>
            </>
          ) : (
            <span>{tr("正在加载已保存配置…")}</span>
          )}
        </div>
      )}
      {/* ：配置健康横幅——后端主配置缺失/损坏时
  在跑默认值（defaults-fallback）或刚从备份自愈（restored-from-backup），
  页面必须显形：此时的表单是默认值而非用户配置，直接保存会把默认值
  盖回去（「内外网变回自动」类事故的 UI 侧防线）。 */}
      {config !== null &&
        (config.config_health?.state === "defaults-fallback" ||
          config.config_health?.state === "restored-from-backup") && (
        <div
          style={{
            ...cardBox,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
            color: t.mode === "dark" ? "#ff7875" : "#d4380d",
            border: `1px solid ${t.mode === "dark" ? "rgba(255,77,79,0.35)" : "#ffccc7"}`,
          }}
        >
          <span>
            {tr(
              config.config_health?.state === "defaults-fallback"
                ? "配置主文件缺失或损坏且无备份——当前运行在默认值上，本页显示的是默认值。请先用「导入」恢复配置，或重新填写后保存（将写回新文件）。"
                : "配置主文件缺失或损坏，已从备份 config.bak.json 自动恢复。请核对设置是否完整。",
            )}
          </span>
        </div>
      )}
      {/* 未加载锁（14.30）：config===null（加载窗口/失败）时整个表单
  只读显形——此前默认态表单完整可编辑观感（密码框空着像要填），
  用户误判「配置丢了」重填（今早实锤）；10/8 wipe 的触发面也在此。
  保存按钮另被 disabled 门控、后端另有 no-rev 409 兜底，三层互备。 */}
      <div
        style={{
          display: "grid",
          // auto-fit：每列最小 340px 自适应——宽屏 2–3 列、窄屏自动落回 1 列；
          // alignItems:start 让各卡保持自然高度（不等高拉伸）。
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          alignItems: "start",
          gap: 24,
          opacity: config === null ? 0.45 : 1,
          pointerEvents: config === null ? "none" : undefined,
        }}
        aria-disabled={config === null || undefined}
      >
      {/* ：分节卡片化——「聊天页面」卡片。 */}
      <div style={{ gridColumn: "1 / -1", ...cardBox, fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
        {tr("内网和外网是同一服务器的两条访问路径（家里用内网 IP，外出用公网域名），无需手动切换——插件每 2 分钟自动重测全部地址（测延迟），自动切到最快可达的一条，外网/内网切换自动识别。")}
      </div>


      {/* 「访问地址」卡片。 */}
      <div style={{ gridColumn: "1 / -1", ...cardBox, display: "grid", gap: 16 }}>
        <div style={{ fontWeight: 700 }}>{tr("访问地址")}</div>
        {/* 凭据记忆状态总览——每个系统凭据是否已保存
 一眼可见（每个账号密码的认证都要分开的可视化）。 */}
        {config ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 6,
              fontSize: 12,
              padding: 8,
              borderRadius: 6,
              background: "rgba(128,128,128,0.06)",
            }}
          >
            {([
              [
                tr("Matrix 登录"),
                Boolean((config.matrix as { user_id?: string } | undefined)?.user_id),
              ],
              [
                tr("Controller token"),
                Boolean(config.controllerTokenSource && config.controllerTokenSource !== "invalid"),
              ],
              [
                tr("Controller 地址凭据"),
                (config.controller_urls || []).some((e) => typeof e === "object" && e !== null && (e as { auth?: unknown }).auth),
              ],
              [
                tr("Higress 账号（Console 会话）"),
                Boolean(config.admin_username) && Boolean(config.console_session),
              ],
              [
                tr("Higress 地址凭据"),
                (config.gateway_admin_urls || []).some((e) => typeof e === "object" && e !== null && (e as { auth?: unknown }).auth),
              ],
              [
                tr("SGLang 地址凭据（通常不需要）"),
                ((config.sglang as { urls?: AddressEntry[] } | undefined)?.urls || []).some((e) => typeof e === "object" && e !== null && (e as { auth?: unknown }).auth),
              ],
            ] as [string, boolean][]).map(([label, on]) => (
              <span
                key={label}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
                // // 悬停说明——SGLang 是本地推理服务，自身无认证；只有访问
                // 地址后面套了网关 Basic 门才需要，默认留空。
                title={label.includes("SGLang")
                  ? tr("SGLang 通常不需要凭据（本地推理服务自身无认证）——仅当访问地址经公网网关 Basic 门时填写，默认留空。")
                  : undefined}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: on ? "#52c41a" : "#d9d9d9",
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: on ? t.text : t.textSecondary }}>{label}</span>
              </span>
            ))}
          </div>
        ) : null}
        {/* (S1-4)：事件流连接态——「断开自动重连」从黑箱变可见。 */}
        {sseState ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 6,
              background: sseState.status === "connected" ? "#f6ffed" : "#fffbe6",
              border: `1px solid ${sseState.status === "connected" ? "#b7eb8f" : "#ffe58f"}`,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: sseState.status === "connected" ? "#52c41a" : "#faad14",
                flexShrink: 0,
              }}
            />
            {sseState.status === "connected"
              ? tr("事件流：已连接")
              : tr("事件流：已断开——自动重连中（上次断开 {time}）", {
                  time: formatTimeOfDay(sseState.since),
                })}
          </div>
        ) : null}
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Matrix 地址（必填至少一个）
            <EffectiveBadge url={config?.effective?.matrix} label={tr("当前")} />
          </div>
          <antd.Input
            placeholder={tr("内网：http://192.168.x.x:6867")}
            value={matrixLan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setMatrixLan(e.target.value)
            }
            style={{ marginBottom: 8 }}
          />
          <AddrAuthEditor
            value={addrAuth["matrix:0"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("matrix:0", v)}
          />
          <antd.Input
            placeholder={tr("外网：https://你的域名:6867（可留空）")}
            value={matrixWan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setMatrixWan(e.target.value)
            }
          />
          <AddrAuthEditor
            value={addrAuth["matrix:1"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("matrix:1", v)}
          />
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("Controller 地址（L1/CRD 管理/Worker/Team 状态依赖；不填仅房间侧功能）")}
            <EffectiveBadge url={config?.effective?.controller} label={tr("当前")} />
          </div>
          <antd.Input
            placeholder={tr("内网：http://192.168.x.x:8090（可留空）")}
            value={controllerLan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setControllerLan(e.target.value)
            }
            style={{ marginBottom: 8 }}
          />
          <AddrAuthEditor
            value={addrAuth["controller:0"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("controller:0", v)}
          />
          <antd.Input
            placeholder={tr("外网：https://你的域名:8090（可留空）")}
            value={controllerWan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setControllerWan(e.target.value)
            }
          />
          <AddrAuthEditor
            value={addrAuth["controller:1"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("controller:1", v)}
          />
        </div>

 {/* Higress 地址并入地址配置区（与
 Matrix/Controller/SGLang 同处），内网/外网按序降级、受地址模式
 固定档控制。
 Higress=模型管理面=L1 专属 → L2 模式
 隐藏（如果是 L2 登录，该隐藏的就隐藏）。 */}
        {ctlMode === "token" && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("Higress Console 地址（模型管理面；内网/外网按序降级）")}
            <EffectiveBadge url={config?.effective?.gateway} label={tr("当前")} />
          </div>
          <antd.Input
            placeholder={tr("Higress 地址·内网（Console 管理面；宿主端口部署时自选，默认 18001）")}
            value={gatewayAdminUrl}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setGatewayAdminUrl(e.target.value)
            }
            style={{ marginBottom: 8 }}
          />
          {/* Higress 内网地址覆盖凭据（四族同构；
 公网入口挂 Basic/key 门时用）。 */}
          <AddrAuthEditor
            value={addrAuth["gateway:0"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("gateway:0", v)}
          />
          <antd.Input
            placeholder={tr("Higress 地址·外网（公网入口，可留空；内网不可达时自动降级）")}
            value={gatewayWan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setGatewayWan(e.target.value)
            }
            style={{ marginBottom: 8 }}
          />
          <AddrAuthEditor
            value={addrAuth["gateway:1"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("gateway:1", v)}
          />
        </div>
        )}

        {/* 地址手动固定档——固定档请求只用固定地址、失败
 诚实报错不静默 failover；探测循环照跑（显示层不受影响）。 */}
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("地址模式（内网/外网切换策略）")}
          </div>
          {/* 15.36 D：label 精简（完整说明进右侧 ? tooltip） */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <antd.Select
              value={addressMode}
              disabled={config === null}
              onChange={(v: "auto" | "lan" | "wan") => {
                setAddressMode(v);
                // 模式变更即落盘——修复「改了但
                // 未点保存 → 重开跳回自动」。轻量 PUT，仅 address_mode 一键。
                // config 未就绪时禁止落盘——默认态
                // 的「auto」一键 PUT 会覆盖已保存模式（与保存门控同源）。
                if (config === null) {
                  message.warning(tr("配置尚未加载完成，暂不能保存"));
                  return;
                }
                void (async () => {
                  try {
                    await requestJson("/agentteams-proxy/config", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      // 带修订号——14.30 起无 rev 保存（磁盘有文件时）409，
                      // 防陈旧标签页/默认态覆盖。rev 过期=外部改过磁盘，
                      // 409 显形提示刷新，不误覆盖。
                      body: JSON.stringify({
                        config: { address_mode: v },
                        config_rev: config.config_rev,
                      }),
                    });
                    message.success(tr("地址模式已保存并即时生效"));
                    onConfigChange();
                  } catch {
                    message.error(tr("地址模式保存失败，请重试"));
                  }
                })();
              }}
              style={{ flex: 1, minWidth: 0 }}
              options={[
                { value: "auto", label: tr("自动") },
                { value: "lan", label: tr("固定内网") },
                { value: "wan", label: tr("固定外网") },
              ]}
            />
            <HelpDot title={tr(ADDR_MODE_HELP[addressMode])} />
          </div>
          <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
            {tr("切换即自动保存并生效。固定档下后台探测照跑（连通性测试仍可见另一条路径状态），但请求不再自动切换；失败会明确报错。")}
          </div>
        </div>

        {/* 控制台特效三档（light 默认；取代
 旧 console_calm 开关）。light=动画保留+模糊半径封顶（观感保留、
 成本降一个量级）；off=最省电（动画与模糊全停）；full=上游原样。 */}
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("控制台特效质量")}
          </div>
          {/* 15.36 D：label 精简（完整说明进右侧 ? tooltip） */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <antd.Select
              value={fxMode}
              onChange={(v: "light" | "off" | "full") => {
                setFxMode(v);
                document.documentElement.dataset.wbFx = v;
                // config 未就绪时禁止落盘（与地址模式同源）。
                if (config === null) {
                  message.warning(tr("配置尚未加载完成，暂不能保存"));
                  return;
                }
                // 与地址模式同款：变更即落盘（轻量 PUT，带修订号——
                // 14.30 无 rev 409 门控，同地址模式路径）。
                void (async () => {
                  try {
                    await requestJson("/agentteams-proxy/config", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        config: { console_effects: v },
                        config_rev: config.config_rev,
                      }),
                    });
                    message.success(tr("特效档已保存并即时生效"));
                    onConfigChange();
                  } catch {
                    message.error(tr("特效档保存失败，请重试"));
                  }
                })();
              }}
              style={{ flex: 1, minWidth: 0 }}
              options={[
                { value: "light", label: tr("轻量") },
                { value: "off", label: tr("关闭特效") },
                { value: "full", label: tr("完整特效") },
              ]}
            />
            <HelpDot title={tr(FX_MODE_HELP[fxMode])} />
          </div>
        </div>

        {/* 连通性测试——逐地址测延迟，外/内网识别可视化。
 测表单当前值（可未保存）；保存成功后自动跑一次。 */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <antd.Button
              size="small"
              loading={testing}
              onClick={() =>
                void runConnTest(
                  buildAddrEntries("matrix"),
                  buildAddrEntries("controller"),
                  sglangEnabled ? buildAddrEntries("sglang") : [],
                  // Higress 双地址（内网框非空才测）。
                  gatewayAdminUrl.trim() || gatewayWan.trim()
                    ? buildAddrEntries("gateway")
                    : [],
                )
              }
            >
              <SearchIcon size={14} style={{ verticalAlign: "-2px" }} /> {tr("连通性测试")}
            </antd.Button>
            <span style={{ fontSize: 12, color: "#888" }}>
              {tr("逐个地址测延迟（失败重试一次），识别外网/内网，测完自动切到最快；后台按状态自适应重测（稳定时低频、单地址不探测）")}
            </span>
          </div>
          {connTest ? (
            <div style={{ display: "grid", gap: 6, fontSize: 12 }}>
              {connTest.matrix.map((r) => (
                <ConnRow
                  key={`m-${r.url}`}
                  row={r}
                  tag="Matrix"
                  // 固定档——固定地址即使另一条更快也显示生效。
                  active={
                    connTest.effective.matrix === r.url ||
                    connTest.pinned?.matrix === r.url
                  }
                  pinned={connTest.pinned?.matrix === r.url}
                />
              ))}
              {connTest.controller.map((r) => (
                <ConnRow
                  key={`c-${r.url}`}
                  row={r}
                  tag="Controller"
                  active={
                    connTest.effective.controller === r.url ||
                    connTest.pinned?.controller === r.url
                  }
                  pinned={connTest.pinned?.controller === r.url}
                />
              ))}
              {connTest.sglang
                ? connTest.sglang.map((r) => (
                    <ConnRow
                      key={`s-${r.url}`}
                      row={r}
                      tag="SGLang"
                      active={false}
                      pinned={connTest.pinned?.sglang === r.url}
                    />
                  ))
                : null}
              {/* Higress 探测行（诊断面；含会话三态）。 */}
              {connTest.gateway?.length
                ? connTest.gateway.map((r) => (
                    <ConnRow
                      key={`g-${r.url}`}
                      row={r}
                      tag="Higress"
                      active={false}
                      pinned={connTest.pinned?.gateway === r.url}
                      showDetail
                    />
                  ))
                : null}
            </div>
          ) : null}
          {/* 测完自动切换要可见——横幅说清切没切、切到哪 */}
          {connTest ? (
            <div
              style={{
                marginTop: 8,
                fontSize: 12,
                padding: "6px 10px",
                borderRadius: 6,
                background: connTest.applied
                  ? connTest.switched?.matrix || connTest.switched?.controller
                    ? "color-mix(in srgb, var(--app-accent, #FF7F16) 8%, transparent)"
                    : "rgba(82,196,26,0.08)"
                  : "rgba(128,128,128,0.08)",
              }}
            >
              {connTest.applied ? (
                connTest.switched?.matrix || connTest.switched?.controller ? (
                  <>
                    <RefreshIcon size={13} style={{ verticalAlign: "-2px" }} /> {tr("已自动切换到最快可达")}：
                    {[
                      connTest.switched?.matrix
                        ? `Matrix → ${connTest.effective.matrix}`
                        : null,
                      connTest.switched?.controller
                        ? `Controller → ${connTest.effective.controller}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join("；")}
                  </>
                ) : (
                  <>
                    <CheckIcon size={13} style={{ color: "#52c41a", verticalAlign: "-2px" }} /> {tr("当前生效地址已是最快，无变化")}
                  </>
                )
              ) : (
                <>
                  {tr("测的是未保存的地址——保存后自动按延迟切换生效")}
                </>
              )}
            </div>
          ) : null}
        </div>

      </div>

      {/* 「认证」卡片（Controller 认证 + 启动偏好）。 */}
      <div style={{ gridColumn: "1 / -1", ...cardBox, display: "grid", gap: 16 }}>
        <div style={{ fontWeight: 700 }}>{tr("认证与登录")}</div>
        {/* Controller 认证双模式（用户需求）——「用 admin 的 matrix
 账号登录」或「输入 Controller 管理员 token」。无 API 可取 admin
 token（上游安全设计）；L2 需 Human level=2，level-1 走 Matrix
 登录会被 Controller 401（权限自检有对应提示）。 */}
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("Controller 认证（可选）")}
          </div>
          {/* 竖屏（376 点名）：Segmented 两长标签横排超宽 → 窄屏改
      Radio 纵向（业界移动端 segmented 溢出标准解法=单选纵列）。 */}
          {narrow ? (
            <antd.Radio.Group
              style={{ display: "grid", gap: 6, marginBottom: 8 }}
              value={ctlMode}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => {
                const m = e.target.value as "matrix" | "token";
                setCtlMode(m);
                if (m === "matrix" && controllerToken) setControllerToken("");
              }}
            >
              <antd.Radio value="matrix">{tr("Matrix 登录（L2，默认）")}</antd.Radio>
              <antd.Radio value="token">{tr("L1 管理面（Controller 管理员 token）")}</antd.Radio>
            </antd.Radio.Group>
          ) : (
            <antd.Segmented
              size="small"
              style={{ marginBottom: 8 }}
              value={ctlMode}
              onChange={(v: string | number) => {
                const m = v as "matrix" | "token";
                setCtlMode(m);
                if (m === "matrix" && controllerToken) setControllerToken("");
              }}
              options={[
                { label: tr("Matrix 登录（L2，默认）"), value: "matrix" },
                { label: tr("L1 管理面（Controller 管理员 token）"), value: "token" },
              ]}
            />
          )}
          {/* （14.17 「Matrix 登录和认证/登录卡片
 是不是重复或者冲突」）：一行点破两者关系——Matrix 登录是
 AgentTeams 消息系统的账号（=上方 Matrix 地址区同一账号），
 与 QwenPaw 页面自身的登录无关。 */}
          <div style={{ fontSize: 11.5, color: "#888", marginBottom: 10, lineHeight: 1.6 }}>
            {tr("「Matrix 登录」= AgentTeams 消息系统账号（与上方 Matrix 地址同一账号，L2 只读）；与 QwenPaw 页面自身的登录是两回事，不冲突。")}
          </div>
          {ctlMode === "token" ? (
            <div style={{ display: "grid", gap: 14 }}>
              {/* （14.17 「Higress 的认证和 controller
 token 认证应该分开吧」）：两块凭据拆成视觉上独立的两块——
 各带系统归属行，不再是「一套认证里的两个字段」。 */}
              <div style={{ display: "grid", gap: 6, padding: "8px 10px", background: t.hoverBg, borderRadius: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {tr("① Controller 认证（管理面：CRD/全量视图/日志）")}
                </div>
                <div style={{ fontSize: 11.5, color: "#888", lineHeight: 1.6 }}>
                  {tr("Controller 只认 SA token 与 Matrix token（Matrix 路径只放行 L2/L3 只读，L1 明确 401，无密码登录端点）——admin 能力只能来自管理员 token。")}
                </div>
                {/* （「controller token 的文件路径可以
 删掉了，留个命令就行」）：文件路径字段删除，留获取命令。 */}
                <div style={{ fontSize: 11, color: "#888", lineHeight: 1.6 }}>
                  {tr("获取命令（在 Controller 宿主机执行，复制输出粘贴到下方）：")}
                  <code
                    style={{
                      display: "block",
                      padding: "3px 6px",
                      background: t.mode === "dark" ? "rgba(255,255,255,0.08)" : "#f5f5f5",
                      borderRadius: 4,
                      fontSize: 11,
                      userSelect: "all",
                    }}
                  >
                    docker exec agentteams-controller cat /var/run/agentteams/cli-token
                  </code>
                  {tr("非 docker 部署：部署期给 QwenPaw 进程注入环境变量 AGENTTEAMS_CONTROLLER_TOKEN（注入值优先于粘贴值需重贴才覆盖）。")}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <antd.Input.Password
                    placeholder={tr("粘贴 token 内容（见上方获取命令；部署期注入 env 时留空即可）")}
                    value={controllerToken}
                    onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                      setControllerToken(e.target.value)
                    }
                    style={{ flex: 1 }}
                  />
                  <antd.Button
                    size="small"
                    loading={verifying}
                    /* env 可用时留空也可验证（后端按 粘贴>env 解析）。 */
                    disabled={
                      !controllerToken.trim() &&
                      config?.controllerTokenSource !== "env"
                    }
                    onClick={() =>
                      void runVerify({
                        controller_token: controllerToken.trim() || undefined,
                      })
                    }
                  >
                    {tr("验证")}
                  </antd.Button>
                </div>
                {/* token 来源状态提示（值永不离开连接器进程，只见来源标记）。 */}
                {config?.controllerTokenSource === "env" ? (
                  <div style={{ fontSize: 12, color: "#389e0d" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><CheckIcon size={13} /> {tr("当前使用 QwenPaw 宿主环境变量 AGENTTEAMS_CONTROLLER_TOKEN（手动粘贴的值优先。）")}</span>
                  </div>
                ) : config?.controllerTokenSource === "invalid" ? (
                  <div style={{ fontSize: 12, color: "#cf1322" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><WarnIcon size={13} /> {tr("token 内容含非法字符（复制时混入不可见字符）——重新复制纯 ASCII 内容，或改用 env 注入。")}</span>
                  </div>
                ) : null}
              </div>
              {/* ② Higress Console 认证已移至下方独立段（10/17 用户：两套认证是两回事）。 */}
              {verifyRes && !verifyRes.ok && verifySource === "controller" ? (
                <div
                  style={{
                    fontSize: 12,
                    color: "#cf1322",
                    background: "rgba(245,34,45,0.08)",
                    padding: "6px 10px",
                    borderRadius: 6,
                  }}
                >
                  {tr("验证失败：{err}", { err: verifyRes.error || "" })}
                </div>
              ) : null}
            </div>
          ) : (
            <div
              style={{
                fontSize: 12,
                color: "#888",
                marginBottom: 6,
                background: t.toolBg,
                padding: "6px 10px",
                borderRadius: 6,
              }}
            >
              {tr("使用当前登录的 Matrix 账号，无需 token。注意：Controller 的 Matrix 认证只接受权限等级 2（level 2）的 Human 账号——level 1 的 admin 账号会 401，请改用管理员 token 模式，或让部署管理员把该 Human 改为 level 2（权限自检可见当前账号等级）。")}
            </div>
          )}
          {/* ② Higress Console 认证——独立认证系统（10/17 用户：admin token 认证
     与 Higress 认证是两回事——不再隶属 L1 管理面模式；模型面 alias/提供商/路由
     与 Controller 认证模式无关，独立配置）。 */}
          <div style={{ display: "grid", gap: 10, marginTop: 14, padding: "10px 12px", border: "1px solid rgba(128,128,128,0.18)", borderRadius: 8 }}>
              <div style={{ display: "grid", gap: 6, padding: "8px 10px", background: t.hoverBg, borderRadius: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {tr("② Higress Console 认证（模型面：alias/提供商/路由）——独立认证系统，与 ① Controller 认证互不相关")}
                </div>
                <div style={{ fontSize: 11.5, color: "#888", lineHeight: 1.6 }}>
                  {tr("Higress Console 自己的账号体系（admin 账号+密码），与 Controller 认证互不相关、可各自独立配置。即使某部署中两者恰好同值，它们仍是两个不同系统的凭证——不可互相替代。")}
                </div>
                <antd.Input
                  placeholder={tr("admin 账号（如 admin）")}
                  value={adminUsername}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setAdminUsername(e.target.value)
                  }
                />
                <antd.Input.Password
                  placeholder={tr(
                    config?.admin_password
                      ? "admin 密码（已保存 · 留空保持不变）"
                      : "admin 密码",
                  )}
                  value={adminPassword}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setAdminPassword(e.target.value)
                  }
                />
                <div style={{ fontSize: 11, color: "#999", lineHeight: 1.5 }}>
                  {tr("密码安全起见永不回显——框空白不代表没记住；留空保存=沿用已存密码。")}
                </div>
                <div>
                  <antd.Button
                    size="small"
                    loading={verifying}
                    disabled={
                      !adminUsername.trim() && !adminPassword.trim()
                    }
                    onClick={() =>
                      void runVerify({
                        admin_username: adminUsername.trim(),
                        admin_password: adminPassword.trim() || undefined,
                        // 双地址（内/外网；空框过滤）。
                        gateway_admin_urls: [
                          gatewayAdminUrl.trim(),
                          gatewayWan.trim(),
                        ].filter(Boolean),
                      })
                    }
                  >
                    {tr("验证")}
                  </antd.Button>
                  <span style={{ fontSize: 11.5, color: "#888", marginLeft: 8 }}>
                    {tr("验证通过后自动保存（仅建立 Higress Console 会话；与 Controller token 无关，两者可同时配置）")}
                  </span>
                </div>
              </div>
              {verifyRes && !verifyRes.ok && verifySource === "higress" ? (
                <div
                  style={{
                    fontSize: 12,
                    color: "#cf1322",
                    background: "rgba(245,34,45,0.08)",
                    padding: "6px 10px",
                    borderRadius: 6,
                  }}
                >
                  {tr("验证失败：{err}", { err: verifyRes.error || "" })}
                </div>
              ) : null}
              {/* 验证成功常驻回报——alias 层自检
 （实报「还是看不见」= 静默平铺无锚点；验证即诊断，
 0 alias 时直接列出路由数与原因方向，不用再猜）。 */}
              {verifyRes && verifyRes.ok && verifyRes.gateway_routes !== undefined ? (
                <div
                  style={{
                    fontSize: 12,
                    color:
                      verifyRes.gateway_aliases && verifyRes.gateway_aliases.length > 0
                        ? (t.mode === "dark" ? "#95de64" : "#389e0d")
                        : (t.mode === "dark" ? "#faad14" : "#d46b08"),
                    background:
                      verifyRes.gateway_aliases && verifyRes.gateway_aliases.length > 0
                        ? "rgba(82,196,26,0.08)"
                        : "rgba(250,173,20,0.1)",
                    padding: "6px 10px",
                    borderRadius: 6,
                    display: "grid",
                    gap: 4,
                  }}
                >
                  {verifyRes.gateway_aliases && verifyRes.gateway_aliases.length > 0 ? (
                    <span>
                      {tr("Higress alias 自检：{n} 条路由 / {m} 个可解析 alias（模型下拉可见）", {
                        n: String(verifyRes.gateway_routes),
                        m: String(verifyRes.gateway_aliases.length),
                      })}
                      <span style={{ color: "#888" }}>
                        {" — " + verifyRes.gateway_aliases.join("、")}
                      </span>
                    </span>
                  ) : (
                    <span>
                      {tr("Higress alias 自检：{n} 条路由 / 0 个可解析 alias——精确匹配（EXACT/EQUAL）且 provider 存在的路由才会进模型下拉；若路由已配仍为 0，检查模型匹配规则是否为「精确匹配」", {
                        n: String(verifyRes.gateway_routes),
                      })}
                    </span>
                  )}
                </div>
              ) : null}
              {/* （L1 路径 A 成功后明示「还需 Controller
 token」）——路径 A（账号+密码）只建立 Higress Console 会话
 （模型下拉 alias 面）；Worker 运行配置 L1 字段 / CRD 管理
 需要 Controller 管理员 token（另一套凭证，无签发端点）。
 密码验证通过且 token 未配 → 常驻指引（取法命令 + 回贴入口）。 */}
              {verifyRes &&
              verifyRes.ok &&
              verifyRes.mode === "password" &&
              !(
                config?.controller_token ||
                config?.controllerTokenSource === "env"
              ) ? (
                <div
                  style={{
                    fontSize: 12,
                    color: t.mode === "dark" ? "#faad14" : "#d46b08",
                    background: t.mode === "dark" ? "rgba(250,173,20,0.14)" : "rgba(250,173,20,0.1)",
                    padding: "6px 10px",
                    borderRadius: 6,
                    display: "grid",
                    gap: 4,
                    marginTop: 6,
                  }}
                >
                  <span>
                    {tr("L1 账号/密码验证通过 = 已持有网关 Console 会话（模型下拉的 alias 可用）。但 Worker 运行配置的 L1 字段（并发限流/上下文管理/shell 组等）与 CRD 管理还需要 Controller 管理员 token——另一套凭证，密码不替代 token。")}
                  </span>
                  <span>
                    {tr("获取（在部署宿主机执行后复制，切到上方「L1 管理面」模式粘进 ① Controller 认证字段）：")}
                    <code
                      style={{
                        background: t.toolBg,
                        borderRadius: 4,
                        padding: "1px 5px",
                        fontSize: 11.5,
                        overflowWrap: "anywhere",
                      }}
                    >
                      docker exec agentteams-controller cat /var/run/agentteams/cli-token
                    </code>
                  </span>
                </div>
              ) : null}
          </div>
          <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>
            {tr("Matrix 登录（L2）：查看本账号可访问的团队 + 项目操作（启动/暂停/产物），日常够用。两套独立的 L1 认证：① Controller 管理员 token（L1 管理面模式内配置）——CRD 管理（入职/建队/改配/删除）+ 全部 Worker/Team 状态视图（Controller 唯一凭证，无接口获取——上游安全设计，部署管理员提供，粘贴一次永久记住）；② Higress 账号+密码（下方独立段配置，与 L1/L2 模式无关）——建 Higress Console 会话（模型下拉 alias 层）。两者是不同系统的凭证，互不替代、可同时配置。")}
          </div>
        </div>
        <StartupPrefRow />
      </div>

      {/* 「集群负载」独立卡片。
 部署者专属模块（L2 用户无 SGLang 集群）
 → L2 模式隐藏（该隐藏的就隐藏；切 L1 模式仍可配置，
 值已持久化不丢）。 */}
      {ctlMode === "token" && (
      <div style={{ gridColumn: "1 / -1", ...cardBox, display: "grid", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("集群负载（可选模块）")}
            <span style={{ fontWeight: 400, color: t.textSecondary, marginLeft: 8, fontSize: 12 }}>
              {tr("L1 专属——只有部署了本地 SGLang 推理集群才需要开启")}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 8,
            }}
          >
            <antd.Switch
              checked={sglangEnabled}
              onChange={setSglangEnabled}
              checkedChildren="开启"
              unCheckedChildren="关闭"
            />
          </div>
          {/* SGLang 双地址（内网/外网）——与 Matrix/Controller 同款：
 两条路径同一集群，后台自动测延迟切最快，无需手动切换。 */}
          <div style={{ display: "grid", gap: 8 }}>
            <antd.Input
              placeholder={tr("内网：http://192.168.x.x:30000")}
              value={sglangLan}
              disabled={!sglangEnabled}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                setSglangLan(e.target.value)
              }
            />
            <AddrAuthEditor
              value={addrAuth["sglang:0"] || EMPTY_ADDR_AUTH}
              onChange={(v) => setAddrAuthFor("sglang:0", v)}
              disabled={!sglangEnabled}
            />
            <antd.Input
              placeholder={tr("外网：https://你的域名:30000（可留空）")}
              value={sglangWan}
              disabled={!sglangEnabled}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                setSglangWan(e.target.value)
              }
            />
            <AddrAuthEditor
              value={addrAuth["sglang:1"] || EMPTY_ADDR_AUTH}
              onChange={(v) => setAddrAuthFor("sglang:1", v)}
              disabled={!sglangEnabled}
            />
          </div>
          <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
            {tr("开启后首页/运维页显示各 DP rank 的排队/运行/显存负载（SGLang /v1/loads）。内网/外网是同一集群的两条访问路径，插件自动探测最快可达的一条。没有本地部署模型的用户保持关闭——零痕迹。")}
          </div>
        </div>
      </div>
      )}

      <div style={{ gridColumn: "1 / -1" }}>
        <antd.Button
          type="primary"
          loading={saving}
          // config 未就绪时禁用保存——默认态保存
 // 会用 UI 空值覆盖已保存的地址/模式（「没有记忆」事故放大点）。
          disabled={config === null}
          onClick={() => void save()}
        >
          {tr(
            config?.config_health?.state === "defaults-fallback"
              ? "保存（将用当前表单值重建配置文件）"
              : "保存配置",
          )}
        </antd.Button>
        {/* （「没有记忆」类症状必须可自证）：持久化自检行——
            上次落盘时间（config 文件 mtime）+ 目录可写性。写失败 PUT
            本就 500 显性报，此处补"落没落盘"锚点。 */}
        {config && (
          <span
            style={{ gridColumn: "1 / -1",
              fontSize: 12,
              alignSelf: "center",
              color: config.configWritable ? "#888" : (t.mode === "dark" ? "#faad14" : "#d48806"),
            }}
            title={config.configPath || undefined}
          >
            {config.configWritable
              ? config.configSavedAt
                ? tr("上次落盘 {time}").replace("{time}", formatTimeOfDay(config.configSavedAt * 1000))
                : tr("尚未落盘")
              : tr("⚠ 配置目录不可写——保存可能不落盘")}
          </span>
        )}
        {/* 凭据存在态自证（credential_state）：只显形「只存了用户名」
            的可操作缺口（saved=正常、none=裸 URL 本就无凭据，都不吵）。
            「basic 密码好像要重新填」→ 一眼判断是真缺（要填）还是
            已存留空即可（不用填）。 */}
        {(() => {
          const cs = config?.credential_state;
          if (!cs) return null;
          const parts: string[] = [];
          // 只显形「只存了用户名」的可操作缺口（saved=正常、none=裸 URL
          // 本就无凭据，都不吵）。admin_password 无 username-only 态
          // （用户名是独立字段恒在），不参与此告警。
          const scan = (label: string, states?: string[]) => {
            (states || []).forEach((s, i) => {
              if (s === "username-only")
                parts.push(
                  tr(
                    "凭据缺口：{label} 第 {n} 条只存了用户名（密码缺失，需补全）",
                  )
                    .replace("{label}", label)
                    .replace("{n}", String(i + 1)),
                );
            });
          };
          scan(tr("Matrix"), cs.matrix_homeservers);
          scan(tr("Controller"), cs.controller_urls);
          scan(tr("网关管理"), cs.gateway_admin_urls);
          if (!parts.length) return null;
          return (
            <span style={{ gridColumn: "1 / -1", fontSize: 12, alignSelf: "center", color: t.mode === "dark" ? "#faad14" : "#d48806" }}>
              ⚠ {parts.join("；")}
            </span>
          );
        })()}
      </div>

      {/* 「配置迁移与诊断」卡片。 */}

 {/* 「备份与恢复」卡片——含凭据完整
 配置（用户自己还原用；与上方脱敏导出/导入=交管理员排查 区分）。 */}
      <div style={{ gridColumn: "1 / -1", ...cardBox, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>{tr("备份与恢复")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <antd.Button
            icon={<DownloadIcon />}
            onClick={() => void exportFull()}
          >
            {tr("导出配置（含凭据）")}
          </antd.Button>
          <antd.Button
            icon={<UploadIcon />}
            onClick={() => setImportOpen(true)}
          >
            {tr("导入配置（含凭据）")}
          </antd.Button>
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
          {tr("导出含密码/token 的完整配置 JSON，存到安全位置；换环境/重装插件后粘贴回来导入即快速还原，不必重填。导入前会先自动备份当前配置。注意：此导出含明文凭据，勿粘贴到公开渠道。")}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            paddingTop: 8,
            borderTop: `1px solid ${t.border}`,
          }}
        >
          <span style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("完整备份密码")}:{" "}
            {pwHas
              ? tr("已设置")
              : pwHas === false
                ? tr("未设置（导出/导入暂不可用）")
                : "…"}
          </span>
          <antd.Button size="small" onClick={() => openSetPw()}>
            {pwHas ? tr("修改密码") : tr("设置密码")}
          </antd.Button>
          {pwHas && (
            <antd.Button size="small" danger onClick={() => void clearPw()}>
              {tr("清除密码")}
            </antd.Button>
          )}
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
          {tr("备份密码保护「含凭据导出/导入」通道（本机 8088 若可被局域网访问，防匿名 dump 整集群凭据）。密码仅存哈希、不出现在备份文件里；设置一次即可，导出/导入时输入。")}
        </div>
      </div>

      {/* 导出前门密码输入 */}
      <antd.Modal
        title={tr("输入完整备份密码")}
        open={exportPwOpen}
        onCancel={() => setExportPwOpen(false)}
        width={420}
        footer={[
          <antd.Button key="cancel" onClick={() => setExportPwOpen(false)}>
            {tr("取消")}
          </antd.Button>,
          <antd.Button
            key="ok"
            type="primary"
            onClick={() => void doExportWithPw()}
          >
            {tr("导出")}
          </antd.Button>,
        ]}
      >
        <antd.Input.Password
          value={exportPw}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            setExportPw(e.target.value)
          }
          onPressEnter={() => void doExportWithPw()}
          placeholder={tr("完整备份密码")}
          autoFocus
        />
      </antd.Modal>

      {/* 设置/修改门密码 */}
      <antd.Modal
        title={tr("设置完整备份密码")}
        open={setPwOpen}
        onCancel={() => setSetPwOpen(false)}
        width={420}
        footer={[
          <antd.Button key="cancel" onClick={() => setSetPwOpen(false)}>
            {tr("取消")}
          </antd.Button>,
          <antd.Button key="ok" type="primary" onClick={() => void doSetPw()}>
            {tr("保存")}
          </antd.Button>,
        ]}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <antd.Input.Password
            value={setPw}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setSetPw(e.target.value)
            }
            placeholder={tr("新密码（至少 8 位）")}
            autoFocus
          />
          <antd.Input.Password
            value={setPwConfirm}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setSetPwConfirm(e.target.value)
            }
            onPressEnter={() => void doSetPw()}
            placeholder={tr("再次输入新密码")}
          />
        </div>
      </antd.Modal>

      <antd.Modal
        title={tr("导出配置（含凭据）")}
        open={exportOpen}
        onCancel={() => setExportOpen(false)}
        width={720}
        footer={[
          <antd.Button
            key="copy"
            type="primary"
            icon={<CopyIcon />}
            onClick={() => copySettingText(exportText)}
          >
            {tr("复制")}
          </antd.Button>,
          <antd.Button key="close" onClick={() => setExportOpen(false)}>
            {tr("关闭")}
          </antd.Button>,
        ]}
      >
        <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 8 }}>
          {tr("以下为含明文凭据的完整配置——请只保存到可信位置。")}
        </div>
        <antd.Input.TextArea
          value={exportText}
          readOnly
          autoSize={{ minRows: 10, maxRows: 24 }}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
      </antd.Modal>
      <antd.Modal
        title={tr("导入配置（含凭据）")}
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => void doImportFull()}
        confirmLoading={importing}
        okText={tr("导入")}
        cancelText={tr("取消")}
        width={720}
      >
        <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 8 }}>
          {tr("粘贴「导出配置（含凭据）」得到的 JSON 全文。导入会校验并先自动备份当前配置，再覆盖。")}
        </div>
        <antd.Input.Password
          value={importPw}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            setImportPw(e.target.value)
          }
          placeholder={tr("完整备份密码")}
          style={{ marginBottom: 8 }}
        />
        <antd.Input.TextArea
          value={importText}
          onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
            setImportText(e.target.value)
          }
          autoSize={{ minRows: 10, maxRows: 24 }}
          placeholder={`{\n  "matrix_homeservers": []\n}`}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
      </antd.Modal>

      <div style={cardBox}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>{tr("聊天页面")}</div>
      {/* 12.14：聊天分栏强制开关——宿主面板宽度判定为窄屏时的豁免。 */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <antd.Switch
          checked={Boolean(chatForceWide)}
          onChange={(v: boolean) => onChatForceWideChange?.(v)}
        />
        <div>
          <div style={{ fontWeight: 600 }}>{tr("聊天页面强制左右分栏")}</div>
          <div style={{ fontSize: 12, color: "#888" }}>
            {tr("忽略宽窄判定：房间列表与聊天框始终左右分栏、各自独立滚动。窄面板下可用拖动条调宽、⟨ 可收起列表。")}
          </div>
        </div>
      </div>
      </div>

      {/* 「Matrix 登录」卡片。 */}
      <div style={{ ...cardBox, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>
          {tr("Matrix 登录")}
          {config?.matrix?.user_id ? (
            <span style={{ fontWeight: 400, color: "#888", marginLeft: 8 }}>
              {tr("当前身份：")} {config.matrix.user_id}
            </span>
          ) : null}
        </div>
        <antd.Input
          placeholder={tr("Matrix 账号（不含 @ 和域名）")}
          value={loginUser}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            setLoginUser(e.target.value)
          }
        />
        <antd.Input.Password
          placeholder={tr("Matrix 密码")}
          value={loginPassword}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            setLoginPassword(e.target.value)
          }
        />
        <div>
          <antd.Button
            type="primary"
            loading={loggingIn}
            onClick={() => void doLogin()}
          >
            {tr("登录")}
          </antd.Button>
        </div>
      </div>

      <div style={{ ...cardBox, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>{tr("配置迁移与诊断")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <antd.Button
            icon={<DownloadIcon />}
            onClick={() => void exportConfig()}
          >
            {tr("导出配置（脱敏）")}
          </antd.Button>
          <antd.Button
            icon={<UploadIcon />}
            onClick={() => importInputRef.current?.click()}
          >
            {tr("导入配置")}
          </antd.Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => void importConfig(e)}
          />
          <antd.Button
            icon={<FileZipOutlined />}
            onClick={() => void exportDiagnostic()}
          >
            {tr("导出诊断包")}
          </antd.Button>
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
          {tr("导出配置含全部地址但不含密码/token（显示为 ***）——导入不会覆盖现有凭据。诊断包 = 脱敏配置 + 自检结果，用于排查问题时交给管理员。")}
        </div>
      </div>
 {/* 宿主 Agent 技能管理区块移除（
 「配置页的 QwenPaw 宿主 Agent 技能不需要了」）——SkillsTab 组件
 已删（死代码零残留）；宿主技能系统本体是 QwenPaw 核心功能，
 不受影响（SkillCenter 团队技能池保留）。 */}
      </div>
    </div>
  );
}

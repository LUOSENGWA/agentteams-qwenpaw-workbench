/**
 * 本地离线模式——配置域模拟层（localStorage）。
 *
 * 本地插件宿主 shell（pluginhost/host.js）无服务端运行时：Python 连接器不运行，
 * 所有 /agentteams-proxy/* 数据接口是受控 503（{detail, code:"OFFLINE"}）。
 * 本层用 localStorage 模拟**配置域**（GET/PUT /config、export/import、test、
 * verify-admin），脱敏/合并/凭据态语义逐条移植自服务端
 * agentteams_connector/config.py（redact / merge_address_entries /
 * credential_state / persisted_credential_kinds / update_config 字段规则），
 * 保证离线填存的配置与服务端在线态同形——导出后可在服务端 Web 控制台
 * 「备份与恢复 → 导入」应用。
 *
 * 数据域（rooms/chat/admin/sglang 等）不模拟：离线页（WorkbenchOfflinePage）
 * 入口级不挂载数据页，结构性零拨号。api.ts requestJson 是唯一接入点——
 * QP.host.isOffline 为真时先试本层，命中返回模拟响应；未命中放行
 * （仍走宿主受控 503）。console 宿主无 isOffline 字段 → 本层整体旁路。
 *
 * 注意：本文件零 import（宿主 blob-URL 执行环境禁 module 导入，
 * 构建守卫 no-module-imports-guard 强制）。
 */

const OFFLINE_KEY = "agentteams-qwenpaw-workbench:offline-config";

interface OfflineState {
  // 修订号（单调递增；GET 以字符串回传，PUT 原样回传——本地单写者，
  // 不做并发校验，与服务端 mtime:size 的乐观锁同位不同实现）。
  rev: number;
  // epoch 秒（configSavedAt 展示用；0=从未保存）。
  savedAt: number;
  // 落盘同形配置（= 服务端 config.json 的键空间；含明文凭据——
  // localStorage 在设备沙箱内，仅本机可读；导出通道与服务端 export 同源）。
  config: Record<string, unknown>;
}

// 键空间对齐服务端 _DEFAULTS（新设备首启同形）。
const DEFAULT_CONFIG: Record<string, unknown> = {
  matrix_homeservers: [],
  controller_urls: [],
  controller_token: "",
  matrix: { user_id: "", access_token: "", device_id: "" },
  admin_username: "",
  admin_password: "",
  gateway_admin_url: "",
  gateway_admin_urls: [],
  console_session: "",
  console_effects: "light",
  address_mode: "auto",
  sglang: { enabled: false, urls: [] },
};

// ── 基础取值（与服务端同名的语义函数） ────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// address_url：str 原样 / dict 取 .url / 其他 → ""
function addressUrl(e: unknown): string {
  if (typeof e === "string") return e.trim();
  if (isObj(e)) return asStr(e.url).trim();
  return "";
}

// _normalize_auth：basic 需 username+password / bearer 需 token；
// 空串凭据或 "***" → None（无效=无凭据）。
function normalizeAuth(
  raw: unknown,
): { type: string; username: string; password: string; token: string } | null {
  if (!isObj(raw)) return null;
  const atype = asStr(raw.type).trim().toLowerCase();
  if (atype === "basic") {
    const u = asStr(raw.username).trim();
    const p = asStr(raw.password).trim();
    if (!(u && p && p !== "***")) return null;
    return { type: "basic", username: u, password: p, token: "" };
  }
  if (atype === "bearer") {
    const t = asStr(raw.token).trim();
    if (!t || t === "***") return null;
    return { type: "bearer", username: "", password: "", token: t };
  }
  return null;
}

// ── merge_address_entries 移植（按位置配对，保留旧秘密） ──────────────

function mergeAddressEntries(
  oldEntries: unknown,
  newEntries: unknown,
): unknown[] {
  const merged: unknown[] = [];
  const oldList = asList(oldEntries);
  asList(newEntries).forEach((entry, i) => {
    if (typeof entry === "string") {
      // 字符串条目 = 显式降级（旧凭据丢弃）。
      const u = entry.trim();
      if (u) merged.push(u);
      return;
    }
    if (!isObj(entry)) return;
    const u = asStr(entry.url).trim();
    if (!u) return; // url 为空 = 丢弃该条目（与前端 filter(v=>v.trim()) 一致）
    const oldEntry = i < oldList.length ? oldList[i] : null;
    const oldAuth = isObj(oldEntry) ? normalizeAuth(oldEntry.auth) : null;
    const authIn = entry.auth;
    if (!isObj(authIn) || ["", "none"].includes(asStr(authIn.type).trim().toLowerCase())) {
      // auth 缺省/type=none → 字符串条目（显式清除凭据）。
      merged.push(u);
      return;
    }
    const atype = asStr(authIn.type).trim().toLowerCase();
    if (atype === "basic") {
      const username =
        asStr(authIn.username).trim() || (oldAuth ? oldAuth.username : "");
      let password = asStr(authIn.password).trim();
      if (!password || password === "***") {
        password = oldAuth ? oldAuth.password : "";
      }
      if (username && password && password !== "***") {
        merged.push({ url: u, auth: { type: "basic", username, password } });
      } else {
        merged.push(u);
      }
    } else if (atype === "bearer") {
      let token = asStr(authIn.token).trim();
      if (!token || token === "***") {
        token = oldAuth ? oldAuth.token : "";
      }
      if (token && token !== "***") {
        merged.push({ url: u, auth: { type: "bearer", token } });
      } else {
        merged.push(u);
      }
    } else {
      merged.push(u);
    }
  });
  return merged;
}

// ── credential_gaps 移植（保存前凭据意图 400 拦截） ────────────────────

interface CredentialGap {
  index: number;
  type: "basic" | "bearer";
  username: string;
}

function credentialGaps(
  oldEntries: unknown,
  newEntries: unknown,
): CredentialGap[] {
  const gaps: CredentialGap[] = [];
  const oldList = asList(oldEntries);
  asList(newEntries).forEach((entry, i) => {
    if (!isObj(entry)) return;
    const authIn = entry.auth;
    if (!isObj(authIn)) return;
    const atype = asStr(authIn.type).trim().toLowerCase();
    if (atype !== "basic" && atype !== "bearer") return; // none/缺省=显式清除
    const oldEntry = i < oldList.length ? oldList[i] : null;
    let oldAuth = isObj(oldEntry) ? normalizeAuth(oldEntry.auth) : null;
    // 继承只认同类型旧凭据（basic↔bearer 无字段可继承）。
    if (oldAuth && oldAuth.type !== atype) oldAuth = null;
    if (atype === "basic") {
      const username = asStr(authIn.username).trim();
      const password = asStr(authIn.password).trim();
      if ((!password || password === "***") && !oldAuth) {
        gaps.push({ index: i, type: "basic", username });
      }
    } else {
      const token = asStr(authIn.token).trim();
      if ((!token || token === "***") && !oldAuth) {
        gaps.push({ index: i, type: "bearer", username: "" });
      }
    }
  });
  return gaps;
}

// ── redact 移植（token/密码类 → "***"；username 保留——非机密） ────────

function redactEntryList(entries: unknown): void {
  for (const entry of asList(entries)) {
    if (!isObj(entry) || !isObj(entry.auth)) continue;
    const auth = entry.auth;
    if (auth.password) auth.password = "***";
    if (auth.token) auth.token = "***";
  }
}

function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out = deepCopy(config);
  if (asStr(out.controller_token)) out.controller_token = "***";
  for (const key of ["matrix_homeservers", "controller_urls", "gateway_admin_urls"]) {
    redactEntryList(out[key]);
  }
  const sg = out.sglang;
  if (isObj(sg)) redactEntryList(sg.urls);
  if (asStr(out.admin_password)) out.admin_password = "***";
  if (asStr(out.console_session)) out.console_session = "***";
  const matrix = out.matrix;
  if (isObj(matrix) && asStr(matrix.access_token)) matrix.access_token = "***";
  return out;
}

// ── credential_state 移植（逐条凭据存在态自证） ───────────────────────

function entryState(e: unknown): string {
  if (!isObj(e) || !isObj(e.auth)) return "none";
  const a = e.auth;
  const t = asStr(a.type).trim().toLowerCase();
  if (t === "basic") {
    const user = asStr(a.username).trim();
    const pw = asStr(a.password).trim();
    if (user && pw) return "saved";
    return user ? "username-only" : "none";
  }
  if (t === "bearer") {
    return asStr(a.token).trim() ? "saved" : "none";
  }
  return "none";
}

function credentialStateOf(
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["matrix_homeservers", "controller_urls", "gateway_admin_urls"]) {
    out[key] = asList(cfg[key]).map(entryState);
  }
  const sg = isObj(cfg.sglang) ? cfg.sglang : {};
  out.sglang_urls = asList(sg.urls).map(entryState);
  out.admin_password = asStr(cfg.admin_password).trim() ? "saved" : "none";
  return out;
}

// ── persisted_credential_kinds 移植（PUT 回读校验用） ─────────────────

function persistedCredentialKinds(entries: unknown): string[] {
  const out: string[] = [];
  for (const entry of asList(entries)) {
    if (isObj(entry)) {
      const auth = normalizeAuth(entry.auth);
      out.push(auth ? auth.type : "str");
    } else {
      out.push("str");
    }
  }
  return out;
}

// ── localStorage 存取 ────────────────────────────────────────────────

function readState(): OfflineState {
  try {
    const raw = window.localStorage.getItem(OFFLINE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as unknown;
      if (isObj(p) && isObj(p.config)) {
        return {
          rev: typeof p.rev === "number" ? p.rev : 1,
          savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
          config: p.config,
        };
      }
    }
  } catch {
    // 损坏态 → 默认值重建（服务端 fresh 语义；不静默吞新值）。
  }
  return { rev: 0, savedAt: 0, config: deepCopy(DEFAULT_CONFIG) };
}

function writeState(state: OfflineState): void {
  try {
    window.localStorage.setItem(OFFLINE_KEY, JSON.stringify(state));
  } catch {
    throw new Error(
      "本地配置保存失败——设备 localStorage 不可用或配额已满（清理后重试）",
    );
  }
}

// ── effective 地址选择（_pick_address 口径：固定档取固定位） ─────────

function pickAddress(entries: unknown[], mode: string): string {
  const list = asList(entries).map(addressUrl).filter((u) => u.length > 0);
  if (list.length === 0) return "";
  if (mode === "lan") return list[0] || "";
  if (mode === "wan") return list[1] || list[0] || "";
  return list[0];
}

// ── GET /config 响应组装（对齐 config_api.get_config 字段面） ─────────

function buildGetResponse(): Record<string, unknown> {
  const state = readState();
  const cfg = state.config;
  const mode = asStr(cfg.address_mode) || "auto";
  const out = redactConfig(cfg);
  out.credential_state = credentialStateOf(cfg);
  out.controllerTokenSource = asStr(cfg.controller_token).trim()
    ? "config"
    : "";
  out.effective = {
    matrix: pickAddress(asList(cfg.matrix_homeservers), mode),
    controller: pickAddress(asList(cfg.controller_urls), mode),
    gateway: pickAddress(asList(cfg.gateway_admin_urls), mode),
  };
  out.configPath = "local-storage://" + OFFLINE_KEY;
  out.configSavedAt = state.savedAt;
  out.configWritable = true;
  out.config_rev = state.rev > 0 ? String(state.rev) : null;
  out.config_health = { state: state.rev > 0 ? "ok" : "fresh" };
  out.write_audit = [];
  return out;
}

// ── update_config 字段规则移植（PUT /config 合并） ────────────────────

function applyPatch(incoming: Record<string, unknown>): Record<string, unknown> {
  const state = readState();
  const cfg = state.config;

  // 脱敏占位符不入合并（服务端 PUT 前置：*** = 保持不变）。
  if (incoming.controller_token === "***") delete incoming.controller_token;
  const matrixIn: Record<string, unknown> = isObj(incoming.matrix)
    ? { ...incoming.matrix }
    : {};
  if (matrixIn.access_token === "***") delete matrixIn.access_token;

  // 地址列表四族——位置合并保留旧秘密。
  for (const key of [
    "matrix_homeservers",
    "controller_urls",
    "gateway_admin_urls",
  ]) {
    if (incoming[key] !== undefined) {
      cfg[key] = mergeAddressEntries(cfg[key], incoming[key]);
    }
  }
  // token/密码类字段——非空且 ≠"***" 才覆盖（空=保持已存）。
  const token = asStr(incoming.controller_token).trim();
  if (token && token !== "***") cfg.controller_token = token;
  const adminUser = asStr(incoming.admin_username).trim();
  if (adminUser && adminUser !== "***") cfg.admin_username = adminUser;
  const adminPass = asStr(incoming.admin_password).trim();
  if (adminPass && adminPass !== "***") cfg.admin_password = adminPass;
  const session = asStr(incoming.console_session).trim();
  if (session && session !== "***") cfg.console_session = session;
  const gwLegacy = asStr(incoming.gateway_admin_url).trim();
  if (gwLegacy && gwLegacy !== "***") cfg.gateway_admin_url = gwLegacy;
  // 枚举字段——非法值降级默认（服务端同口径）。
  if (incoming.console_effects !== undefined) {
    const fx = asStr(incoming.console_effects).trim();
    if (fx === "light" || fx === "off" || fx === "full") cfg.console_effects = fx;
  }
  if (incoming.address_mode !== undefined) {
    const am = asStr(incoming.address_mode).trim();
    cfg.address_mode = am === "lan" || am === "wan" ? am : "auto";
  }
  // SGLang——enabled 直取 + urls 位置合并。
  if (isObj(incoming.sglang)) {
    const sgIn = incoming.sglang;
    const oldSg = isObj(cfg.sglang) ? cfg.sglang : {};
    cfg.sglang = {
      enabled: sgIn.enabled === true,
      urls: mergeAddressEntries(oldSg.urls, sgIn.urls),
    };
  }
  // Matrix 身份——浅合并（access_token 已去 ***；空串不覆盖）。
  if (Object.keys(matrixIn).length > 0) {
    const oldM: Record<string, unknown> = isObj(cfg.matrix)
      ? { ...cfg.matrix }
      : { user_id: "", access_token: "", device_id: "" };
    for (const k of Object.keys(matrixIn)) {
      const v = matrixIn[k];
      if (typeof v === "string" && v.trim() !== "" && v !== "***") oldM[k] = v;
    }
    cfg.matrix = oldM;
  }

  state.rev += 1;
  state.savedAt = Math.floor(Date.now() / 1000);
  writeState(state);
  return state.config;
}

function handlePut(init: RequestInit | undefined): Record<string, unknown> {
  let incoming: Record<string, unknown> = {};
  try {
    const body = init?.body;
    const parsed =
      body && typeof body === "string" ? (JSON.parse(body) as unknown) : {};
    if (isObj(parsed) && isObj(parsed.config)) incoming = parsed.config;
    else if (isObj(parsed)) incoming = parsed;
  } catch {
    throw new Error("HTTP 400: 保存失败：请求体不是合法 JSON");
  }
  const prev = readState().config;
  // 凭据意图检查——选了覆盖凭据但字段空且旧条目无可继承同型凭据 →
  // merge 会静默降级无凭据条目（网关恒 401）；保存前 400 拦截（同服务端）。
  const famNames: Array<[string, string | null]> = [
    ["Matrix", "matrix_homeservers"],
    ["Controller", "controller_urls"],
    ["SGLang", null],
    ["Higress", "gateway_admin_urls"],
  ];
  const gapMsgs: string[] = [];
  for (const [label, key] of famNames) {
    let newEntries: unknown;
    if (key) {
      if (incoming[key] === undefined) continue;
      newEntries = incoming[key];
    } else {
      const sgIn = incoming.sglang;
      if (!isObj(sgIn) || sgIn.urls === undefined) continue;
      newEntries = sgIn.urls;
    }
    const oldEntries = key
      ? prev[key]
      : isObj(prev.sglang)
        ? (prev.sglang as Record<string, unknown>).urls
        : undefined;
    for (const g of credentialGaps(oldEntries, newEntries)) {
      const pos = g.index + 1;
      const who = g.username || "";
      gapMsgs.push(
        `${label} 第 ${pos} 个地址选了` +
          (g.type === "basic" ? "Basic 认证" : "API Key") +
          (who ? `（用户名 ${who}）` : "") +
          "但凭据为空，也没有已存凭据可沿用——请填完整凭据再保存",
      );
    }
  }
  if (gapMsgs.length > 0) throw new Error(`HTTP 400: ${gapMsgs.join("；")}`);
  const merged = applyPatch(incoming);
  const resp = redactConfig(merged);
  resp.credential_check = {
    matrix: persistedCredentialKinds(merged.matrix_homeservers),
    controller: persistedCredentialKinds(merged.controller_urls),
    sglang: persistedCredentialKinds(
      isObj(merged.sglang) ? (merged.sglang as Record<string, unknown>).urls : undefined,
    ),
    gateway: persistedCredentialKinds(merged.gateway_admin_urls),
  };
  return resp;
}

// ── POST /config/import（覆盖式恢复；轻校验对齐服务端 schema 门） ────

function handleImport(init: RequestInit | undefined): Record<string, unknown> {
  let data: unknown = null;
  try {
    const body = init?.body;
    data = body && typeof body === "string" ? (JSON.parse(body) as unknown) : null;
  } catch {
    throw new Error("HTTP 400: 导入失败：请求体不是合法 JSON");
  }
  // 容错：{"config": {...}} 包裹独占 body 时拆包（同服务端规则）。
  if (isObj(data) && Object.keys(data).length === 1 && isObj(data.config)) {
    data = data.config;
  }
  if (!isObj(data)) {
    throw new Error("HTTP 400: 导入失败：配置顶层必须是 JSON 对象");
  }
  const errors: string[] = [];
  for (const k of ["matrix_homeservers", "controller_urls", "gateway_admin_urls"]) {
    if (data[k] !== undefined && !Array.isArray(data[k])) {
      errors.push(`${k} 必须是数组`);
    }
  }
  if (data.sglang !== undefined && !isObj(data.sglang)) {
    errors.push("sglang 必须是对象");
  }
  if (errors.length > 0) {
    throw new Error("HTTP 400: 导入失败：" + errors.join("；"));
  }
  // 旧单地址 sglang.url → urls 迁移 + 空条目过滤（服务端 load 迁移语义）。
  const sg = data.sglang;
  if (isObj(sg)) {
    const legacyUrl = asStr(sg.url).trim();
    let urls = asList(sg.urls).filter(
      (e) => (typeof e === "string" ? e.trim() : addressUrl(e)).length > 0,
    );
    if (legacyUrl && urls.length === 0) urls = [legacyUrl];
    sg.urls = urls;
  }
  const state = readState();
  state.config = data;
  state.rev += 1;
  state.savedAt = Math.floor(Date.now() / 1000);
  writeState(state);
  return { ok: true, restart: "none", config: redactConfig(data) };
}

// ── POST /config/test（离线=全部不可达；响应形态对齐 ConfigTestResponse）

function handleTest(init: RequestInit | undefined): Record<string, unknown> {
  let body: Record<string, unknown> = {};
  try {
    const b = init?.body;
    const parsed =
      b && typeof b === "string" ? (JSON.parse(b) as unknown) : null;
    if (isObj(parsed)) body = parsed;
  } catch {
    body = {};
  }
  const cfg = readState().config;
  const mode = asStr(cfg.address_mode) || "auto";
  const urlsOf = (v: unknown, fallback: unknown): string[] =>
    asList(v ? v : fallback)
      .map(addressUrl)
      .filter((u) => u.length > 0);
  const sgCfg = isObj(cfg.sglang) ? cfg.sglang : {};
  const rows = (urls: string[]) =>
    urls.map((url) => ({
      url,
      ok: false,
      http_ok: false,
      ms: null,
      detail: "本地离线模式——无服务端运行时，无法探测该地址",
      auth: "none",
      challenge: "",
    }));
  const pinnedOf = (entries: unknown): string | null => {
    const list = asList(entries).map(addressUrl).filter((u) => u.length > 0);
    if (mode === "lan") return list[0] ?? null;
    if (mode === "wan") return list[1] ?? list[0] ?? null;
    return null;
  };
  return {
    ok: true,
    matrix: rows(urlsOf(body.matrix, cfg.matrix_homeservers)),
    controller: rows(urlsOf(body.controller, cfg.controller_urls)),
    sglang: rows(urlsOf(body.sglang, sgCfg.urls)),
    gateway: rows(urlsOf(body.gateway, cfg.gateway_admin_urls)),
    effective: {
      matrix: pickAddress(asList(cfg.matrix_homeservers), mode),
      controller: pickAddress(asList(cfg.controller_urls), mode),
    },
    pinned: {
      matrix: pinnedOf(cfg.matrix_homeservers),
      controller: pinnedOf(cfg.controller_urls),
      sglang: pinnedOf(sgCfg.urls),
      gateway: pinnedOf(cfg.gateway_admin_urls),
    },
    applied: false,
    switched: { matrix: false, controller: false },
  };
}

// ── POST /config/verify-admin（离线无法连接验证 → 可读错误） ──────────

function handleVerifyAdmin(): Record<string, unknown> {
  return {
    ok: false,
    error:
      "本地离线模式——无法连接服务端验证。连接配置可先填写并保存（本地留存），连上服务端后再验证应用",
  };
}

// ── 入口：requestJson 离线拦截（命中配置域端点 → 模拟响应） ──────────

function isOfflineHost(): boolean {
  const host = (window as unknown as { QwenPaw?: { host?: unknown } }).QwenPaw
    ?.host;
  return isObj(host) && host.isOffline === true;
}

/**
 * 命中离线模拟端点 → 返回响应 Promise（错误经 throw 传递，形态同
 * requestJson 的 HTTP 错误）；未命中 → null（调用方放行宿主 fetch）。
 */
export function tryOfflineConfigEndpoint(
  path: string,
  init?: RequestInit,
): Promise<unknown> | null {
  if (!isOfflineHost()) return null;
  const p = path && path.charAt(0) === "/" ? path : "/" + path;
  const method = (asStr(init?.method) || "GET").toUpperCase();
  if (p === "/agentteams-proxy/config" && method === "GET") {
    return Promise.resolve(buildGetResponse());
  }
  if (p === "/agentteams-proxy/config" && method === "PUT") {
    return Promise.resolve(handlePut(init));
  }
  if (p === "/agentteams-proxy/config/export" && method === "GET") {
    // 含明文凭据的完整配置（备份通道，与服务端 export 同源同形）。
    return Promise.resolve(readState().config);
  }
  if (p === "/agentteams-proxy/config/import" && method === "POST") {
    return Promise.resolve(handleImport(init));
  }
  if (p === "/agentteams-proxy/config/test" && method === "POST") {
    return Promise.resolve(handleTest(init));
  }
  if (p === "/agentteams-proxy/config/verify-admin" && method === "POST") {
    return Promise.resolve(handleVerifyAdmin());
  }
  return null;
}

// R11 语音输入（浏览器原生 Web Speech API，零新依赖）——纯逻辑层。
//
// 为什么单独抽 lib：SpeechRecognition 是浏览器对象，状态机若直接写在
// 组件里就只能靠 DOM 环境测（本仓 vitest 跑 node，无 jsdom）。这里把
// 可测的部分收全，组件只做浏览器绑定（构造/lifecycle/toast/textarea）。
//
// 覆盖（对应任务书）：
//   ① 支持检测：SpeechRecognition / webkitSpeechRecognition，都没有 → null
//      （组件据此完全不渲染按钮，不报错）；
//   ② 识别器参数与结果归一（trim、连续空白折成一个空格）；
//   ③ idle / listening / error 状态机（识别器工厂注入，测试用假实现）；
//   ④ 错误码 → 语义分类（文案留在组件里走 tr()，保住 i18n 静态门）。

export type SpeechStatus = "idle" | "listening" | "error";

/** 错误语义分类：组件按分类给 tr() 文案，lib 不持有中文文案。 */
export type SpeechErrorKind =
  | "aborted"
  | "permission"
  | "no-microphone"
  | "no-speech"
  | "network"
  | "unknown";

export interface SpeechAlternativeLike {
  transcript: string;
}

export interface SpeechResultLike {
  isFinal: boolean;
  [index: number]: SpeechAlternativeLike;
}

export interface SpeechResultEventLike {
  resultIndex?: number;
  results: ArrayLike<SpeechResultLike>;
}

/** 只声明本仓用到的成员（浏览器实现有更多字段，不影响使用）。 */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort?(): void;
  onresult: ((ev: SpeechResultEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** 缺省识别语言：中文场景占绝大多数；宿主 lang 明确时由调用方覆盖。 */
export const SPEECH_DEFAULT_LANG = "zh-CN";

/**
 * 从任意全局对象取识别器构造器（window / 测试假对象）。
 * 不支持时返回 null——组件用它决定「完全不渲染麦克风按钮」。
 */
export function detectSpeechRecognition(
  scope?: unknown,
): SpeechRecognitionCtor | null {
  if (!scope || typeof scope !== "object") return null;
  const s = scope as Record<string, unknown>;
  const ctor = s.SpeechRecognition || s.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as SpeechRecognitionCtor) : null;
}

export function isSpeechSupported(scope?: unknown): boolean {
  return detectSpeechRecognition(scope) !== null;
}

/** `document.documentElement.lang` 为空/仅空白时回落 zh-CN。 */
export function resolveSpeechLang(lang?: string | null): string {
  const v = (lang || "").trim();
  return v || SPEECH_DEFAULT_LANG;
}

/** 结果归一：去首尾空白 + 连续空白（含换行）折成一个空格。 */
export function normalizeTranscript(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

/**
 * 把一段最终文本追加到草稿末尾：保留原草稿，空格分隔；
 * 空文本不改动草稿（避免多出尾随空格）。
 */
export function appendTranscript(draft: string, transcript: string): string {
  const add = normalizeTranscript(transcript);
  if (!add) return draft;
  const base = (draft || "").replace(/\s+$/, "");
  return base ? `${base} ${add}` : add;
}

export function classifySpeechError(code?: string): SpeechErrorKind {
  switch (code) {
    case "aborted":
      return "aborted";
    case "not-allowed":
    case "service-not-allowed":
      return "permission";
    case "audio-capture":
      return "no-microphone";
    case "no-speech":
      return "no-speech";
    case "network":
      return "network";
    default:
      return "unknown";
  }
}

export interface SpeechControllerHandlers {
  onStatus?: (status: SpeechStatus) => void;
  /** 临时文本；空串 = 清空（不会写进草稿）。 */
  onInterim?: (text: string) => void;
  /** 最终文本（已归一）；只交由调用方决定追加，不自动发送。 */
  onFinal?: (text: string) => void;
  onError?: (kind: SpeechErrorKind) => void;
}

export interface SpeechControllerOptions {
  /** 每次起识别时新建实例；不支持/构造失败返回 null（静默，不报错）。 */
  createRecognition: () => SpeechRecognitionLike | null;
  lang?: string | null;
  handlers?: SpeechControllerHandlers;
}

export interface SpeechController {
  getStatus(): SpeechStatus;
  start(): void;
  stop(): void;
  toggle(): void;
  dispose(): void;
}

/**
 * 识别状态机：idle → listening →（onend / stop）→ idle；
 * 出错走 error（先通知 onError，随后的 onend 回 idle，按钮恢复常态）。
 * 结果里的 final 只回调 onFinal，interim 只回调 onInterim——
 * 临时文本永远不会被当作正文提交。
 */
export function createSpeechController(
  opts: SpeechControllerOptions,
): SpeechController {
  const handlers: SpeechControllerHandlers = opts.handlers || {};
  const lang = resolveSpeechLang(opts.lang);
  let status: SpeechStatus = "idle";
  let rec: SpeechRecognitionLike | null = null;
  let disposed = false;

  const setStatus = (next: SpeechStatus): void => {
    if (status === next) return;
    status = next;
    handlers.onStatus?.(next);
  };

  const bind = (r: SpeechRecognitionLike): void => {
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (ev) => {
      const results = (ev && ev.results) || [];
      const from = Math.max(0, (ev && ev.resultIndex) || 0);
      let interim = "";
      const finals: string[] = [];
      for (let i = from; i < results.length; i += 1) {
        const res = results[i];
        const alt = res && res[0];
        const text = alt ? alt.transcript : "";
        if (!text) continue;
        if (res.isFinal) finals.push(text);
        else interim += text;
      }
      handlers.onInterim?.(normalizeTranscript(interim));
      const final = normalizeTranscript(finals.join(" "));
      if (final) handlers.onFinal?.(final);
    };
    r.onerror = (ev) => {
      const kind = classifySpeechError(ev && ev.error);
      if (kind === "aborted") {
        setStatus("idle");
        return;
      }
      setStatus("error");
      handlers.onError?.(kind);
    };
    r.onend = () => {
      rec = null;
      setStatus("idle");
    };
  };

  const start = (): void => {
    if (disposed || status === "listening") return;
    let next: SpeechRecognitionLike | null = null;
    try {
      next = opts.createRecognition();
    } catch {
      next = null;
    }
    if (!next) return;
    rec = next;
    bind(next);
    setStatus("listening");
    try {
      next.start();
    } catch {
      // 重复 start / 权限态异常：回 idle，允许用户再点一次。
      rec = null;
      setStatus("error");
      handlers.onError?.("unknown");
      setStatus("idle");
    }
  };

  const stop = (): void => {
    const r = rec;
    rec = null;
    setStatus("idle");
    if (!r) return;
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    try {
      r.stop();
    } catch {
      try {
        r.abort?.();
      } catch {
        /* 已结束 */
      }
    }
  };

  return {
    getStatus: () => status,
    start,
    stop,
    toggle: () => {
      if (status === "listening") stop();
      else start();
    },
    dispose: () => {
      disposed = true;
      stop();
    },
  };
}

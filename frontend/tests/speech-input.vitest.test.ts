// R11 语音输入：lib/speechInput.ts 纯逻辑单测 + 组件接线/渲染门（源码断言）。
//
// vitest 跑 node（本仓无 jsdom / @testing-library），组件本身不能直渲；
// 按仓内既有先例（s-conditional-unify / a11y-static）用源码文本断言：
// ① 麦克风按钮必须挂在 speechSupported 三元内（不支持 = 完全不渲染）；
// ② 临时文本只做展示（appendTranscript(draft, interim)），final 只回填草稿；
// ③ 卸载/切房/发送三处停止识别；④ 不开摄像头、不引入重型识别依赖。

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SPEECH_DEFAULT_LANG,
  appendTranscript,
  classifySpeechError,
  createSpeechController,
  detectSpeechRecognition,
  isSpeechSupported,
  normalizeTranscript,
  resolveSpeechLang,
} from "../src/lib/speechInput";
import type {
  SpeechControllerHandlers,
  SpeechRecognitionLike,
  SpeechResultEventLike,
  SpeechResultLike,
  SpeechStatus,
} from "../src/lib/speechInput";

// ── 假识别器（不 touch window）──────────────────────────────────────────
class FakeRecognition implements SpeechRecognitionLike {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  started = 0;
  stopped = 0;
  onresult: SpeechRecognitionLike["onresult"] = null;
  onerror: SpeechRecognitionLike["onerror"] = null;
  onend: SpeechRecognitionLike["onend"] = null;

  start(): void {
    this.started += 1;
  }

  stop(): void {
    this.stopped += 1;
  }

  emitResult(event: SpeechResultEventLike): void {
    this.onresult?.(event);
  }

  emitError(error: string): void {
    this.onerror?.({ error });
    this.onend?.();
  }
}

function makeResult(text: string, final: boolean): SpeechResultLike {
  return { isFinal: final, 0: { transcript: text } } as unknown as SpeechResultLike;
}

function makeEvent(
  items: Array<[string, boolean]>,
  resultIndex = 0,
): SpeechResultEventLike {
  return {
    resultIndex,
    results: items.map(([text, final]) => makeResult(text, final)),
  };
}

function setup(handlers: SpeechControllerHandlers = {}) {
  const created: FakeRecognition[] = [];
  const statuses: SpeechStatus[] = [];
  const controller = createSpeechController({
    createRecognition: () => {
      const r = new FakeRecognition();
      created.push(r);
      return r;
    },
    lang: "",
    handlers: {
      ...handlers,
      onStatus: (s) => {
        statuses.push(s);
        handlers.onStatus?.(s);
      },
    },
  });
  return { controller, created, statuses };
}

describe("支持检测", () => {
  it("识别 SpeechRecognition（Chrome/Edge）", () => {
    expect(detectSpeechRecognition({ SpeechRecognition: FakeRecognition })).toBe(
      FakeRecognition,
    );
    expect(isSpeechSupported({ SpeechRecognition: FakeRecognition })).toBe(true);
  });

  it("回退 webkitSpeechRecognition", () => {
    expect(
      detectSpeechRecognition({ webkitSpeechRecognition: FakeRecognition }),
    ).toBe(FakeRecognition);
    expect(isSpeechSupported({ webkitSpeechRecognition: FakeRecognition })).toBe(
      true,
    );
  });

  it("不支持的环境返回 null（组件据此完全不渲染按钮）", () => {
    expect(detectSpeechRecognition({})).toBeNull();
    expect(detectSpeechRecognition(null)).toBeNull();
    expect(detectSpeechRecognition(undefined)).toBeNull();
    expect(detectSpeechRecognition({ SpeechRecognition: 42 })).toBeNull();
    expect(isSpeechSupported({})).toBe(false);
  });
});

describe("语言与结果归一", () => {
  it("lang 缺省 zh-CN，宿主明确时原样保留", () => {
    expect(SPEECH_DEFAULT_LANG).toBe("zh-CN");
    expect(resolveSpeechLang()).toBe("zh-CN");
    expect(resolveSpeechLang("")).toBe("zh-CN");
    expect(resolveSpeechLang("   ")).toBe("zh-CN");
    expect(resolveSpeechLang("en-US")).toBe("en-US");
  });

  it("trim + 连续空白折成一个空格", () => {
    expect(normalizeTranscript("  你好    世界 ")).toBe("你好 世界");
    expect(normalizeTranscript("a\n\t b")).toBe("a b");
    expect(normalizeTranscript("")).toBe("");
  });

  it("final 追加到草稿末尾（空格分隔，保留原草稿）", () => {
    expect(appendTranscript("", "你好")).toBe("你好");
    expect(appendTranscript("已有草稿", "你好")).toBe("已有草稿 你好");
    expect(appendTranscript("已有草稿   ", "  你好  ")).toBe("已有草稿 你好");
    // 空结果不改草稿（不产生尾随空格）
    expect(appendTranscript("草稿", "   ")).toBe("草稿");
    expect(appendTranscript("", "")).toBe("");
  });

  it("错误码 → 语义分类（文案在组件里走 tr）", () => {
    expect(classifySpeechError("not-allowed")).toBe("permission");
    expect(classifySpeechError("service-not-allowed")).toBe("permission");
    expect(classifySpeechError("audio-capture")).toBe("no-microphone");
    expect(classifySpeechError("no-speech")).toBe("no-speech");
    expect(classifySpeechError("network")).toBe("network");
    expect(classifySpeechError("aborted")).toBe("aborted");
    expect(classifySpeechError("language-not-supported")).toBe("unknown");
    expect(classifySpeechError(undefined)).toBe("unknown");
  });
});

describe("状态机", () => {
  it("start → listening，识别器参数：lang/interimResults/continuous", () => {
    const { controller, created, statuses } = setup();
    controller.start();
    expect(created).toHaveLength(1);
    expect(created[0].started).toBe(1);
    expect(created[0].lang).toBe("zh-CN");
    expect(created[0].interimResults).toBe(true);
    expect(created[0].continuous).toBe(true);
    expect(created[0].maxAlternatives).toBe(1);
    expect(controller.getStatus()).toBe("listening");
    expect(statuses).toEqual(["listening"]);
  });

  it("interim 只回调 onInterim，绝不提交（onFinal 不触发）", () => {
    const finals: string[] = [];
    const interims: string[] = [];
    const { controller, created } = setup({
      onFinal: (t) => finals.push(t),
      onInterim: (t) => interims.push(t),
    });
    controller.start();
    created[0].emitResult(makeEvent([["你好", false]]));
    expect(interims).toEqual(["你好"]);
    expect(finals).toEqual([]);
    expect(controller.getStatus()).toBe("listening");
  });

  it("final 追加提交一次，并清空临时文本", () => {
    const finals: string[] = [];
    const interims: string[] = [];
    const { controller, created } = setup({
      onFinal: (t) => finals.push(t),
      onInterim: (t) => interims.push(t),
    });
    controller.start();
    created[0].emitResult(makeEvent([["你好", false]]));
    created[0].emitResult(makeEvent([["你好  世界 ", true]]));
    expect(interims[interims.length - 1]).toBe("");
    expect(finals).toEqual(["你好 世界"]);
  });

  it("resultIndex 之前的历史结果不重复处理", () => {
    const finals: string[] = [];
    const { controller, created } = setup({ onFinal: (t) => finals.push(t) });
    controller.start();
    created[0].emitResult(
      makeEvent(
        [
          ["上一条", true],
          ["新一条", true],
        ],
        1,
      ),
    );
    expect(finals).toEqual(["新一条"]);
  });

  it("出错 → onError(kind) + error 状态，随后回 idle，且不写入结果", () => {
    const errors: string[] = [];
    const finals: string[] = [];
    const { controller, created, statuses } = setup({
      onError: (k) => errors.push(k),
      onFinal: (t) => finals.push(t),
    });
    controller.start();
    created[0].emitError("not-allowed");
    expect(errors).toEqual(["permission"]);
    expect(finals).toEqual([]);
    expect(statuses).toEqual(["listening", "error", "idle"]);
    expect(controller.getStatus()).toBe("idle");
  });

  it("再次 toggle 停止识别", () => {
    const { controller, created, statuses } = setup();
    controller.toggle();
    expect(controller.getStatus()).toBe("listening");
    controller.toggle();
    expect(controller.getStatus()).toBe("idle");
    expect(created[0].stopped).toBe(1);
    expect(statuses).toEqual(["listening", "idle"]);
  });

  it("dispose 后不再新建识别器", () => {
    const { controller, created } = setup();
    controller.start();
    controller.dispose();
    expect(created[0].stopped).toBe(1);
    controller.start();
    expect(created).toHaveLength(1);
  });

  it("不支持（工厂返回 null）时静默：不抛错、不报错", () => {
    const errors: string[] = [];
    const controller = createSpeechController({
      createRecognition: () => null,
      handlers: { onError: (k) => errors.push(k) },
    });
    expect(() => controller.start()).not.toThrow();
    expect(controller.getStatus()).toBe("idle");
    expect(errors).toEqual([]);
  });
});

// ── 组件接线 / 渲染门（源码断言，同仓内先例）──────────────────────────
const composerSrc = readFileSync(
  new URL("../src/components/RoomChatComposer.tsx", import.meta.url),
  "utf8",
);

describe("RoomChatComposer 接线", () => {
  it("麦克风按钮只在 speechSupported 分支内（不支持不显示）", () => {
    const gate = composerSrc.indexOf("{speechSupported ? (");
    expect(gate).toBeGreaterThan(-1);
    // 下一个区块标记（#87 引用工作区文件）之前 = 该三元表达式内部
    const nextSection = composerSrc.indexOf("{/* #87 引用工作区文件", gate);
    expect(nextSection).toBeGreaterThan(gate);
    const block = composerSrc.slice(gate, nextSection);
    expect(block).toContain('aria-label={tr("语音输入")}');
    expect(block).toContain("minWidth: 44");
    expect(block).toContain("minHeight: 44");
    expect(block).toContain("toggleSpeech");
    expect(block).toContain('tr("正在听…")');
  });

  it("临时文本只贴输入框末尾显示，不写草稿", () => {
    expect(composerSrc).toContain("appendTranscript(draft, speechInterim)");
  });

  it("final 只回填草稿（applyDraftValue），不自动发送", () => {
    const at = composerSrc.indexOf("onFinal: (text) => {");
    expect(at).toBeGreaterThan(-1);
    const body = composerSrc.slice(at, composerSrc.indexOf("},", at));
    expect(body).toContain("applyDraftValue");
    expect(body).not.toContain("handleSend");
  });

  it("卸载 / 切房 / 发送三处都停止识别", () => {
    expect(composerSrc).toContain("speechCtrlRef.current?.dispose()");
    expect(composerSrc).toContain("}, [roomId]);");
    expect(composerSrc).toContain("if (sending) speechCtrlRef.current?.stop();");
  });

  it("不开摄像头、不引入重型识别依赖（whisper/transformers）", () => {
    expect(composerSrc).not.toContain("getUserMedia");
    expect(composerSrc).not.toContain("transformers");
    expect(composerSrc).not.toContain("whisper");
  });
});

"use client";

import { api } from "./api";

/* ───────────────────────────── Mouth ─────────────────────────────
 * Speaks streamed text as it arrives. The first sentence is voiced the moment
 * it's complete so SUNDAY starts talking fast; later sentences are merged into
 * larger chunks while she speaks. At most PREFETCH chunks are being fetched at
 * once, which keeps us under ElevenLabs' per-plan concurrency limit.
 * stop() silences her instantly.
 */

const SENTENCE_END = /[.!?…]+["')\]]*\s+|\n+/;
const PREFETCH = 2;
const MIN_CHUNK = 110;

type Chunk = { text: string; audio?: Promise<AudioBuffer | null> };

export class Speaker {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levels = new Uint8Array(256);
  private buffer = "";
  private pending = "";
  private firstSent = false;
  private queue: Chunk[] = [];
  private pumping = false;
  private generation = 0;
  private aborts = new Set<AbortController>();
  private current: AudioBufferSourceNode | null = null;
  private synthSpeaking = false;
  private elevenDisabled = false;

  constructor(
    private useEleven: () => boolean,
    private hooks: { onStart: () => void; onIdle: () => void; onError: (msg: string) => void },
  ) {}

  get speaking() {
    return this.pumping || this.synthSpeaking;
  }

  private nowSaying = "";

  /** The words SUNDAY is speaking right now (for telling her own echo from the user). */
  get saying() {
    return this.speaking ? this.nowSaying : "";
  }

  /** Output loudness 0..1 for the orb. */
  level(): number {
    if (this.synthSpeaking) return 0.35 + Math.sin(performance.now() / 90) * 0.15;
    if (!this.analyser || !this.current) return 0;
    this.analyser.getByteTimeDomainData(this.levels);
    let sum = 0;
    for (const v of this.levels) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.levels.length) * 4);
  }

  private audio() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Call from a user gesture once so autoplay is allowed. */
  unlock() {
    this.audio();
  }

  private get eleven() {
    return this.useEleven() && !this.elevenDisabled;
  }

  feed(delta: string) {
    this.buffer += delta;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE_END.exec(this.buffer))) {
      const cut = m.index + m[0].length;
      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence) this.addSentence(sentence);
    }
    // Very long clause without punctuation: break at a comma so speech keeps flowing.
    if (this.buffer.length > 260) {
      const at = this.buffer.lastIndexOf(", ");
      if (at > 60) {
        this.addSentence(this.buffer.slice(0, at + 1).trim());
        this.buffer = this.buffer.slice(at + 2);
      }
    }
  }

  private addSentence(sentence: string) {
    if (!this.firstSent) {
      this.firstSent = true;
      this.enqueue(sentence);
      return;
    }
    this.pending = this.pending ? `${this.pending} ${sentence}` : sentence;
    // Merge while she's talking; send at once if she'd otherwise fall silent.
    if (this.pending.length >= MIN_CHUNK || !this.pumping) this.releasePending();
  }

  private releasePending() {
    const text = this.pending;
    this.pending = "";
    if (text) this.enqueue(text);
  }

  flush() {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.pending = this.pending ? `${this.pending} ${rest}` : rest;
    this.releasePending();
    this.firstSent = false;
    if (!this.speaking) this.hooks.onIdle();
  }

  say(text: string) {
    this.feed(text + " ");
    this.flush();
  }

  stop() {
    this.generation++;
    this.buffer = "";
    this.pending = "";
    this.firstSent = false;
    this.queue = [];
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
    try {
      this.current?.stop();
    } catch {}
    this.current = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.synthSpeaking = false;
    this.pumping = false;
  }

  private enqueue(text: string) {
    const clean = text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.queue.push({ text: clean });
    this.prefetch();
    void this.pump();
  }

  /** Start fetching the next chunks, never more than PREFETCH requests at once. */
  private prefetch() {
    if (!this.eleven) return;
    for (const chunk of this.queue.slice(0, PREFETCH)) {
      if (this.aborts.size >= PREFETCH) break;
      chunk.audio ??= this.fetchAudio(chunk.text);
    }
  }

  private async fetchAudio(text: string, attempt = 0): Promise<AudioBuffer | null> {
    const ctrl = new AbortController();
    this.aborts.add(ctrl);
    try {
      const res = await api("/api/tts", { method: "POST", body: JSON.stringify({ text }), signal: ctrl.signal });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        // Only a bad key / missing setup disables the voice; busy or flaky responses just retry.
        if (res.status === 401 || res.status === 403 || res.status === 501) {
          this.elevenDisabled = true;
          this.hooks.onError(error ?? `Voice service error ${res.status}`);
          return null;
        }
        if (attempt < 2 && !ctrl.signal.aborted) {
          this.aborts.delete(ctrl);
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          return this.fetchAudio(text, attempt + 1);
        }
        console.warn("[sunday] voice chunk failed:", error ?? res.status);
        return null;
      }
      return await this.audio().decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    } finally {
      this.aborts.delete(ctrl);
      this.prefetch();
    }
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    const gen = this.generation;
    this.hooks.onStart();
    while (gen === this.generation) {
      if (!this.queue.length) this.releasePending();
      const chunk = this.queue.shift();
      if (!chunk) break;
      this.prefetch();
      const buffer = this.eleven ? await (chunk.audio ?? this.fetchAudio(chunk.text)) : null;
      if (gen !== this.generation) return;
      this.nowSaying = chunk.text;
      if (buffer) await this.playBuffer(buffer, gen);
      else await this.speakWithBrowser(chunk.text, gen);
    }
    if (gen !== this.generation) return;
    this.pumping = false;
    this.hooks.onIdle();
  }

  private playBuffer(buffer: AudioBuffer, gen: number) {
    return new Promise<void>((resolve) => {
      if (gen !== this.generation) return resolve();
      const ctx = this.audio();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser!);
      src.onended = () => {
        if (this.current === src) this.current = null;
        resolve();
      };
      this.current = src;
      src.start();
    });
  }

  private speakWithBrowser(text: string, gen: number) {
    return new Promise<void>((resolve) => {
      if (typeof speechSynthesis === "undefined" || gen !== this.generation) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickFemaleVoice();
      if (voice) u.voice = voice;
      u.rate = 1.04;
      u.pitch = 1.05;
      this.synthSpeaking = true;
      u.onend = u.onerror = () => {
        this.synthSpeaking = false;
        resolve();
      };
      speechSynthesis.speak(u);
    });
  }
}

function pickFemaleVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  const preferred = ["Aria", "Jenny", "Sonia", "Libby", "Zira", "Hazel", "Susan", "Samantha", "Female"];
  for (const name of preferred) {
    const v = voices.find((v) => v.name.includes(name));
    if (v) return v;
  }
  return voices[0];
}

/* ───────────────────────────── Ears ─────────────────────────────
 * Streams the microphone to Deepgram and reports interim words (for barge-in
 * and the live caption) and finished utterances (to send to SUNDAY).
 */

export type EarHooks = {
  onInterim: (text: string) => void;
  /** `audio` is the utterance as 16 kHz mono 16-bit PCM, for Voice ID (when available). */
  onUtterance: (text: string, audio?: Int16Array) => void;
  onError: (msg: string) => void;
};

/**
 * Keeps the last 30 s of microphone audio as 16 kHz mono samples, so an
 * utterance can be cut out by time and checked against sir's voiceprint.
 */
export class PcmTap {
  static readonly RATE = 16_000;
  private ctx: AudioContext;
  private node: ScriptProcessorNode;
  private ring = new Float32Array(PcmTap.RATE * 30);
  /** Total samples captured since the tap started. */
  captured = 0;

  constructor(stream: MediaStream) {
    this.ctx = new AudioContext({ sampleRate: PcmTap.RATE });
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    this.node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) this.ring[(this.captured + i) % this.ring.length] = input[i];
      this.captured += input.length;
    };
    this.ctx.createMediaStreamSource(stream).connect(this.node);
    this.node.connect(this.ctx.destination); // required for onaudioprocess to fire; outputs silence
  }

  /** Samples [from, to) by absolute index, as 16-bit PCM (clamped to what's still buffered). */
  slice(from: number, to: number): Int16Array {
    const end = Math.min(to, this.captured);
    const start = Math.max(from, end - this.ring.length, 0);
    const out = new Int16Array(Math.max(0, end - start));
    for (let i = 0; i < out.length; i++) {
      const v = this.ring[(start + i) % this.ring.length];
      out[i] = Math.max(-1, Math.min(1, v)) * 32767;
    }
    return out;
  }

  /** The most recent `seconds` of audio. */
  last(seconds: number) {
    return this.slice(this.captured - Math.round(seconds * PcmTap.RATE), this.captured);
  }

  close() {
    this.node.disconnect();
    void this.ctx.close();
  }
}

export interface Ear {
  start(): Promise<void>;
  stop(): void;
  level(): number;
}

async function openMic() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
}

class MicMeter {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private data = new Uint8Array(256);
  constructor(stream: MediaStream) {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.ctx.createMediaStreamSource(stream).connect(this.analyser);
  }
  level() {
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (const v of this.data) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.data.length) * 5);
  }
  close() {
    void this.ctx.close();
  }
}

export class DeepgramEar implements Ear {
  private ws: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private meter: MicMeter | null = null;
  private tap: PcmTap | null = null;
  /** Tap position when audio started flowing to Deepgram (Deepgram's time zero). */
  private tapZero = 0;
  private finals: string[] = [];
  /** Deepgram time span (seconds) of the utterance being assembled. */
  private span: { start: number; end: number } | null = null;

  constructor(private hooks: EarHooks) {}

  level() {
    return this.meter?.level() ?? 0;
  }

  async start() {
    if (this.ws) return;
    const res = await api("/api/stt-token", { method: "POST" });
    if (!res.ok) throw new Error("Speech recognition isn't configured (DEEPGRAM_API_KEY).");
    const { scheme, token } = (await res.json()) as { scheme: string; token: string };
    this.stream = await openMic();
    this.meter = new MicMeter(this.stream);
    this.tap = new PcmTap(this.stream);

    const params = new URLSearchParams({
      model: "nova-3",
      language: "en",
      smart_format: "true",
      punctuate: "true",
      interim_results: "true",
      endpointing: "450",
      utterance_end_ms: "1100",
      vad_events: "true",
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, [scheme, token]);
    this.ws = ws;

    ws.onopen = () => {
      if (!this.stream) return;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      this.recorder.ondataavailable = (e) => {
        if (e.data.size && ws.readyState === WebSocket.OPEN) ws.send(e.data);
      };
      this.recorder.start(200);
      this.tapZero = this.tap?.captured ?? 0;
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as {
        type: string;
        is_final?: boolean;
        speech_final?: boolean;
        start?: number;
        duration?: number;
        channel?: { alternatives: { transcript: string }[] };
      };
      if (msg.type === "Results") {
        const text = msg.channel?.alternatives[0]?.transcript ?? "";
        if (msg.is_final) {
          if (text) {
            this.finals.push(text);
            const start = msg.start ?? 0;
            const end = start + (msg.duration ?? 0);
            this.span = this.span ? { start: this.span.start, end } : { start, end };
          }
          if (msg.speech_final) this.commit();
          else if (this.finals.length) this.hooks.onInterim(this.finals.join(" "));
        } else if (text) {
          this.hooks.onInterim([...this.finals, text].join(" "));
        }
      } else if (msg.type === "UtteranceEnd") {
        this.commit();
      }
    };
    ws.onerror = () => this.hooks.onError("Lost connection to the speech service.");
    ws.onclose = () => {
      if (this.ws === ws) this.teardown();
    };
  }

  private commit() {
    const text = this.finals.join(" ").trim();
    const span = this.span;
    this.finals = [];
    this.span = null;
    if (!text) return;
    // Cut the utterance out of the tap by Deepgram's timings (with a little padding).
    const rate = PcmTap.RATE;
    const audio =
      this.tap && span
        ? this.tap.slice(this.tapZero + Math.floor((span.start - 0.25) * rate), this.tapZero + Math.ceil((span.end + 0.25) * rate))
        : undefined;
    this.hooks.onUtterance(text, audio);
  }

  stop() {
    const ws = this.ws;
    this.ws = null;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
    ws?.close();
    this.teardown();
  }

  private teardown() {
    try {
      this.recorder?.stop();
    } catch {}
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.meter?.close();
    this.meter = null;
    this.tap?.close();
    this.tap = null;
    this.finals = [];
    this.span = null;
  }
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

/** Fallback for Chrome/Edge tabs without a Deepgram key. Not available inside Electron. */
export class BrowserEar implements Ear {
  private rec: SpeechRecognitionLike | null = null;
  private active = false;
  constructor(private hooks: EarHooks) {}
  static supported() {
    return typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  }
  level() {
    return this.active ? 0.15 : 0;
  }
  async start() {
    const Ctor = ((window as unknown as Record<string, unknown>).SpeechRecognition ??
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as new () => SpeechRecognitionLike;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.hooks.onUtterance(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
      if (interim) this.hooks.onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") this.hooks.onError(`Speech recognition: ${e.error}`);
    };
    rec.onend = () => {
      if (this.active) rec.start();
    };
    this.rec = rec;
    this.active = true;
    rec.start();
  }
  stop() {
    this.active = false;
    this.rec?.stop();
    this.rec = null;
  }
}

/* ─────────────────────────── Wake word ───────────────────────────
 * "Hey Sunday", recognised fully offline by Vosk (open source, no account).
 * The recogniser is restricted to a one-phrase grammar, which makes it a
 * light, private keyword spotter: no audio ever leaves the PC while waiting.
 */
type VoskModel = Awaited<ReturnType<typeof import("vosk-browser").createModel>>;
type VoskRecognizer = InstanceType<VoskModel["KaldiRecognizer"]>;

export class WakeWord {
  private model: VoskModel | null = null;
  private recognizer: VoskRecognizer | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private listening = false;
  private lastFire = 0;
  private onWake: () => void = () => {};

  async init(cfg: { modelPath: string }, onWake: () => void) {
    const { createModel } = await import("vosk-browser");
    this.model = await createModel(new URL(cfg.modelPath, window.location.origin).href, -1);
    this.onWake = onWake;
  }

  private check(text: string | undefined) {
    if (!text || !/\bhey sunday\b/.test(text)) return;
    const now = Date.now();
    if (now - this.lastFire < 2500) return;
    this.lastFire = now;
    this.onWake();
  }

  async resume() {
    if (!this.model || this.listening) return;
    this.listening = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (err) {
      // Not listening after all — so a later resume (e.g. once a mic is plugged in) can retry.
      this.listening = false;
      throw err;
    }
    if (!this.listening) return this.release();
    this.ctx = new AudioContext();
    const recognizer = new this.model.KaldiRecognizer(this.ctx.sampleRate, JSON.stringify(["hey sunday", "[unk]"]));
    recognizer.on("partialresult", (m) => this.check((m as unknown as { result: { partial?: string } }).result.partial));
    recognizer.on("result", (m) => this.check((m as unknown as { result: { text?: string } }).result.text));
    this.recognizer = recognizer;
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      try {
        recognizer.acceptWaveform(e.inputBuffer);
      } catch {}
    };
    this.ctx.createMediaStreamSource(this.stream).connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  async pause() {
    this.listening = false;
    this.release();
  }

  private release() {
    this.node?.disconnect();
    this.node = null;
    this.recognizer?.remove();
    this.recognizer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  get active() {
    return this.listening;
  }
}

/** A soft two-note chime when SUNDAY starts listening. */
export function chime(kind: "wake" | "sleep" = "wake") {
  try {
    const ctx = new AudioContext();
    const notes = kind === "wake" ? [660, 990] : [740, 494];
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const t = ctx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.08, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch {}
}

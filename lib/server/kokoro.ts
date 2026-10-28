import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OfflineTts, GenerationConfig } from "sherpa-onnx-node";
import { DATA_DIR } from "./config";

/**
 * SUNDAY's free, offline voice: Kokoro (British English) running on the CPU via sherpa-onnx.
 * Model: models/tts/kokoro-multi-lang-v1_0 (the full-precision build — the int8 one is ~4×
 * slower on CPUs without VNNI, like sir's Xeon).
 *
 * Kokoro reads words from a pronunciation dictionary and silently skips anything missing from it,
 * so text is first rewritten into dictionary words: numbers, times and symbols become words,
 * acronyms are spelled out, and unknown names are built from known pieces ("Gmail" → "gee mail").
 */

const MODEL_DIR = path.join(process.cwd(), "models", "tts", "kokoro-multi-lang-v1_0");
const LEXICON = path.join(MODEL_DIR, "lexicon-gb-en.txt");
const EXTRA_LEXICON = path.join(DATA_DIR, "tts", "lexicon-gb-extra.txt");
const THREADS = Number(process.env.SUNDAY_KOKORO_THREADS ?? 6);
const SPEED = Number(process.env.SUNDAY_KOKORO_SPEED ?? 1);

/** The British female voices in this model, by speaker id. */
export const KOKORO_VOICES = { alice: 20, emma: 21, isabella: 22, lily: 23 } as const;
export type KokoroVoice = keyof typeof KOKORO_VOICES;

export function kokoroVoice(): KokoroVoice {
  const v = (process.env.SUNDAY_KOKORO_VOICE ?? "").toLowerCase();
  return v in KOKORO_VOICES ? (v as KokoroVoice) : "emma";
}

export const kokoroAvailable = () => existsSync(path.join(MODEL_DIR, "model.onnx")) && existsSync(LEXICON);

type Engine = { tts: OfflineTts; words: Set<string> };
const g = globalThis as unknown as { __sundayKokoro?: Promise<Engine>; __sundayKokoroQueue?: Promise<unknown> };

/** Loads the model once (≈3 s, ~400 MB of RAM). Safe to call early to warm it up. */
export function loadKokoro(): Promise<Engine> {
  g.__sundayKokoro ??= (async () => {
    const lexicon = readLexicon(LEXICON);
    const extra = inflections(lexicon);
    mkdirSync(path.dirname(EXTRA_LEXICON), { recursive: true });
    writeFileSync(EXTRA_LEXICON, [...extra].map(([w, p]) => `${w} ${p}`).join("\n") + "\n", "utf8");
    const tts = await OfflineTts.createAsync({
      model: {
        kokoro: {
          model: path.join(MODEL_DIR, "model.onnx"),
          voices: path.join(MODEL_DIR, "voices.bin"),
          tokens: path.join(MODEL_DIR, "tokens.txt"),
          lexicon: `${LEXICON},${EXTRA_LEXICON}`,
        },
        numThreads: THREADS,
        provider: "cpu",
        debug: false,
      },
      maxNumSentences: 1,
    });
    return { tts, words: new Set([...lexicon.keys(), ...extra.keys()]) };
  })().catch((err) => {
    g.__sundayKokoro = undefined;
    throw err;
  });
  return g.__sundayKokoro;
}

/** Speaks one chunk as a 16-bit WAV. Chunks are made one at a time, in order — the CPU is the limit. */
export function kokoroSpeak(text: string, signal?: AbortSignal): Promise<Buffer | null> {
  const job = (g.__sundayKokoroQueue ?? Promise.resolve()).then(async () => {
    if (signal?.aborted) return null;
    const { tts, words } = await loadKokoro();
    const spoken = speakable(text, words);
    if (!spoken.trim()) return null;
    const audio = await tts.generateAsync({
      text: spoken,
      enableExternalBuffer: true,
      generationConfig: new GenerationConfig({ sid: KOKORO_VOICES[kokoroVoice()], speed: SPEED, silenceScale: 0.2 }),
    });
    return wav(audio.samples, audio.sampleRate);
  });
  g.__sundayKokoroQueue = job.catch(() => {});
  return job;
}

/* ───────── Pronunciation dictionary ───────── */

function readLexicon(file: string) {
  const map = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const at = line.indexOf(" ");
    if (at > 0) map.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
  }
  return map;
}

const SIBILANT = new Set(["s", "z", "ʃ", "ʒ", "ʧ", "ʤ"]);
const VOICELESS = new Set(["p", "t", "k", "f", "θ"]);
const VOWEL = /[aeiou]/;

/**
 * The dictionary has base words but often not their other forms ("opened", "skies", "emails",
 * "today's"), so those are made from the base word's pronunciation with the usual English rules.
 */
function inflections(lexicon: Map<string, string>) {
  const out = new Map<string, string>();
  const add = (word: string, phones: string) => {
    if (!lexicon.has(word) && !out.has(word)) out.set(word, phones);
  };
  for (const [word, phones] of Object.entries(NAMES)) {
    add(word, phones);
    add(`${word}'s`, `${phones} ${SIBILANT.has(phones.split(" ").at(-1)!) ? "ɪ z" : "z"}`);
  }
  for (const [word, phones] of lexicon) {
    if (!/^[a-z]{2,14}$/.test(word)) continue;
    const last = phones.split(" ").at(-1) ?? "";
    const sEnding = SIBILANT.has(last) ? "ɪ z" : VOICELESS.has(last) ? "s" : "z";
    add(`${word}'s`, `${phones} ${sEnding}`);
    // Already an inflected form — "started" doesn't need "starteds".
    if (/(ed|ing|'s)$/.test(word) || (word.endsWith("s") && !/(ss|us|is)$/.test(word))) continue;
    const consonantY = /[^aeiou]y$/.test(word);
    const stem = word.endsWith("e") && !/(ee|ye|oe)$/.test(word) ? word.slice(0, -1) : word;
    // "stop" → "stopped", "plan" → "planning": short words ending consonant-vowel-consonant double it.
    const doubled = /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(word) && word.length <= 5 ? word + word.at(-1) : null;
    // Plural / he-she form.
    add(consonantY ? `${word.slice(0, -1)}ies` : /(s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`, `${phones} ${sEnding}`);
    // Past: "opened", "created", "tried".
    const pastPhones = `${phones} ${last === "t" || last === "d" ? "ɪ d" : VOICELESS.has(last) || last === "ʃ" || last === "ʧ" || last === "s" ? "t" : "d"}`;
    add(consonantY ? `${word.slice(0, -1)}ied` : word.endsWith("e") ? `${word}d` : `${word}ed`, pastPhones);
    if (doubled) add(`${doubled}ed`, pastPhones);
    // -ing: "opening", "making", "stopping".
    if (VOWEL.test(word)) {
      add(word.endsWith("ie") ? `${word.slice(0, -2)}ying` : `${stem}ing`, `${phones} ɪ ŋ`);
      if (doubled) add(`${doubled}ing`, `${phones} ɪ ŋ`);
    }
  }
  return out;
}

/* ───────── Text → dictionary words ───────── */

const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

function below1000(n: number) {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(ONES[h], "hundred");
  if (r) {
    if (h) parts.push("and");
    parts.push(r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ""}`);
  }
  return parts.join(" ");
}

/** British cardinals: "one hundred and twenty". Huge numbers are read digit by digit. */
function cardinal(n: number): string {
  if (n < 0) return `minus ${cardinal(-n)}`;
  if (!Number.isSafeInteger(n) || n >= 1e12) return String(n).split("").map((d) => ONES[Number(d)] ?? "").join(" ");
  if (n < 1000) return n === 0 ? "zero" : below1000(n);
  const parts: string[] = [];
  let rest = n;
  for (const [size, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as const) {
    if (rest >= size) {
      parts.push(below1000(Math.floor(rest / size)), name);
      rest %= size;
    }
  }
  if (rest) parts.push(...(rest < 100 ? ["and"] : []), below1000(rest));
  return parts.join(" ");
}

/** 2026 → "twenty twenty six", 1999 → "nineteen ninety nine", 2005 → "two thousand and five". */
function year(n: number) {
  if (n >= 2000 && n < 2010) return cardinal(n);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  return `${cardinal(hi)} ${lo === 0 ? "hundred" : lo < 10 ? `oh ${ONES[lo]}` : cardinal(lo)}`;
}

function ordinal(n: number) {
  const words = cardinal(n).split(" ");
  const last = words.pop()!;
  const special: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
  words.push(special[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`));
  return words.join(" ");
}

const digits = (s: string) => s.split("").map((d) => ONES[Number(d)]).join(" ");

/** Letter names for spelling out acronyms (British "zed"). */
const LETTER: Record<string, string> = {
  a: "a", b: "bee", c: "see", d: "dee", e: "e", f: "eff", g: "gee", h: "aitch", i: "eye", j: "jay", k: "kay", l: "el", m: "em",
  n: "en", o: "oh", p: "pee", q: "queue", r: "are", s: "ess", t: "tee", u: "you", v: "vee", w: "double you", x: "ex", y: "why", z: "zed",
};
const spell = (w: string) => w.toLowerCase().split("").map((c) => LETTER[c] ?? ONES[Number(c)] ?? "").filter(Boolean).join(" ");

/** Names SUNDAY says often that the dictionary lacks, written in the model's own sound symbols. */
const NAMES: Record<string, string> = {
  higgsfield: "h ˈ ɪ ɡ z f ˌ i ː l d",
  higgs: "h ˈ ɪ ɡ z",
  qwen: "ʧ w ˈ ɛ n",
  ollama: "ə l ˈ ɑ ː m ə",
  spotify: "s p ˈ ɒ t ɪ f ˌ I",
  gmail: "ʤ ˈ i ː m ˌ A l",
  jarvis: "ʤ ˈ ɑ ː v ɪ s",
};

/** Other names, respelled in words the dictionary knows. */
const RESPELL: Record<string, string> = {
  vscode: "vee ess code", todo: "to do", todos: "to dos", wifi: "wi-fi", deepgram: "deep gram", elevenlabs: "eleven labs",
  onedrive: "one drive", github: "git hub", chatgpt: "chat gee pee tee", iphone: "eye phone", ok: "okay",
  eslint: "ee ess lint", npm: "en pee em", npx: "en pee ex", nextjs: "next jay ess", nodejs: "node jay ess",
};

const FILE_EXT = /\b([\w-]+)\.(py|js|mjs|cjs|ts|tsx|jsx|json|html|css|md|txt|csv|pdf|png|jpe?g|gif|mp3|mp4|wav|glb|blend|docx?|xlsx?|pptx?|exe|zip)\b/gi;

/** Rewrites a reply so every word is one Kokoro can pronounce. */
export function speakable(text: string, words: Set<string>): string {
  let t = text
    .replace(/[’‘]/g, "'")
    .replace(/�/g, " ")
    // Quotes and brackets stick to the word ('"Python', "(two)") and make it unknown, so it'd be skipped.
    // Apostrophes inside a word ("it's", "sir's") stay.
    // Commands read aloud: "$p", "--port", "-p" — the symbols alone are unknown words.
    .replace(/\$(?=[A-Za-z_])/g, "")
    .replace(/(^|\s)-{1,2}(?=[A-Za-z])/g, "$1")
    .replace(/(^|\s)-{2,}(?=\s|$)/g, "$1")
    .replace(/\)(?=\.[A-Za-z])/g, "")
    .replace(/["“”«»()]/g, " ")
    .replace(/(^|[^\p{L}\p{N}])'+|'+(?=[^\p{L}\p{N}]|$)/gu, "$1 ")
    // A dash reads as a pause (the dictionary treats "—" as an unknown word); "6–18" stays a range.
    .replace(/(\D)\s*[—–]\s*/g, "$1, ")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/\b([A-Za-z]):\\/g, "$1 drive ")
    .replace(/\b([A-Z]):(?=\s|$|[.,;])/g, "$1 drive")
    .replace(/[\\/]/g, " ")
    .replace(/([A-Za-z]{2,}):(?=[A-Za-z])/g, "$1 ")
    .replace(FILE_EXT, "$1 dot $2")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(^|[\s(])-(?=\d)/g, "$1minus ")
    .replace(/(\d)\s*[–-]\s*(?=-?\d)/g, "$1 to ")
    .replace(/°\s*C\b/g, " degrees")
    .replace(/°\s*F\b/g, " degrees fahrenheit")
    .replace(/°/g, " degrees")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/([$£€])\s?(\d+(?:\.\d+)?)/g, (_, cur: string, n: string) => `${n} ${{ $: "dollars", "£": "pounds", "€": "euros" }[cur]}`)
    .replace(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?(?=\W|$)/gi, (_, h, m, ap: string) => `${h}:${m} ${ap.toLowerCase() === "a" ? "a em" : "pee em"}`)
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, h: string, m: string) => {
      const mm = Number(m);
      return `${cardinal(Number(h))} ${mm === 0 ? "o'clock" : mm < 10 ? `oh ${ONES[mm]}` : cardinal(mm)}`;
    })
    .replace(/\b(\d+)\.(\d+)\b/g, (_, a: string, b: string) => `${cardinal(Number(a))} point ${digits(b)}`)
    .replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n: string) => ordinal(Number(n)))
    // "14B", "6GB", "Qwen3" → number and letters apart, so the number is read as a number.
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/\b\d+\b/g, (n) => (n.length === 4 && Number(n) >= 1100 && Number(n) < 2100 ? year(Number(n)) : n.length > 1 && n.startsWith("0") ? digits(n) : cardinal(Number(n))))
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/=/g, " equals ")
    .replace(/@/g, " at ")
    .replace(/#(?=\d)/g, "number ")
    .replace(/[#*_`~^|<>{}[\]]/g, " ");

  // Word by word: keep known words, rebuild the rest from pieces the dictionary has.
  t = t.replace(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu, (w) => sayWord(w, words));
  return t.replace(/\s+/g, " ").trim();
}

function sayWord(word: string, words: Set<string>): string {
  const w = word.replace(/'+$/, "");
  const lw = w.toLowerCase();
  if (RESPELL[lw]) return RESPELL[lw];
  // Acronyms first: "AI" is a word in the dictionary (a sloth), but SUNDAY means A-I.
  if (/^[A-Z][A-Z0-9]{1,5}s?$/.test(w)) return w.endsWith("s") && w.length > 2 ? `${spell(w.slice(0, -1))}s` : spell(w);
  if (words.has(lw)) return w;
  if (lw.includes("-")) return lw.split("-").filter(Boolean).map((p) => sayWord(p, words)).join(" ");
  // CamelCase: "OneDrive", "YouTube", "VSCode".
  const camel = w.match(/[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|\d+/g);
  if (camel && camel.length > 1) return camel.map((p) => sayWord(p, words)).join(" ");
  if (lw.endsWith("'s") && words.has(lw.slice(0, -2))) return `${lw.slice(0, -2)} is`;
  return segment(lw, words) ?? (lw.length <= 4 ? spell(lw) : w);
}

/** Splits an unknown word into the fewest dictionary words ("deepgram" → "deep gram"); a lone first letter is spelled. */
function segment(w: string, words: Set<string>): string | null {
  if (w.length > 24 || !/^[a-z]+$/.test(w)) return null;
  const best: ({ cost: number; parts: string[] } | null)[] = Array(w.length + 1).fill(null);
  best[0] = { cost: 0, parts: [] };
  for (let i = 0; i < w.length; i++) {
    const from = best[i];
    if (!from) continue;
    for (let j = i + 1; j <= w.length; j++) {
      const piece = w.slice(i, j);
      const single = piece.length === 1;
      // A spelled first letter ("g-mail"), or a real word — two letters only after the start ("oh-llama" style splits stay sane).
      const usable = single ? i === 0 : (piece.length >= 3 || i > 0) && words.has(piece);
      if (!usable) continue;
      const cost = from.cost + (single ? 2.5 : 1);
      if (!best[j] || cost < best[j]!.cost) best[j] = { cost, parts: [...from.parts, single ? LETTER[piece] : piece] };
    }
  }
  return best[w.length]?.parts.join(" ") ?? null;
}

/* ───────── Audio ───────── */

function wav(samples: Float32Array, rate: number) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

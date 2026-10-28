/**
 * SUNDAY's unit tests — no server, no AI calls, free to run: `npm test`.
 * Each case comes from a real failure (noted beside it), so a fix can't quietly come undone.
 * Uses its own data dir (.sunday-test, cleared each run) and a folder for files to edit, deleted
 * afterwards — never sir's files or memory. SUNDAY refuses to edit inside her own project and in AppData
 * (where the temp folder is), so the files live in sunday-test-files at the root of the project's drive.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const DATA = path.resolve(".sunday-test");
const WORK = path.join(path.parse(process.cwd()).root, "sunday-test-files", String(process.pid));
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(WORK, { recursive: true });
process.env.SUNDAY_DATA_DIR = DATA;

const guards = await import("../lib/server/guards");
const { codingRoute } = await import("../lib/server/brains");
const { splitOpening } = await import("../lib/client/voice");
const { priceOf } = await import("../lib/server/spend");
const { indexPath, searchIndex } = await import("../lib/server/indexer");
const code = await import("../lib/server/tools/code");

// The data dir stays until the next run: its database is still open here.
after(() => rmSync(path.dirname(WORK), { recursive: true, force: true }));

describe("reply guards", () => {
  // 28 Oct: "I replaced the insertion sort…" three times with no edit made.
  for (const claim of [
    "I replaced the insertion sort with a quick sort function in the Python file.",
    "I've approved the install, sir.",
    "I've swapped it for quick sort.",
    "The file was updated.",
    "I changed the insertion sort function to a quick sort function.",
  ]) test(`claim: ${claim}`, () => assert.match(claim, guards.CLAIM));
  for (const fine of ["Would you like me to replace it?", "I can switch it to quick sort if you like.", "The weather is sunny today, sir."])
    test(`not a claim: ${fine}`, () => assert.doesNotMatch(fine, guards.CLAIM));

  // 28 Oct: five "Could you please…" replies in a row instead of looking.
  for (const ask of [
    "I'm here, sir. What errors are you referring to?",
    "I'm here, sir. Could you please confirm the correct path or name of the folder?",
    "I'm here, sir. Could you please describe what you're seeing or the issue you're encountering?",
  ]) test(`stalling question: ${ask}`, () => assert.match(ask, guards.CLARIFY));
  test("a real choice isn't stalling", () => assert.doesNotMatch("Which colour would you like, sir — blue or green?", guards.CLARIFY));

  test("screen questions go to a brain that can see", () => {
    assert.match("Can you see my screen?", guards.SCREEN);
    assert.doesNotMatch("Turn off the screen saver", guards.SCREEN);
  });

  test("a word-for-word repeat is caught, a reworded one isn't", () => {
    assert.ok(guards.sameWords("The file implements the insertion sort.", "the file implements the insertion sort"));
    assert.ok(!guards.sameWords("It's done.", "It's done, sir — quick sort now."));
  });
});

describe("coding goes to Claude with the local brain pinned", () => {
  const cases: [string, "deep" | "fast" | null][] = [
    ["Can you find the error? What what is causing it?", "deep"],
    ["I'm getting a bunch of errors in", "deep"],
    ["Check pages dot TSX in app folder. In Sunday testing project tool that we created.", "fast"],
    ["Can you please install NextJS", "fast"],
    ["Now remove the print that you made and instead make a function", "fast"],
    ["What's my schedule today?", null],
    ["Set a timer for ten minutes", null],
    ["Create a folder on my desktop called holiday photos", null],
    ["Stay local and write a function", null],
  ];
  for (const [text, want] of cases) test(`${want ?? "local"}: ${text}`, () => assert.equal(codingRoute(text), want));
});

describe("her first words start fast", () => {
  test("a short sentence goes whole", () => assert.deepEqual(splitOpening("Of course, sir."), ["Of course, sir.", ""]));
  test("a long one is cut at its first pause", () =>
    assert.deepEqual(splitOpening("A lovely autumn evening in London is crisp and golden, with the streetlights coming on early along the river."), [
      "A lovely autumn evening in London is crisp and golden,",
      "with the streetlights coming on early along the river.",
    ]));
  test("no comma: cut before a joining word", () =>
    assert.equal(splitOpening("I've swapped the insertion sort in sort_test1.py for a quick sort that picks a middle pivot and splits the list.")[0], "I've swapped the insertion sort in sort_test1.py"));
});

describe("spend", () => {
  test("Haiku reply", () => assert.equal(priceOf("claude-haiku-5-5", { input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 150 })!.toFixed(6), "0.000225"));
  test("Opus turn", () => assert.equal(priceOf("claude-opus-5-5", { input_tokens: 2000, cache_read_input_tokens: 10000, output_tokens: 400 })!.toFixed(4), "0.0180"));
  test("web search adds a cent", () => assert.equal(priceOf("claude-opus-5-5", { server_tool_use: { web_search_requests: 1 } })!.toFixed(2), "0.01"));
  test("Haiku over 100K tokens costs more", () => assert.equal(priceOf("claude-haiku-5-5", { input_tokens: 150_000 })!.toFixed(3), "0.075"));
});

describe("finding files by spoken names", () => {
  before(() => {
    for (const name of ["Sunday testing project 2", "Holiday photos"]) {
      const dir = path.join(WORK, name);
      mkdirSync(dir, { recursive: true });
      indexPath(dir, true);
    }
  });
  // 28 Oct: speech-to-text wrote "two" (and once "tool") for the folder "…project 2".
  test('"two" finds "2"', () => assert.ok(searchIndex("Sunday testing project two", { kind: "folder" }).results.some((r) => r.name.endsWith("2"))));
  test('"tool" (misheard) is a close match, flagged as such', () => {
    const r = searchIndex("Sunday testing project tool", { kind: "folder" });
    assert.ok(r.close && r.results.some((x) => x.name === "Sunday testing project 2"));
  });
  test("a clean match isn't flagged", () => assert.equal(searchIndex("holiday photos").close, false));
});

const hasPython = (() => {
  try {
    execFileSync("python", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("code edits", () => {
  // 28 Oct: renamed the function but left a call to insertion_sort — the file no longer ran.
  test("a call to a function that no longer exists is caught", { skip: !hasPython && "no Python" }, async () => {
    const file = path.join(WORK, "renamed.py");
    const r = await code.writeFile(file, "def quick_sort(a):\n    return sorted(a)\n\nprint(insertion_sort([3, 1]))\n");
    assert.match(String((r as { syntax_error?: string }).syntax_error), /insertion_sort is used but never defined/);
  });
  test("valid Python passes", { skip: !hasPython && "no Python" }, async () => {
    const r = await code.writeFile(path.join(WORK, "ok.py"), "import os\nfor i, (a, b) in enumerate([(1, 2)]):\n    print(i, a, b, os.sep)\n");
    assert.equal((r as { syntax_error?: string }).syntax_error, undefined);
  });
  // 28 Oct: two edits to one file at once — the second save wiped out the first.
  test("two edits at once to the same file both land", async () => {
    const file = path.join(WORK, "both.py");
    writeFileSync(file, "a = 1\nb = 2\n");
    await Promise.all([code.editFile(file, "a = 1", "a = 10"), code.editFile(file, "b = 2", "b = 20")]);
    assert.equal(readFileSync(file, "utf8"), "a = 10\nb = 20\n");
  });
});

const KOKORO = path.resolve("models/tts/kokoro-multi-lang-v1_0/model.onnx");
describe("every word she says is one her voice knows", { skip: !existsSync(KOKORO) && "Kokoro model not installed" }, () => {
  // 28 Oct: quotes, brackets and command flags made words unknown, so the voice skipped them.
  for (const line of [
    `I created a file called "Python test (2).py" on your Desktop — it says "print('Hello')".`,
    "I ran npm run dev -- -p 3100 with $p = Start-Process and $env:TEMP, plus ESLint.",
    "It's -5°C at 7:05 pm — sir's 3rd task, and 6–18 GB on D:\\Games.",
  ]) {
    test(line, async () => {
      const { loadKokoro, speakable } = await import("../lib/server/kokoro");
      const { words } = await loadKokoro();
      const unknown = speakable(line, words)
        .split(/\s+/)
        .map((w) => w.replace(/[.,!?;:]+$/, "").toLowerCase())
        .filter((w) => w && !words.has(w));
      assert.deepEqual(unknown, []);
    });
  }
});

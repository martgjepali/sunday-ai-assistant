/**
 * Replays of real conversations against a running test copy of SUNDAY (started by tests/run-replay.mjs —
 * use `npm run test:replay`). Real AI calls: a few cents per run. The local brain is pinned, as sir uses her.
 * Asserts only what must hold every time (which brain answered, what's in the file afterwards),
 * not exact wording, so the models can phrase things their own way.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { CLARIFY } from "../lib/server/guards";

const BASE = process.env.SUNDAY_TEST_URL ?? "http://127.0.0.1:3299";
const WORK = path.join(path.parse(process.cwd()).root, "sunday-test-files", `replay-${process.pid}`);
const HEADERS = { "Content-Type": "application/json", "x-sunday-client": "1" };

type Turn = { reply: string; brains: string[]; tools: string[] };

/** One conversation; each say() is one message, answered in full. */
function conversation() {
  let conversationId: string | null = null;
  return async (text: string): Promise<Turn> => {
    const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: HEADERS, body: JSON.stringify({ conversationId, text, mode: "text" }) });
    assert.equal(res.status, 200, await res.clone().text());
    const turn: Turn = { reply: "", brains: [], tools: [] };
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const e = JSON.parse(line);
        if (e.type === "meta") conversationId = e.conversationId;
        if (e.type === "brain") turn.brains.push(e.brain);
        if (e.type === "tool" && e.status === "start") turn.tools.push(e.name);
        if (e.type === "text") turn.reply += e.delta;
        if (e.type === "error") assert.fail(`SUNDAY error: ${e.message}`);
      }
    }
    return turn;
  };
}

const python = (file: string) => execFileSync("python", [file], { encoding: "utf8", timeout: 20_000 });

before(async () => {
  mkdirSync(WORK, { recursive: true });
  const res = await fetch(`${BASE}/api/brains`, { method: "POST", headers: HEADERS, body: JSON.stringify({ mode: "local" }) });
  assert.equal(res.status, 200);
});
after(() => rmSync(path.dirname(WORK), { recursive: true, force: true }));

describe("replays (local brain pinned)", { concurrency: false }, () => {
  test("everyday questions stay on the free local brain", async () => {
    const t = await conversation()("What time is it?");
    assert.deepEqual(t.brains, ["local"]);
    assert.ok(t.reply.trim());
  });

  // 28 Oct: "I replaced the insertion sort…" three times with nothing changed; then a call left behind.
  test("insertion sort → quick sort: a real edit, by Claude, and the file runs", async () => {
    const file = path.join(WORK, "sort_test.py");
    writeFileSync(
      file,
      "def insertion_sort(arr):\n    for i in range(1, len(arr)):\n        key = arr[i]\n        j = i - 1\n        while j >= 0 and key < arr[j]:\n            arr[j + 1] = arr[j]\n            j -= 1\n        arr[j + 1] = key\n    return arr\n\n# Example usage:\nnumbers = [5, 2, 9, 1, 5, 6]\nsorted_numbers = insertion_sort(numbers)\nprint('Sorted array:', sorted_numbers)\n",
    );
    const say = conversation();
    const look = await say(`Have a look at ${file} and tell me in one sentence what it does.`);
    assert.equal(look.brains[0], "fast", "a file question goes to Claude");
    const change = await say("Or you know what? Use quick sorting.");
    assert.equal(change.brains[0], "fast", "the follow-up stays with Claude");
    const after = readFileSync(file, "utf8");
    assert.match(after, /def quick_sort/);
    assert.doesNotMatch(after, /insertion_sort/);
    assert.match(python(file), /\[1, 2, 5, 5, 6, 9\]/);
  });

  // 28 Oct: she made "Sunday testing project 2", then asked five times where it was.
  test("she finds a file inside the folder she just made, without stalling", async () => {
    const say = conversation();
    const make = await say(`Create a new folder in ${WORK} called Sunday testing project 3.`);
    assert.ok(make.tools.includes("create_folder"), `tools: ${make.tools}`);
    const project = path.join(WORK, "Sunday testing project 3");
    assert.ok(existsSync(project));
    mkdirSync(path.join(project, "app"));
    writeFileSync(path.join(project, "app", "page.tsx"), "export default function Home() {\n  return <main><h1>Hello</h1></main>;\n}\n");
    const check = await say("What does page dot TSX in the app folder of Sunday testing project three say?");
    assert.ok(check.tools.some((t) => ["read_code", "read_file", "list_directory", "search_files"].includes(t)), `tools: ${check.tools}`);
    assert.doesNotMatch(check.reply, CLARIFY, "she looked instead of asking");
    assert.match(check.reply, /hello/i);
  });

  test("what she spends is recorded", async () => {
    const status = await (await fetch(`${BASE}/api/status`, { headers: HEADERS })).json();
    assert.ok(status.spend.month > 0, JSON.stringify(status.spend));
    assert.ok(status.spend.bySource.some((s: { source: string }) => s.source === "fast"));
  });

  test("her voice answers with audio", async () => {
    const res = await fetch(`${BASE}/api/tts`, { method: "POST", headers: HEADERS, body: JSON.stringify({ text: "Good evening, sir." }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/wav");
    assert.ok((await res.arrayBuffer()).byteLength > 10_000);
  });
});

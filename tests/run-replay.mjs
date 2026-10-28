// `npm run test:replay`: builds a separate test copy of SUNDAY, starts it on port 3299 with a fresh data
// folder (never her real memory, voiceprint or files), runs tests/replay.test.mts against it, then stops it.
// The live copy (.next, port 3210) is never touched, so this is safe while SUNDAY is running.
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const PORT = 3299;
const URL = `http://127.0.0.1:${PORT}`;
const DIST = ".next-test";
const DATA = path.resolve(".sunday-test-replay");
const win = process.platform === "win32";
const npx = win ? "npx.cmd" : "npx";
const log = (...a) => console.log("[replay]", ...a);

if (await fetch(URL).then(() => true, () => false)) {
  console.error(`[replay] something is already running on port ${PORT} — stop it first.`);
  process.exit(1);
}

log("building a test copy…");
rmSync(DIST, { recursive: true, force: true }); // a stale test build can serve old CSS
const build = spawnSync(npx, ["next", "build"], { stdio: "inherit", shell: win, env: { ...process.env, SUNDAY_DIST_DIR: DIST } });
if (build.status !== 0) process.exit(build.status ?? 1);

rmSync(DATA, { recursive: true, force: true });
const env = {
  ...process.env,
  SUNDAY_DIST_DIR: DIST,
  SUNDAY_DATA_DIR: DATA,
  SUNDAY_VOICE_ID: "off",
  SUNDAY_TELEGRAM: "off",
  SUNDAY_ROUTINES: "off",
  SUNDAY_INDEXER: "off",
};
log(`starting it on ${URL}…`);
const server = spawn(npx, ["next", "start", "-H", "127.0.0.1", "-p", String(PORT)], { env, shell: win, stdio: "ignore" });
const stop = () => {
  if (win) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill();
};
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

let up = false;
for (let i = 0; i < 90 && !up; i++) {
  up = await fetch(URL).then(() => true, () => false);
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
let code = 1;
if (!up) console.error("[replay] the test copy didn't start");
else {
  const run = spawnSync(npx, ["tsx", "--conditions=react-server", "--test", "tests/replay.test.mts"], {
    stdio: "inherit",
    shell: win,
    env: { ...process.env, SUNDAY_TEST_URL: URL },
  });
  code = run.status ?? 1;
}
stop();
rmSync(DIST, { recursive: true, force: true });
log(code === 0 ? "all replays passed" : "some replays failed");
process.exit(code);

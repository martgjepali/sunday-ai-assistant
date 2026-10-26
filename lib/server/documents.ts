import "server-only";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MODEL } from "./config";
import { logActivity } from "./db";
import { indexPath } from "./indexer";
import { pushNotice } from "./notices";
import { openPath } from "./tools/apps";
import {
  FileToolError,
  assertOnAllowedDrive,
  assertWritable,
  knownFolders,
  realOrSelf,
  recordOp,
  resolveUserPath,
  uniqueTarget,
} from "./tools/files";

/**
 * SUNDAY's document studio: Word, Excel, PowerPoint and PDF files made with
 * Anthropic's document skills in a code-execution container. Jobs run in the
 * background (a deck can take a minute or two) and she announces the result.
 * Files are only ever created — never overwritten — and "undo" sets them aside.
 */

export type DocFormat = "docx" | "xlsx" | "pptx" | "pdf";

const LABEL: Record<DocFormat, string> = {
  docx: "Word document",
  xlsx: "spreadsheet",
  pptx: "presentation",
  pdf: "PDF",
};

type DocJob = {
  id: string;
  format: DocFormat;
  request: string;
  status: "working" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  path?: string;
  summary?: string;
  error?: string;
};

const g = globalThis as unknown as { __sundayDocJobs?: Map<string, DocJob> };
const jobs = (g.__sundayDocJobs ??= new Map<string, DocJob>());

const MAX_SOURCES = 5;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

let client: Anthropic | undefined;

export function defaultDocumentsFolder() {
  return path.win32.join(knownFolders().Documents, "SUNDAY Documents");
}

/** Windows-safe file name without extension. */
function safeName(name: string) {
  const cleaned = name
    .replace(/\.(docx|xlsx|pptx|pdf)$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80);
  return cleaned || "Document";
}

export async function createDocument(input: {
  format: DocFormat;
  request: string;
  filename?: string;
  folder?: string;
  sources?: string[];
  openWhenReady?: boolean;
}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new FileToolError("I need the Anthropic API key for documents.");

  const folder = input.folder ? resolveUserPath(input.folder) : defaultDocumentsFolder();
  assertWritable(folder);
  assertWritable(await realOrSelf(path.win32.dirname(folder)));

  const sources = (input.sources ?? []).map((s) => resolveUserPath(s));
  if (sources.length > MAX_SOURCES) throw new FileToolError(`At most ${MAX_SOURCES} source files per document.`);
  for (const s of sources) {
    assertOnAllowedDrive(s);
    const st = await fs.stat(s).catch(() => null);
    if (!st) throw new FileToolError(`${s} doesn't exist.`);
    if (!st.isFile()) throw new FileToolError(`${s} is a folder — give me the files inside it.`);
    if (st.size > MAX_SOURCE_BYTES) throw new FileToolError(`${path.win32.basename(s)} is over 30 MB.`);
  }

  const job: DocJob = {
    id: randomBytes(4).toString("hex"),
    format: input.format,
    request: input.request.trim(),
    status: "working",
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  logActivity("document", `started ${LABEL[input.format]}`, job.request.slice(0, 120));

  void runJob(job, { folder, sources, filename: input.filename, openWhenReady: input.openWhenReady ?? false });

  return {
    started: true,
    job: job.id,
    savesTo: folder,
    note: "Working in the background (usually 1-3 minutes). I'll announce it when it's ready — don't wait in silence; tell sir it's underway.",
  };
}

async function runJob(
  job: DocJob,
  opts: { folder: string; sources: string[]; filename?: string; openWhenReady: boolean },
) {
  client ??= new Anthropic();
  const uploaded: string[] = [];
  const generated: string[] = [];
  try {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const s of opts.sources) {
      const file = await client.files.upload({ file: await toFile(await fs.readFile(s), path.win32.basename(s)) });
      uploaded.push(file.id);
      content.push({ type: "container_upload", file_id: file.id });
    }
    const ext = job.format;
    const wanted = opts.filename ? `${safeName(opts.filename)}.${ext}` : null;
    content.push({
      type: "text",
      text: [
        `Make one polished ${LABEL[job.format]} (.${ext}) for sir, using the ${job.format} skill.`,
        `His request: ${job.request}`,
        opts.sources.length ? `His files are uploaded to the container: ${opts.sources.map((s) => path.win32.basename(s)).join(", ")}. Use them as the source material.` : "",
        wanted
          ? `Save the finished file as "${wanted}".`
          : `Save the finished file with a short, descriptive name (Title Case, e.g. "Q3 Sales Review.${ext}").`,
        "Don't ask questions — make sensible, professional choices. Produce exactly one final file; make it look designed, not default. Check your work (open/convert it to verify) before finishing.",
        "Finish with one or two plain sentences on what you made — no file paths.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });

    const skills: Anthropic.SkillParams[] = [{ type: "anthropic", skill_id: job.format, version: "latest" }];
    const messages: Anthropic.MessageParam[] = [{ role: "user", content }];
    let containerId: string | undefined;
    let summary = "";

    for (let turn = 0; turn < 10; turn++) {
      const res = await client.messages
        .stream({
          model: MODEL,
          max_tokens: 32_000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          container: { id: containerId, skills },
          tools: [{ type: "code_execution_20260521", name: "code_execution" }],
          messages,
        })
        .finalMessage();
      containerId = res.container?.id ?? containerId;

      for (const block of res.content) {
        if (block.type === "bash_code_execution_tool_result" && block.content.type === "bash_code_execution_result") {
          for (const out of block.content.content) generated.push(out.file_id);
        }
        if (block.type === "text") summary = block.text;
      }
      if (res.stop_reason !== "pause_turn") {
        if (res.stop_reason === "refusal") throw new Error("The request was declined.");
        break;
      }
      messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
    }

    // The deliverable is the last generated file with the right extension.
    let pick: { id: string; filename: string } | undefined;
    for (const id of [...generated].reverse()) {
      const meta = await client.files.retrieveMetadata(id);
      if (meta.filename.toLowerCase().endsWith(`.${ext}`)) {
        pick = { id, filename: meta.filename };
        break;
      }
    }
    if (!pick) throw new Error(`No .${ext} file came back.`);

    const data = Buffer.from(await (await client.files.download(pick.id)).arrayBuffer());
    await fs.mkdir(opts.folder, { recursive: true });
    const target = uniqueTarget(path.win32.join(opts.folder, `${safeName(wanted ?? pick.filename)}.${ext}`));
    await fs.writeFile(target, data, { flag: "wx" });
    recordOp("create-file", "", target);
    indexPath(target, false);
    logActivity("document", path.win32.basename(target), target);

    Object.assign(job, { status: "done", finishedAt: Date.now(), path: target, summary: summary.trim().slice(0, 400) });
    if (opts.openWhenReady) await openPath(target).catch(() => {});
    pushNotice(
      `SUNDAY — ${LABEL[job.format]} ready`,
      `Sir, your ${LABEL[job.format]} "${path.win32.basename(target)}" is ready${opts.openWhenReady ? " — opening it now" : ""}.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Object.assign(job, { status: "failed", finishedAt: Date.now(), error: message.slice(0, 300) });
    logActivity("document", `failed ${LABEL[job.format]}`, message.slice(0, 200));
    pushNotice(`SUNDAY — ${LABEL[job.format]} failed`, `Sir, I couldn't finish the ${LABEL[job.format]}: ${message.slice(0, 140)}`);
  } finally {
    // Tidy up the copies on Anthropic's side; sir's own files are never touched.
    for (const id of [...uploaded, ...generated]) void client.files.delete(id).catch(() => {});
  }
}

/** One line for SUNDAY's context: documents in progress or finished in the last hour. */
export function documentJobsLine() {
  const recent = [...jobs.values()].filter((j) => j.status === "working" || Date.now() - (j.finishedAt ?? 0) < 3_600_000);
  if (!recent.length) return "";
  const parts = recent.map((j) => {
    const what = `${LABEL[j.format]} ("${j.request.slice(0, 60)}${j.request.length > 60 ? "…" : ""}")`;
    if (j.status === "working") return `${what}: still being made (${Math.round((Date.now() - j.startedAt) / 1000)}s so far)`;
    if (j.status === "done") return `${what}: done, saved at ${j.path}${j.summary ? ` — ${j.summary}` : ""}`;
    return `${what}: failed (${j.error})`;
  });
  return `Documents: ${parts.join("; ")}.`;
}

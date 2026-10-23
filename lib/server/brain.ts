import "server-only";
import { readdirSync } from "node:fs";
import path from "node:path";
import { driveRoots } from "./config";
import { db } from "./db";
import { MEMORY_CATEGORIES } from "./memory";
import { startApps } from "./tools/apps";
import { knownFolders } from "./tools/files";
import { listSkills } from "./skills";
import { TOOL_CATALOG } from "./tools";
import { vscodeWorkspaces } from "./tools/code";

const win = path.win32;

export type BrainGroup =
  | "core"
  | "hub"
  | "category"
  | "memory"
  | "conversation"
  | "skill"
  | "drive"
  | "folder"
  | "app"
  | "mail"
  | "web"
  | "code";

export type BrainNode = {
  id: string;
  label: string;
  group: BrainGroup;
  val: number;
  detail?: string;
};
export type BrainLink = { source: string; target: string; kind?: "core" | "assoc" };

const HUBS: Record<string, string> = {
  memory: "Memory",
  conversations: "Conversations",
  files: "Files",
  apps: "Programs",
  mail: "Mail",
  web: "Web",
  skills: "Skills",
  code: "Code",
};

const SKIP_DIRS = /^(\$|system volume information$|windows$|program files|programdata$|recovery$|perflogs$|config\.msi$|msocache$|boot$|documents and settings$|onedrivetemp$)/i;

function subdirs(dir: string, limit: number): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.test(e.name) && !e.name.startsWith("."))
      .slice(0, limit)
      .map((e) => win.join(dir, e.name));
  } catch {
    return [];
  }
}

const keywords = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !["user", "sir's", "their", "with", "that", "this", "from", "have", "likes"].includes(w)),
  );

export async function buildBrain() {
  const nodes = new Map<string, BrainNode>();
  const links: BrainLink[] = [];
  const linkKeys = new Set<string>();

  const node = (n: BrainNode) => {
    const existing = nodes.get(n.id);
    if (existing) existing.val = Math.max(existing.val, n.val);
    else nodes.set(n.id, n);
  };
  const link = (source: string, target: string, kind?: BrainLink["kind"]) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const key = source < target ? `${source}|${target}` : `${target}|${source}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push({ source, target, kind });
  };

  node({ id: "sunday", label: "SUNDAY", group: "core", val: 40 });
  for (const [id, label] of Object.entries(HUBS)) {
    node({ id: `hub:${id}`, label, group: "hub", val: 14 });
    link("sunday", `hub:${id}`, "core");
  }

  // Skills — every tool is a neuron wired to Skills and to the domain it serves.
  for (const t of [...TOOL_CATALOG, { name: "web_search", hub: "web" }]) {
    node({ id: `skill:${t.name}`, label: t.name.replace(/_/g, " "), group: "skill", val: 3 });
    link("hub:skills", `skill:${t.name}`);
    link(`skill:${t.name}`, `hub:${t.hub}`);
  }

  // Installed expert guides hang off Skills.
  for (const s of listSkills()) {
    const id = `guide:${s.name.toLowerCase()}`;
    node({ id, label: s.name, group: "skill", val: 2, detail: s.description });
    link("hub:skills", id);
  }

  // Memory: categories → memories, cross-wired by shared ideas.
  for (const c of MEMORY_CATEGORIES) {
    node({ id: `cat:${c}`, label: c, group: "category", val: 6 });
    link("hub:memory", `cat:${c}`);
  }
  const memories = db()
    .prepare("SELECT id, content, category, importance, conversation_id, uses FROM memories ORDER BY id DESC LIMIT 400")
    .all() as { id: number; content: string; category: string; importance: number; conversation_id: string | null; uses: number }[];
  for (const m of memories) {
    node({
      id: `mem:${m.id}`,
      label: m.content.length > 48 ? m.content.slice(0, 46) + "…" : m.content,
      group: "memory",
      val: 1.5 + m.importance * 0.8 + Math.min(m.uses, 10) * 0.2,
      detail: m.content,
    });
    link(`cat:${m.category}`, `mem:${m.id}`);
  }
  const kw = memories.map((m) => ({ id: `mem:${m.id}`, words: keywords(m.content) }));
  for (let i = 0; i < kw.length; i++) {
    let made = 0;
    for (let j = i + 1; j < kw.length && made < 3; j++) {
      let shared = 0;
      for (const w of kw[i].words) if (kw[j].words.has(w)) shared++;
      if (shared >= 1 && (shared >= 2 || kw[i].words.size <= 4)) {
        link(kw[i].id, kw[j].id, "assoc");
        made++;
      }
    }
  }

  // Conversations form a timeline strand; memories hang off the talk they came from.
  const convos = db()
    .prepare(
      `SELECT c.id, c.title, c.updated_at, COUNT(m.id) n FROM conversations c
       JOIN messages m ON m.conversation_id = c.id GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 80`,
    )
    .all() as { id: string; title: string | null; updated_at: number; n: number }[];
  let prev: string | null = null;
  for (const c of convos) {
    const id = `conv:${c.id}`;
    node({
      id,
      label: c.title ?? new Date(c.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      group: "conversation",
      val: 2 + Math.min(c.n, 40) * 0.12,
      detail: `${c.n} messages · ${new Date(c.updated_at).toLocaleString("en-GB")}`,
    });
    link("hub:conversations", id);
    if (prev) link(prev, id, "assoc");
    prev = id;
  }
  for (const m of memories) if (m.conversation_id) link(`mem:${m.id}`, `conv:${m.conversation_id}`, "assoc");

  // Drives → top-level folders; home → known folders → their subfolders.
  for (const root of driveRoots()) {
    const id = `dir:${root.toLowerCase()}`;
    node({ id, label: `${root.slice(0, 2)} drive`, group: "drive", val: 10, detail: root });
    link("hub:files", id);
    for (const sub of subdirs(root, 28)) {
      node({ id: `dir:${sub.toLowerCase()}`, label: win.basename(sub), group: "folder", val: 2.2, detail: sub });
      link(id, `dir:${sub.toLowerCase()}`);
    }
  }
  const known = knownFolders();
  const homeId = `dir:${known.Home.toLowerCase()}`;
  node({ id: homeId, label: "Home", group: "folder", val: 6, detail: known.Home });
  link(`dir:${win.parse(known.Home).root.toLowerCase()}`, homeId);
  link("hub:files", homeId);
  for (const [name, p] of Object.entries(known)) {
    if (name === "Home") continue;
    const id = `dir:${p.toLowerCase()}`;
    node({ id, label: name, group: "folder", val: 4.5, detail: p });
    link(homeId, id);
    for (const sub of subdirs(p, 10)) {
      node({ id: `dir:${sub.toLowerCase()}`, label: win.basename(sub), group: "folder", val: 1.6, detail: sub });
      link(id, `dir:${sub.toLowerCase()}`);
    }
  }

  // What SUNDAY has actually done grows the brain.
  const activity = db()
    .prepare("SELECT kind, label, detail, COUNT(*) n FROM activity GROUP BY kind, label ORDER BY MAX(id) DESC LIMIT 300")
    .all() as { kind: string; label: string; detail: string | null; n: number }[];
  for (const a of activity) {
    if ((a.kind === "folder" || a.kind === "move") && a.detail) {
      const id = `dir:${a.detail.toLowerCase()}`;
      node({ id, label: win.basename(a.detail) || a.detail, group: "folder", val: 2.5 + Math.min(a.n, 10) * 0.3, detail: a.detail });
      const parent = `dir:${win.dirname(a.detail).toLowerCase()}`;
      if (nodes.has(parent)) link(parent, id);
      else link(`dir:${win.parse(a.detail).root.toLowerCase()}`, id);
    } else if (a.kind === "app") {
      const id = `app:${a.label.toLowerCase()}`;
      node({ id, label: a.label, group: "app", val: 3 + Math.min(a.n, 20) * 0.35, detail: `Opened ${a.n}×` });
      link("hub:apps", id);
    } else if (a.kind === "web" && a.label) {
      const id = `web:${a.label}`;
      node({ id, label: a.label, group: "web", val: 2 + Math.min(a.n, 20) * 0.25, detail: `Visited ${a.n}×` });
      link("hub:web", id);
    } else if (a.kind === "code" && a.detail) {
      const id = `code:${a.detail.toLowerCase()}`;
      node({ id, label: a.label, group: "code", val: 2.4 + Math.min(a.n, 15) * 0.3, detail: a.detail });
      link("hub:code", id);
    } else if (a.kind === "draft") {
      const id = `mail:${a.label}`;
      node({ id, label: a.label, group: "mail", val: 2.5, detail: `Draft to ${a.detail ?? "?"}` });
      link("hub:mail", id);
    }
  }

  for (const ws of vscodeWorkspaces().open) {
    const id = `code:${ws.toLowerCase()}`;
    node({ id, label: win.basename(ws) || ws, group: "code", val: 5, detail: `VS Code workspace · ${ws}` });
    link("hub:code", id);
  }

  // The installed-program constellation.
  const apps = await startApps();
  for (const a of apps.slice(0, 90)) {
    const id = `app:${a.Name.toLowerCase()}`;
    node({ id, label: a.Name, group: "app", val: 1.4 });
    link("hub:apps", id);
  }

  return { nodes: [...nodes.values()], links };
}

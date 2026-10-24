import "server-only";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { HOME } from "./config";

/**
 * The skills sir installed for Claude Code, made available to SUNDAY: she sees
 * each skill's name and description, and loads the full guide only when a task
 * calls for it (the same progressive loading Claude Code uses).
 */

/** Personality skills would fight SUNDAY's own character. */
const EXCLUDED = new Set(
  (process.env.SUNDAY_SKILLS_EXCLUDE ?? "tony-stark")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

type Skill = { name: string; description: string; dir: string; source: string };

function skillDirs(): { dir: string; source: string }[] {
  const roots: { root: string; source: string }[] = [
    // Read at runtime only — keep Turbopack from tracing (and choking on) skill folders at build time.
    { root: path.join(/* turbopackIgnore: true */ process.cwd(), ".claude", "skills"), source: "project" },
    { root: path.join(HOME, ".claude", "skills"), source: "user" },
    { root: path.join(HOME, ".agents", "skills"), source: "user" },
  ];
  const marketplaces = path.join(HOME, ".claude", "plugins", "marketplaces");
  if (existsSync(marketplaces)) {
    for (const m of safeList(marketplaces)) roots.push({ root: path.join(marketplaces, m, "skills"), source: `plugin:${m}` });
  }
  const out: { dir: string; source: string }[] = [];
  for (const { root, source } of roots) {
    for (const name of safeList(root)) {
      const dir = path.join(root, name);
      if (existsSync(path.join(dir, "SKILL.md"))) out.push({ dir, source });
    }
  }
  return out;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Minimal frontmatter reader: `name:` and `description:` (inline or folded `>` / `|` block). */
function frontmatter(text: string): { name?: string; description?: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: text };
  const lines = m[1].split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(" ");
    }
    fields[kv[1]] = value.replace(/^["']|["']$/g, "");
  }
  return { name: fields.name, description: fields.description, body: m[2] };
}

let cache: { at: number; skills: Skill[] } | null = null;

export function listSkills(): Skill[] {
  if (cache && Date.now() - cache.at < 60_000) return cache.skills;
  const seen = new Set<string>();
  const skills: Skill[] = [];
  for (const { dir, source } of skillDirs()) {
    try {
      const fm = frontmatter(readFileSync(path.join(dir, "SKILL.md"), "utf8"));
      const name = (fm.name ?? path.basename(dir)).trim();
      const key = name.toLowerCase();
      if (EXCLUDED.has(key) || seen.has(key)) continue;
      seen.add(key);
      skills.push({ name, description: (fm.description ?? "").slice(0, 400), dir, source });
    } catch {}
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), skills };
  return skills;
}

const MAX_SKILL_TEXT = 60_000;

function filesIn(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || out.length >= 60) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) filesIn(full, base, out);
    else if (/\.(md|txt|json|ya?ml|ts|js|py|sh|css|html)$/i.test(e.name)) out.push(path.relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}

/** Load a skill's guide, or one of its reference files. */
export function loadSkill(name: string, file?: string) {
  const skill = listSkills().find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!skill) {
    return { error: `No skill called "${name}". Available: ${listSkills().map((s) => s.name).join(", ")}` };
  }
  let target = path.join(skill.dir, "SKILL.md");
  if (file) {
    target = path.resolve(skill.dir, file);
    // Only files inside that skill's own folder.
    if (path.relative(skill.dir, target).startsWith("..") || path.isAbsolute(path.relative(skill.dir, target))) {
      return { error: "That file is outside the skill's folder." };
    }
    if (!existsSync(target) || !statSync(target).isFile()) return { error: `${file} isn't in the ${skill.name} skill.` };
  }
  let text = readFileSync(target, "utf8");
  if (!file) text = frontmatter(text).body;
  return {
    skill: skill.name,
    file: file ?? "SKILL.md",
    content: text.length > MAX_SKILL_TEXT ? text.slice(0, MAX_SKILL_TEXT) + "\n…(truncated)" : text,
    otherFiles: filesIn(skill.dir).filter((f) => f !== "SKILL.md"),
  };
}

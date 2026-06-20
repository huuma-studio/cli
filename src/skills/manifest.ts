/**
 * Owns `.agents/skills/.manifest.json`.
 *
 * Records each installed skill's source, content hash, and install time so a
 * future `huuma skills update` can detect drift, and so collisions and local
 * edits can be detected on re-add. No network.
 *
 * See docs/adr/0001-huuma-skills-add.md §"Fingerprinting — content hash".
 */
import { join, relative } from "@std/path";
import type { Source } from "./path.ts";

export interface ManifestEntry {
  source: Source;
  contentHash: string; // "sha256-<hex>"
  installedAt: string; // ISO 8601
}

export interface Manifest {
  skills: Record<string, ManifestEntry>;
}

const MANIFEST_FILENAME = ".manifest.json";

/** Returns the manifest path inside a skills dir. */
export function manifestPath(skillsDir: string): string {
  return join(skillsDir, MANIFEST_FILENAME);
}

/** Reads the manifest. Returns `{ skills: {} }` when the file is missing or
 * unparseable (treats unparseable as empty rather than crashing; logs a
 * `yellow` warning when unparseable). */
export async function readManifest(skillsDir: string): Promise<Manifest> {
  const path = manifestPath(skillsDir);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return { skills: {} };
  }
  try {
    const parsed = JSON.parse(text) as Manifest;
    if (
      parsed && typeof parsed === "object" &&
      parsed.skills && typeof parsed.skills === "object"
    ) {
      return parsed;
    }
    return { skills: {} };
  } catch {
    // Unparseable — treat as empty but warn (best-effort, no import cycle with
    // terminal.ts to keep this module dependency-free for unit testing).
    console.warn(`Warning: '${path}' is unparseable; treating as empty.`);
    return { skills: {} };
  }
}

/** Writes the manifest atomically: write to `.manifest.json.tmp` then rename. */
export async function writeManifest(
  skillsDir: string,
  m: Manifest,
): Promise<void> {
  const path = manifestPath(skillsDir);
  const tmp = `${path}.tmp`;
  await Deno.mkdir(skillsDir, { recursive: true });
  await Deno.writeTextFile(tmp, JSON.stringify(m, null, 2) + "\n");
  await Deno.rename(tmp, path);
}

/** Walks the skill tree, sorts relative paths, and feeds `path \0 bytes` into
 * SHA-256. Returns `"sha256-<hex>"`. The manifest file lives at the skills
 * root (not inside a skill dir), so it is never included in the hash. */
export async function contentHashOf(skillDir: string): Promise<string> {
  const entries: { path: string; bytes: Uint8Array }[] = [];
  await walk(skillDir, skillDir, entries);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const encoder = new TextEncoder();
  // Use the global crypto.subtle for hashing. Size the buffer in UTF-8 bytes:
  // e.path.length is the UTF-16 code-unit count, which underestimates paths
  // containing multibyte chars (e.g. `résumé.md`, CJK filenames) and would
  // cause `buf.set(p, off)` to throw RangeError on write.
  const encodedPaths = entries.map((e) => encoder.encode(e.path));
  let total = 0;
  for (let i = 0; i < entries.length; i++) {
    total += encodedPaths[i].length + 1 + entries[i].bytes.byteLength;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const p = encodedPaths[i];
    buf.set(p, off);
    off += p.length;
    buf[off] = 0; // NUL separator
    off += 1;
    buf.set(e.bytes, off);
    off += e.bytes.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256-${hex}`;
}

async function walk(
  root: string,
  current: string,
  out: { path: string; bytes: Uint8Array }[],
): Promise<void> {
  let dir: Deno.DirEntry[];
  try {
    dir = [];
    for await (const entry of Deno.readDir(current)) dir.push(entry);
  } catch {
    return;
  }
  for (const entry of dir) {
    const full = join(current, entry.name);
    if (entry.isDirectory) {
      await walk(root, full, out);
    } else if (entry.isFile) {
      const rel = relative(root, full).replace(/\\/g, "/");
      const bytes = await Deno.readFile(full);
      out.push({ path: rel, bytes });
    }
  }
}

/** Pure: compares `source` against `m.skills[name].source`. Same `owner`/`repo`
 * means `"same-source"` (ref/subpath differences are still `"same-source"`).
 * Returns `"none"` when the name isn't in the manifest. */
export function findCollision(
  m: Manifest,
  name: string,
  source: Source,
): "none" | "same-source" | "different-source" {
  const existing = m.skills[name];
  if (!existing) return "none";
  if (
    existing.source.owner === source.owner &&
    existing.source.repo === source.repo
  ) {
    return "same-source";
  }
  return "different-source";
}

/** Re-hashes the on-disk skill tree at `<skillsDir>/<name>/` and compares it
 * to `m.skills[name].contentHash`. Returns `false` when the skill isn't in the
 * manifest or has no on-disk dir. This is the only disk-touching collision
 * helper; `findCollision` is pure and unit-testable without fixtures. */
export async function detectLocalEdits(
  m: Manifest,
  name: string,
  skillsDir: string,
): Promise<boolean> {
  const existing = m.skills[name];
  if (!existing) return false;
  const skillDir = join(skillsDir, name);
  try {
    await Deno.stat(skillDir);
  } catch {
    return false;
  }
  const hash = await contentHashOf(skillDir);
  return hash !== existing.contentHash;
}

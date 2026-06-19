/**
 * Tarball extraction with safety guards.
 *
 * Pure module operating on a `ReadableStream<Uint8Array>` (the gzip-decompressed
 * tarball bytes). The network lives in `fetch.ts`; this module just walks the
 * tar and writes files to `destDir`.
 *
 * Guards (see docs/adr/0001-huuma-skills-add.md §"Tarball safety guards"):
 * 1. Path-traversal reject — any entry escaping `destDir` aborts the install.
 * 2. Symlinks skipped — not recreated on disk.
 * 3. Size cap — total and per-file byte caps to defuse tar-bomb repos.
 *
 * Does NOT check for `SKILL.md` presence — `validate.ts` owns that.
 */
import { type TarStreamEntry, UntarStream } from "@std/tar/untar-stream";
import { dirname, relative, resolve } from "@std/path";

/** Tunable size caps. Exported so tests can shrink them. */
export const SIZE_CAP = {
  totalBytes: 50 * 1024 * 1024,
  perFileBytes: 10 * 1024 * 1024,
};

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

export interface ExtractOptions {
  tarball: ReadableStream<Uint8Array>;
  subpath: string[];
  destDir: string;
  sizeCap?: { totalBytes: number; perFileBytes: number };
}

/** Strips the tarball's top dir segment and the requested `subpath` prefix
 * from `entryPath`, returning the remainder (relative to the skill dir) or
 * `null` when the entry is not under the top dir / subpath.
 *
 * Examples (subpath = ["skills", "mcp-builder"]):
 *   "repo-main/skills/mcp-builder/SKILL.md"  -> "SKILL.md"
 *   "repo-main/skills/mcp-builder/scripts/x.sh" -> "scripts/x.sh"
 *   "repo-main/skills/mcp-builder"            -> "" (the dir entry itself)
 *   "repo-main/skills/other/SKILL.md"         -> null (sibling, filtered out)
 *   "repo-main/README.md"                     -> null (subpath=[] keeps this) */
function stripAndFilter(
  entryPath: string,
  subpath: string[],
): string | null {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\.?\//, "");
  const slash = normalized.indexOf("/");
  if (slash === -1) return null; // the top-dir entry itself
  const rest = normalized.slice(slash + 1);
  if (rest.length === 0) return null;
  if (subpath.length === 0) return rest;
  const sub = subpath.join("/");
  const prefix = sub + "/";
  if (rest === sub) return ""; // the subpath dir entry itself
  if (rest.startsWith(prefix)) return rest.slice(prefix.length);
  return null;
}

/** Returns true when `target` is the header typeflag for a symbolic link. */
function isSymlink(entry: TarStreamEntry): boolean {
  const header = entry.header as { typeflag?: string };
  return header.typeflag === "2" || header.typeflag === "1" /* hardlink */;
}

function isDirectory(entry: TarStreamEntry): boolean {
  const header = entry.header as { typeflag?: string };
  return header.typeflag === "5" || entry.path.endsWith("/");
}

/** Extracts a skill tarball into `destDir`, applying the three safety guards.
 * Throws `ExtractError` on any guard violation. */
export async function extractSkill(opts: ExtractOptions): Promise<void> {
  const { tarball, subpath, destDir } = opts;
  const cap = opts.sizeCap ?? SIZE_CAP;
  const destAbs = resolve(destDir);

  let totalBytes = 0;

  const stream = tarball.pipeThrough(new UntarStream());
  for await (const entry of stream) {
    const rel = stripAndFilter(entry.path, subpath);
    if (rel === null) {
      // UntarStream won't resolve the next entry until this one's readable is
      // consumed or cancelled, so cancel before skipping.
      await entry.readable?.cancel();
      continue;
    }

    // Symlink guard: skip silently (do not recreate on disk).
    if (isSymlink(entry)) {
      await entry.readable?.cancel();
      continue;
    }

    // Path-traversal guard: resolved path must stay under destAbs.
    const target = resolve(destAbs, rel);
    const relToDest = relative(destAbs, target);
    if (relToDest.startsWith("..") || relToDest.includes("../")) {
      throw new ExtractError(
        `Refusing to extract entry outside the install directory: '${entry.path}'`,
      );
    }
    if (
      relToDest !== "" && !target.startsWith(destAbs + "/") &&
      target !== destAbs
    ) {
      throw new ExtractError(
        `Refusing to extract entry outside the install directory: '${entry.path}'`,
      );
    }

    if (isDirectory(entry)) {
      await Deno.mkdir(target, { recursive: true });
      continue;
    }

    // Per-file size cap, checked against the declared entry size.
    const header = entry.header as { size?: number };
    const declaredSize = header.size ?? 0;
    if (declaredSize > cap.perFileBytes) {
      throw new ExtractError(
        `File '${rel}' is ${declaredSize} bytes, exceeding the per-file cap of ${cap.perFileBytes} bytes.`,
      );
    }
    if (totalBytes + declaredSize > cap.totalBytes) {
      throw new ExtractError(
        `Extracting '${rel}' would exceed the total size cap of ${cap.totalBytes} bytes.`,
      );
    }

    if (entry.readable === undefined) continue;
    await Deno.mkdir(dirname(target), { recursive: true });
    const file = await Deno.open(target, {
      create: true,
      write: true,
      truncate: true,
    });
    try {
      let written = 0;
      for await (const chunk of entry.readable) {
        written += chunk.byteLength;
        if (written > cap.perFileBytes) {
          throw new ExtractError(
            `File '${rel}' exceeded the per-file cap of ${cap.perFileBytes} bytes while streaming.`,
          );
        }
        if (totalBytes + written > cap.totalBytes) {
          throw new ExtractError(
            `Extracting '${rel}' exceeded the total size cap of ${cap.totalBytes} bytes while streaming.`,
          );
        }
        await file.write(chunk);
      }
      totalBytes += written;
    } finally {
      file.close();
    }
  }

  // Ensure destDir exists even for empty extractions.
  await Deno.mkdir(destAbs, { recursive: true });
}

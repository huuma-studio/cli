/**
 * Path grammar for `huuma skills add --path=<github-url>`.
 *
 * Accepted form (see docs/adr/0001-huuma-skills-add.md):
 *
 *   https://github.com/<owner>/<repo>/tree/<ref>[/<subpath>]
 *
 * `<ref>` is a single path segment (no `/`); branch names with slashes are
 * rejected to avoid URL ambiguity. Shorthand, `blob/`, `.git` suffixes,
 * non-`https`, and non-`github.com` hosts are rejected.
 */

/** Sub-shape reused by `ManifestEntry.source`. `Source` and `ParsedPath` are
 * structurally identical here; `Source` exists so `manifest.ts` imports a
 * domain name rather than the path-parser's type. */
export interface Source {
  owner: string;
  repo: string;
  ref: string;
  subpath: string[];
}

export interface ParsedPath extends Source {}

export class PathParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathParseError";
  }
}

const GITHUB_HOST = "github.com";

/** Parses a GitHub tree URL into its `owner/repo/ref/subpath` parts. Throws
 * `PathParseError` with a helpful message on any rejection. */
export function parsePath(input: string): ParsedPath {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PathParseError(
      `'${input}' is not a valid URL. Expected https://github.com/<owner>/<repo>/tree/<ref>[/<subpath>]`,
    );
  }

  if (url.protocol !== "https:") {
    throw new PathParseError(
      `Only https URLs are accepted (got '${url.protocol}//'). Use https://github.com/...`,
    );
  }
  if (url.host !== GITHUB_HOST) {
    throw new PathParseError(
      `Only github.com is supported in v1 (got '${url.host}').`,
    );
  }
  if (url.hash || url.search) {
    throw new PathParseError(
      `URL must not include a query string or fragment ('${input}').`,
    );
  }

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  // Expected: <owner> <repo> "tree" <ref> [subpath...]
  if (segments.length < 4 || segments[2] !== "tree") {
    if (segments.length >= 3 && segments[2] === "blob") {
      throw new PathParseError(
        `'blob/' URLs are not accepted. Use the 'tree/<ref>' form: https://github.com/<owner>/<repo>/tree/<ref>[/<subpath>]`,
      );
    }
    throw new PathParseError(
      `URL must contain 'tree/<ref>' (got '${input}'). Expected https://github.com/<owner>/<repo>/tree/<ref>[/<subpath>]`,
    );
  }

  const [owner, repo, , ref, ...subpath] = segments;
  if (!owner || !repo || !ref) {
    throw new PathParseError(
      `URL is missing owner, repo, or ref (got '${input}').`,
    );
  }
  if (ref.includes("/") || /%2[fF]/.test(ref)) {
    throw new PathParseError(
      `Ref '${ref}' contains a slash. Slash-containing branch names (e.g. 'feature/foo') are rejected in v1 — use a tag or a top-level branch, or pin a commit SHA. URL: '${input}'`,
    );
  }
  if (repo.endsWith(".git")) {
    throw new PathParseError(
      `Drop the '.git' suffix from the repo name ('${repo}'). URL: '${input}'`,
    );
  }
  if (subpath.some((s) => s.length === 0)) {
    throw new PathParseError(
      `Subpath contains an empty segment ('${input}').`,
    );
  }

  return { owner, repo, ref, subpath };
}

/** `"<owner>/<repo>@<ref>"` for display. */
export function formatSource(p: Source): string {
  return `${p.owner}/${p.repo}@${p.ref}`;
}

/** `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>` — the tarball
 * URL the fetch module downloads. */
export function codeloadUrl(p: Source): string {
  return `https://codeload.github.com/${p.owner}/${p.repo}/tar.gz/${p.ref}`;
}

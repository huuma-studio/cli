import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  codeloadUrl,
  formatSource,
  parsePath,
  PathParseError,
} from "./path.ts";

Deno.test("parses the ADR example with a subpath", () => {
  const p = parsePath(
    "https://github.com/anthropics/skills/tree/main/skills/mcp-builder",
  );
  assertEquals(p, {
    owner: "anthropics",
    repo: "skills",
    ref: "main",
    subpath: ["skills", "mcp-builder"],
  });
});

Deno.test("parses the deep-subpath ADR example", () => {
  const p = parsePath(
    "https://github.com/mattpocock/skills/tree/main/skills/engineering/codebase-design",
  );
  assertEquals(p, {
    owner: "mattpocock",
    repo: "skills",
    ref: "main",
    subpath: ["skills", "engineering", "codebase-design"],
  });
});

Deno.test("parses repo-root skill (no subpath)", () => {
  const p = parsePath("https://github.com/owner/repo/tree/main");
  assertEquals(p, { owner: "owner", repo: "repo", ref: "main", subpath: [] });
});

Deno.test("formatSource renders owner/repo@ref", () => {
  const p = parsePath(
    "https://github.com/anthropics/skills/tree/main/skills/mcp-builder",
  );
  assertEquals(formatSource(p), "anthropics/skills@main");
});

Deno.test("codeloadUrl renders the codeload tarball URL", () => {
  const p = parsePath(
    "https://github.com/anthropics/skills/tree/main/skills/mcp-builder",
  );
  assertEquals(
    codeloadUrl(p),
    "https://codeload.github.com/anthropics/skills/tar.gz/main",
  );
});

Deno.test("rejects shorthand owner/repo", () => {
  const err = assertThrows(
    () => parsePath("anthropics/skills"),
    PathParseError,
  );
  assertStringIncludes(err.message, "not a valid URL");
});

Deno.test("rejects slash-containing ref with the hint", () => {
  // A literal '/' can't appear inside a single URL path segment, so the
  // slash-in-ref guard fires on encoded slashes (%2F) — the only way a user
  // can attempt to pin a slash-containing branch through the grammar.
  const err = assertThrows(
    () =>
      parsePath(
        "https://github.com/anthropics/skills/tree/feature%2Ffoo/skills/bar",
      ),
    PathParseError,
  );
  assertStringIncludes(err.message, "slash");
});

Deno.test("tree/feature/foo/skills/bar parses as ref=feature (grammar is segment-based)", () => {
  // The ADR notes this URL 'cannot be split unambiguously' — but a URL path
  // segment can never contain a literal '/', so the grammar always takes the
  // first segment after `tree/` as the ref. Slash-containing branch names are
  // therefore *unrepresentable* rather than rejected here; users must pin a
  // tag or top-level branch. See docs/adr/0001-huuma-skills-add.md.
  const p = parsePath(
    "https://github.com/anthropics/skills/tree/feature/foo/skills/bar",
  );
  assertEquals(p.ref, "feature");
  assertEquals(p.subpath, ["foo", "skills", "bar"]);
});

Deno.test("rejects blob/ URLs", () => {
  const err = assertThrows(
    () =>
      parsePath(
        "https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md",
      ),
    PathParseError,
  );
  assertStringIncludes(err.message, "blob/");
});

Deno.test("rejects http://", () => {
  const err = assertThrows(
    () => parsePath("http://github.com/anthropics/skills/tree/main"),
    PathParseError,
  );
  assertStringIncludes(err.message, "https");
});

Deno.test("rejects non-github host", () => {
  const err = assertThrows(
    () => parsePath("https://gitlab.com/anthropics/skills/tree/main"),
    PathParseError,
  );
  assertStringIncludes(err.message, "github.com");
});

Deno.test("rejects .git suffix", () => {
  const err = assertThrows(
    () => parsePath("https://github.com/anthropics/skills.git/tree/main"),
    PathParseError,
  );
  assertStringIncludes(err.message, ".git");
});

Deno.test("rejects bare repo URL without tree/<ref>", () => {
  const err = assertThrows(
    () => parsePath("https://github.com/anthropics/skills"),
    PathParseError,
  );
  assertStringIncludes(err.message, "tree/<ref>");
});

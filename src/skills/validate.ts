/**
 * SKILL.md validation against the Agent Skills spec.
 *
 * Pure module. Input: the extracted skill dir on disk. Output: either ok (with
 * a list of optional warnings) or a typed `ValidationError`.
 *
 * See docs/adr/0001-huuma-skills-add.md §"Skill validation — at install time,
 * two-tier". `SKILL.md` existence is checked here only (not in `extract.ts`).
 */
import { extract } from "@std/front-matter/yaml";
import { basename } from "@std/path";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Validated frontmatter (the fields we care about). */
export interface SkillFrontMatter {
  name: string;
  description: string;
  // Optional spec-defined fields (warn, don't reject, when malformed):
  license?: unknown;
  compatibility?: unknown;
  metadata?: Record<string, unknown>;
  "allowed-tools"?: unknown;
  [key: string]: unknown;
}

export interface ValidationResult {
  name: string;
  warnings: string[];
}

/** Reads `SKILL.md` and returns the frontmatter `name` after validating the
 * regex/length invariants only. Used by the orchestrator to name the staging
 * dir before the full `validateSkill` run (which also checks the
 * name-≡-dir-basename invariant). Throws `ValidationError` on a missing or
 * malformed name. */
export async function readSkillName(skillDir: string): Promise<string> {
  const skillMd = `${skillDir}/SKILL.md`;
  let text: string;
  try {
    text = await Deno.readTextFile(skillMd);
  } catch {
    throw new ValidationError(
      `SKILL.md not found at the skill directory root: '${skillMd}'`,
    );
  }
  let attrs: Record<string, unknown>;
  try {
    attrs = (extract<SkillFrontMatter>(text).attrs ?? {}) as Record<
      string,
      unknown
    >;
  } catch (cause) {
    throw new ValidationError(
      `SKILL.md frontmatter could not be parsed as YAML: ${
        (cause as Error)?.message ?? cause
      }`,
    );
  }
  const name = attrs.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 64) {
    throw new ValidationError(
      `SKILL.md 'name' must be 1–64 chars (got ${
        typeof name === "string" ? name.length : "non-string"
      })`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ValidationError(
      `SKILL.md 'name' must match ^[a-z0-9]+(-[a-z0-9]+)*$ (got '${name}')`,
    );
  }
  return name;
}

/** Validates the skill directory's `SKILL.md`. Rejects hard on the four
 * mandatory invariants; collects (but does not throw on) optional-field
 * violations, returning them as `warnings`. */
export async function validateSkill(
  skillDir: string,
): Promise<ValidationResult> {
  const skillMd = `${skillDir}/SKILL.md`;
  let text: string;
  try {
    text = await Deno.readTextFile(skillMd);
  } catch {
    throw new ValidationError(
      `SKILL.md not found at the skill directory root: '${skillMd}'`,
    );
  }

  let attrs: Record<string, unknown>;
  try {
    const parsed = extract<SkillFrontMatter>(text);
    attrs = (parsed.attrs ?? {}) as Record<string, unknown>;
  } catch (cause) {
    throw new ValidationError(
      `SKILL.md frontmatter could not be parsed as YAML: ${
        (cause as Error)?.message ?? cause
      }`,
    );
  }

  const name = attrs.name;
  const description = attrs.description;

  // Mandatory invariant 2: name regex + length.
  if (typeof name !== "string" || name.length < 1 || name.length > 64) {
    throw new ValidationError(
      `SKILL.md 'name' must be 1–64 chars (got ${
        typeof name === "string" ? name.length : "non-string"
      })`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ValidationError(
      `SKILL.md 'name' must match ^[a-z0-9]+(-[a-z0-9]+)*$ (got '${name}')`,
    );
  }

  // Mandatory invariant 3: name == skill dir basename.
  const dirName = basename(skillDir);
  if (dirName !== name) {
    throw new ValidationError(
      `SKILL.md 'name' ('${name}') must match the skill directory basename ('${dirName}')`,
    );
  }

  // Mandatory invariant 4: description present, 1–1024 chars.
  if (
    typeof description !== "string" ||
    description.length < 1 ||
    description.length > 1024
  ) {
    throw new ValidationError(
      `SKILL.md 'description' must be 1–1024 chars (got ${
        typeof description === "string" ? description.length : "non-string"
      })`,
    );
  }

  // Optional-field warnings (collected, not thrown).
  const warnings: string[] = [];

  if ("compatibility" in attrs && attrs.compatibility !== undefined) {
    if (typeof attrs.compatibility !== "string") {
      warnings.push(
        `'compatibility' should be a string (got ${typeof attrs
          .compatibility})`,
      );
    } else if (attrs.compatibility.length > 500) {
      warnings.push(
        `'compatibility' is ${attrs.compatibility.length} chars (>500); consider trimming.`,
      );
    }
  }

  if ("license" in attrs && attrs.license !== undefined) {
    if (typeof attrs.license !== "string") {
      warnings.push(
        `'license' should be a string (got ${typeof attrs.license})`,
      );
    } else if (attrs.license.length > 500) {
      warnings.push(`'license' is ${attrs.license.length} chars (>500)`);
    }
  }

  if ("metadata" in attrs && attrs.metadata !== undefined) {
    if (
      typeof attrs.metadata !== "object" || attrs.metadata === null ||
      Array.isArray(attrs.metadata)
    ) {
      warnings.push(
        `'metadata' should be an object (got ${typeof attrs.metadata})`,
      );
    } else {
      for (
        const [key, value] of Object.entries(
          attrs.metadata as Record<string, unknown>,
        )
      ) {
        if (typeof value !== "string") {
          warnings.push(
            `'metadata.${key}' should be a string (got ${typeof value})`,
          );
        }
      }
    }
  }

  if ("allowed-tools" in attrs && attrs["allowed-tools"] !== undefined) {
    const tools = attrs["allowed-tools"];
    if (!Array.isArray(tools)) {
      warnings.push(`'allowed-tools' should be an array (got ${typeof tools})`);
    } else {
      for (const t of tools) {
        if (typeof t !== "string") {
          warnings.push(
            `'allowed-tools' entries should be strings (got ${typeof t})`,
          );
          break;
        }
      }
    }
  }

  return { name, warnings };
}

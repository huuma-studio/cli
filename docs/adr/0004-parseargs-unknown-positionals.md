# parseArgs `unknown` callback fires for positionals — pre-scan flags instead

Status: accepted

`huuma skills update` is the first CLI subcommand in this repo that takes
positional arguments (`NAMES...`). `huuma skills add` — the template every
subcommand was cloned from — takes only flags (`--path`, `--force`), so it
uses `@std/cli`'s `parseArgs` with an `unknown: (arg) => { throw ... }`
callback to reject unrecognised flags. That pattern breaks the moment a
subcommand accepts positionals.

## Context

`@std/cli` `parseArgs` (jsr `@std/cli@1.0.30`, the version pinned in
`deno.json`) invokes the `unknown` callback for **every** argument it cannot
match to a declared option — including bare positionals. Reproduction:

```ts
parseArgs(["nonexistent"], {
  boolean: ["force", "help"],
  alias: { help: "h" },
  default: { force: false, help: false },
  unknown: (a) => { throw new Error("Unknown option: " + a); },
});
// => throws "Unknown option: nonexistent"
```

So `huuma skills update nonexistent` was rejected as an unknown option before
it ever reached the manifest lookup that should report `✖ nonexistent: not
tracked; nothing to update`.

This is a `@std/cli` behaviour (minimist-derived), not a bug we can fix
upstream from here. It is version-sensitive: a future `@std/cli` release that
changes `unknown`'s contract would alter the workaround. The pinned range is
`^1.0.30`, so any `1.x` upgrade should be re-verified against this ADR.

## Decision

Subcommands that accept positionals must **not** rely on the `unknown`
callback for flag validation. Instead, pre-scan the raw `args` array against
an explicit known-flag set before calling `parseArgs`, then call `parseArgs`
**without** an `unknown` callback:

```ts
const KNOWN_FLAGS = new Set(["--force", "--help", "-h"]);
for (const a of args) {
  if (a === "--") break;              // rest are positionals
  if (a === "-" || !a.startsWith("-")) continue; // positional NAME
  const base = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
  if (!KNOWN_FLAGS.has(base)) {
    err(red(`✖ Unknown option: ${a}`));
    err(updateHelp());
    Deno.exitCode = 1;
    return "";
  }
}
const parsed = parseArgs(args, {
  boolean: ["force", "help"],
  alias: { help: "h" },
  default: { force: false, help: false },
});
```

Dropping the `unknown` callback is required for correctness, not just style:
without it, `parseArgs` silently swallows an unrecognised `--flag` by
consuming the **next** token as its value (`parseArgs(["--bogus", "foo"])`
yields `{ bogus: "foo" }`), so a stray flag would eat a positional and
produce a confusing "not tracked" failure rather than a clean "Unknown
option" rejection. The pre-scan catches `--bogus` before that can happen.

`--force=value` forms are tolerated by the `base` extraction (the known-flag
check uses the token up to `=`), and `parseArgs` then parses the value as
usual. `--` ends option parsing; everything after it is positional, matching
`parseArgs`' own semantics.

## Consequences

- **Flag-only subcommands** (the `add` shape: `--path`, `--force`, no
  positionals) can keep using the `unknown` callback — there are no
  positionals to misfire on. `add.ts` is left unchanged.
- **Positional-taking subcommands** (`update`, and any future `remove`,
  `list`, `repair`) must use the pre-scan pattern. Copying `add.ts`'s
  `unknown`-callback pattern into a positional subcommand reintroduces the
  bug; this ADR is the record that prevents that.
- The known-flag set is per-subcommand and must be updated whenever a new
  flag is added to a positional subcommand. The cost is small (one `Set`)
  and keeps error messages consistent with `add`'s `✖ Unknown option:` form.

## Alternatives considered

- **`stopEarly` / `--`-only parsing.** Rejects the ergonomic "flags anywhere"
  form (`update mcp-builder --force`) and is a larger behaviour change than
  the bug warrants.
- **Hand-rolled arg parser.** Rejected — `parseArgs` already handles `--flag`,
  `--flag=value`, aliases, and `--`; the pre-scan only adds the unknown-flag
  guard `parseArgs` can't provide alongside positionals.
- **Pinning a different `@std/cli` version.** No released version on the
  `1.x` line changes this `unknown`-for-positionals contract, and the bug is
  upstream behaviour, not a regression to work around with a downgrade.

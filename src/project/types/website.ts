import { join } from "@std/path";
import { create as createFile } from "../file.ts";
import { create as createDir } from "../directory.ts";
import { latest } from "../version.ts";
import { confirm } from "../../input.ts";
import { green, red, yellow } from "../../terminal.ts";
import { parsePath } from "../../skills/path.ts";
import {
  type BundleOptions,
  type BundleResult,
  BundleValidationError,
  installBundle,
} from "../../skills/bundle.ts";

const modules = ["@huuma/route", "@huuma/ui"] as const;

export async function denoConfigContent(tailwind: boolean): Promise<string> {
  const routeVersion = await latest(modules[0], "^0.2");
  const uiVersion = await latest(modules[1], "^0.2");

  // Tailwind needs its own deps (the `tailwindcss()` helper lives in
  // `@huuma/theme`) and `nodeModulesDir: "auto"` so `@tailwindcss/cli` can
  // resolve `@import "tailwindcss"` from a materialized `node_modules`.
  const tailwindImports = tailwind
    ? `
    "@huuma/theme": "jsr:@huuma/theme@^${await latest("@huuma/theme", "^0.2")}",
    "tailwindcss": "npm:tailwindcss@^4",
    "@tailwindcss/cli": "npm:@tailwindcss/cli@^4",`
    : "";
  const nodeModulesDir = tailwind
    ? `
  "nodeModulesDir": "auto",`
    : "";

  return `{
  "imports": {
    "${modules[0]}": "jsr:${modules[0]}@^${routeVersion}",
    "${modules[1]}": "jsr:${modules[1]}@^${uiVersion}",${tailwindImports}
    "@/": "./src/",
    "@app/": "./app/",
    "@manifest/": "./.huuma/"
  },${nodeModulesDir}
  "lint": {
    "plugins": ["jsr:@huuma/ui/lint"]
  },
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "@huuma/ui",
    "lib": ["dom", "dom.iterable", "dom.asynciterable", "deno.ns"]
  },
  "tasks": {
    "dev": "deno -ERWN --allow-run --watch dev.ts",
    "bundle": "deno -ERWN --allow-run dev.ts --bundle",
    "start": "deno -ERN app.ts"
  }
}`;
}

export default async (projectName: string) => {
  const addZedSettings = await confirm("Add .zed/settings.json for Deno?");
  const addVscodeSettings = await confirm(
    "Add .vscode/settings.json for Deno?",
  );
  const addTailwind = await confirm("Add Tailwind CSS?");

  await createDir(join(projectName, "src"));
  await createDir(join(projectName, "static"));
  await createDir(join(projectName, "app"));
  await denoConfig(projectName, addTailwind);
  await rootTs(projectName, addTailwind);
  await appTs(projectName, addTailwind);
  await indexPage(projectName);

  if (addTailwind) {
    await tailwindStyles(projectName);
  }

  if (addZedSettings) {
    await zedSettings(projectName);
  }

  if (addVscodeSettings) {
    await vscodeSettings(projectName);
  }

  const addSkillsBundle = await confirm("Add skills bundle from @huuma/ui?");
  if (addSkillsBundle) {
    const outcome = await installBundleForWebsite(projectName);
    // Skip the empty/installed messaging when the bundle failed — the helper
    // already printed a red `✖` for the failure. Only the success path owns
    // the yellow "no skills found" / green "installed" messaging.
    if (!outcome.failed) {
      if (outcome.members.length === 0) {
        console.log(
          yellow("  ⚠ No skills found in @huuma/ui's skills/ directory."),
        );
      } else {
        console.log(
          green("✓") +
            ` Installed ${outcome.members.length} skill${
              outcome.members.length === 1 ? "" : "s"
            } from @huuma/ui:`,
        );
        for (const m of outcome.members) {
          console.log(`    ${m.name}`);
          for (const w of m.warnings) console.log(yellow("    ⚠ " + w));
        }
      }
    }
  }

  return "Website application created!";
};

/** Seam type for `installBundleForWebsite`'s optional bundle injection. Mirrors
 * `installBundle`'s signature so tests can stub the network-bound call. */
export type BundleFn = (opts: BundleOptions) => Promise<BundleResult>;

/** Outcome of a website bundle install. `failed` distinguishes a genuine empty
 * source (`members: []`, `failed: false`) from an install failure
 * (`members: []`, `failed: true`) so the caller doesn't print a misleading
 * "No skills found" message after a network error. */
export interface WebsiteBundleOutcome {
  members: BundleResult["members"];
  failed: boolean;
}

/** Installs the @huuma/ui skill bundle into the scaffolded project. The bundle
 * is non-fatal: on any failure (network, validation, atomicity abort) the
 * helper logs a red error, sets `Deno.exitCode = 1`, and returns
 * `{ members: [], failed: true }` — the scaffold itself still succeeds. Skills
 * are an enhancement, not a project requirement (see the ADR's "Failure
 * severity" section). On success returns `{ members, failed: false }`.
 *
 * The optional `bundle` seam is for unit-testing (inject a stub that returns a
 * fixed `BundleResult` or throws). The default export calls this with no
 * seam, using the real `installBundle`. Mirrors `add.ts`'s `AddDeps` pattern. */
export async function installBundleForWebsite(
  projectName: string,
  bundle: BundleFn = installBundle,
): Promise<WebsiteBundleOutcome> {
  // Hard-coded ref `main` — huuma-studio/ui publishes no git tags. parsePath
  // is inside the try/catch so the non-fatal contract holds even if the URL
  // ever becomes dynamic (e.g. a future --skills-ref flag) and starts throwing.
  try {
    const parsed = parsePath(
      "https://github.com/huuma-studio/ui/tree/main/skills",
    );
    const result = await bundle({ parsed, cwd: projectName, log: console.log });
    return { members: result.members, failed: false };
  } catch (cause) {
    const message = cause instanceof BundleValidationError
      ? cause.message
      : (cause as Error)?.message ?? String(cause);
    console.error(red(`✖ ${message}`));
    Deno.exitCode = 1;
    return { members: [], failed: true };
  }
}

export function rootTsContent(tailwind: boolean): string {
  // `loadStaticFiles` serves `static/styles.css` at `/styles.css`, where the
  // `tailwindcss()` helper writes its compiled output.
  const stylesheet = tailwind
    ? `\n          <link rel="stylesheet" href="/styles.css" />`
    : "";

  return `import { createUIApp, Launch, Scripts, Meta } from "@huuma/ui/server";
import { loadStaticFiles } from "@huuma/route/http/tasks/static-files";

const app = createUIApp(
  ({ children, scripts, islands, metadata, transferState }) => {
    return (
      <html lang="en">
        <head>
          <Meta metadata={metadata} />
          <Scripts nonce={scripts?.nonce} scripts={scripts?.head} />
          <title>Hello Huuma</title>${stylesheet}
        </head>
        <body>
          {children}
          <Scripts nonce={scripts?.nonce} scripts={scripts?.body} />
          <Launch
            nonce={scripts?.nonce}
            body={scripts?.body}
            islands={islands}
            transferState={transferState}
          />
        </body>
      </html>
    );
  },
);

// Apply additional tasks or middleware here.
await loadStaticFiles(app);

export default app;

`;
}

async function rootTs(projectName: string, tailwind: boolean) {
  await createFile(
    join(projectName, "app", "root.tsx"),
    rootTsContent(tailwind),
  );
}

const appTsContent = `import { pack } from "@huuma/ui/server/pack";
import app from "@app/root.tsx";
import List from "@manifest/list.ts";

await pack(app, List);
Deno.serve(app.deliver());
`;

export function devTsContent(tailwind: boolean): string {
  // `await tailwindcss()` compiles `src/styles.css` → `static/styles.css` on
  // each dev/bundle run (both run `dev.ts` with `--allow-run`).
  const tailwindImport = tailwind
    ? `import { tailwindcss } from "@huuma/theme/tailwind";\n`
    : "";
  const tailwindCall = tailwind ? `await tailwindcss();\n\n` : "";

  return `${tailwindImport}import { prepare } from "@huuma/ui/server/pack/list";
import app from "@app/root.tsx";

${tailwindCall}const handler = (await prepare(app))?.deliver();
if (handler) Deno.serve(handler);
`;
}

async function appTs(projectName: string, tailwind: boolean) {
  await createFile(join(projectName, "app.ts"), appTsContent);
  await createFile(join(projectName, "dev.ts"), devTsContent(tailwind));
}

const indexPageContent = `export default () => {
  return (
    <>
      <main>
        <h2>Hello Huuma</h2>
      </main>
    </>
  );
};
`;
async function indexPage(projectName: string) {
  await createFile(join(projectName, "app", "page.tsx"), indexPageContent);
}

// Tailwind entrypoint. `@tailwindcss/cli` reads this and emits the compiled
// stylesheet listed below.
const stylesCssContent = `@import "tailwindcss";
`;
// Placeholder so `loadStaticFiles` registers the `/styles.css` route on the
// first `deno task dev`; `tailwindcss()` overwrites it with the compiled output.
const compiledStylesContent = `/* Generated by tailwindcss(); do not edit. */
`;
async function tailwindStyles(projectName: string) {
  await createFile(join(projectName, "src", "styles.css"), stylesCssContent);
  await createFile(
    join(projectName, "static", "styles.css"),
    compiledStylesContent,
  );
}

async function denoConfig(projectName: string, tailwind: boolean) {
  await createFile(
    join(projectName, "deno.json"),
    await denoConfigContent(tailwind),
  );
}

const zedSettingsContent = `{
  "lsp": {
    "deno": {
      "settings": {
        "deno": {
          "enable": true
        }
      }
    }
  },
  "languages": {
    "JavaScript": {
      "language_servers": [
        "deno",
        "!typescript-language-server",
        "!vtsls",
        "!eslint",
        "..."
      ],
      "formatter": "language_server"
    },
    "TypeScript": {
      "language_servers": [
        "deno",
        "!typescript-language-server",
        "!vtsls",
        "!eslint",
        "..."
      ],
      "formatter": "language_server"
    },
    "TSX": {
      "language_servers": [
        "deno",
        "!typescript-language-server",
        "!vtsls",
        "!eslint",
        "..."
      ],
      "formatter": "language_server"
    }
  }
}
`;

async function zedSettings(projectName: string) {
  await createDir(join(projectName, ".zed"));
  await createFile(
    join(projectName, ".zed", "settings.json"),
    zedSettingsContent,
  );
}

const vscodeSettingsContent = `{
  "deno.enable": true,
  "deno.lint": true,
  "editor.defaultFormatter": "denoland.vscode-deno",
  "[typescript]": {
    "editor.defaultFormatter": "denoland.vscode-deno"
  },
  "[typescriptreact]": {
    "editor.defaultFormatter": "denoland.vscode-deno"
  },
  "[javascript]": {
    "editor.defaultFormatter": "denoland.vscode-deno"
  },
  "[javascriptreact]": {
    "editor.defaultFormatter": "denoland.vscode-deno"
  },
  "[json]": {
    "editor.defaultFormatter": "denoland.vscode-deno"
  }
}
`;

async function vscodeSettings(projectName: string) {
  await createDir(join(projectName, ".vscode"));
  await createFile(
    join(projectName, ".vscode", "settings.json"),
    vscodeSettingsContent,
  );
}

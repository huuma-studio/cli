import { join } from "@std/path";
import { create as createFile } from "../file.ts";
import { create as createDir } from "../directory.ts";
import { latest, latestNpm, latestUI03 } from "../version.ts";
import { choose, confirm } from "../../input.ts";
import { green, red, yellow } from "../../terminal.ts";
import { parsePath } from "../../skills/path.ts";
import {
  type BundleOptions,
  type BundleResult,
  BundleValidationError,
  installBundle,
} from "../../skills/bundle.ts";

export const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;
export type PackageManager = typeof PACKAGE_MANAGERS[number];

export interface WebsiteOptions {
  tailwind?: boolean;
  skills?: boolean;
  packageManager?: PackageManager;
  install?: boolean;
}

export type InstallFn = (
  packageManager: PackageManager,
  cwd: string,
) => Promise<{ success: boolean; code: number }>;

export interface WebsiteDeps {
  fetch?: typeof fetch;
  install?: InstallFn;
}

/** Explicit flags bypass prompts; piped/agent invocations default to pnpm. */
export async function resolvePackageManager(
  value?: PackageManager,
  isTerminal = Deno.stdin.isTerminal(),
  select = choose,
): Promise<PackageManager> {
  if (value) return value;
  if (!isTerminal) return "pnpm";
  return await select(
    PACKAGE_MANAGERS.map((label) => ({
      label,
      description: label === "pnpm"
        ? "Recommended (10.9+)"
        : label === "yarn"
        ? "Requires Yarn 4.9+"
        : undefined,
    })),
    "Select a package manager:",
  ) as PackageManager;
}

async function resolveOption(
  value: boolean | undefined,
  prompt: string,
): Promise<boolean> {
  if (typeof value === "boolean") return value;
  if (!Deno.stdin.isTerminal()) return false;
  return await confirm(prompt);
}

export interface WebsiteVersions {
  route: string;
  ui: string;
  vitePlus: string;
}

export async function resolveVersions(
  fetcher: typeof fetch = fetch,
): Promise<WebsiteVersions> {
  const [route, ui, vitePlus] = await Promise.all([
    latest("@huuma/route", "0.3.1", fetcher),
    latestUI03(fetcher),
    latestNpm("vite-plus", "1.2.0", fetcher),
  ]);
  return { route, ui, vitePlus };
}

/** Vite+ replaces `vite` with its own core; every transitive `vite` must
 * resolve to it at the exact `vite-plus` version. */
const viteCore = (version: string) =>
  `npm:@voidzero-dev/vite-plus-core@${version}`;

const sorted = (record: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  );

/** JSON as oxfmt prints it: objects expanded, primitive arrays inline when
 * they fit, so a new project passes `vp check` before its first edit. */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /^( *)(".*": )?\[\n[^[\]{}]*?\n *\]/gm,
    (match, indent: string, key = "") => {
      const items = JSON.parse(match.slice(indent.length + key.length));
      const line = `${indent}${key}[${
        items.map((item: unknown) => JSON.stringify(item)).join(", ")
      }]`;
      return line.length < 100 ? line : match;
    },
  ) + "\n";
}

export function packageContent(
  tailwind: boolean,
  packageManager: PackageManager,
  versions: WebsiteVersions,
): string {
  const dependency = (name: string, version: string) =>
    packageManager === "pnpm" || packageManager === "yarn"
      ? `jsr:^${version}`
      : `npm:@jsr/huuma__${name}@^${version}`;
  const css = "tailwindcss -i src/styles.css -o public/styles.css";
  const vite = { vite: viteCore(versions.vitePlus) };
  return json({
    private: true,
    type: "module",
    scripts: {
      dev: tailwind
        ? `${css} && concurrently -k "${css} --watch" "vp dev"`
        : "vp dev",
      ...(tailwind ? { "dev:css": `${css} --watch` } : {}),
      build: tailwind ? `${css} && vp build` : "vp build",
      start: "node dist/server/server.js",
      check: "vp check",
      lint: "vp lint",
      fmt: "vp fmt",
    },
    dependencies: sorted({
      "@huuma/ui": dependency("ui", versions.ui),
      "@huuma/route": dependency("route", versions.route),
    }),
    devDependencies: sorted({
      ...vite,
      "vite-plus": versions.vitePlus,
      "@types/node": "^24",
      ...(tailwind
        ? {
          tailwindcss: "^4",
          "@tailwindcss/cli": "^4",
          concurrently: "^9",
        }
        : {}),
    }),
    // pnpm reads overrides from pnpm-workspace.yaml instead.
    ...(packageManager === "yarn" ? { resolutions: vite } : {}),
    ...(packageManager === "npm" || packageManager === "bun"
      ? { overrides: vite }
      : {}),
    engines: { node: "^24.11.0 || >=26.0.0" },
  });
}

export function pnpmWorkspaceContent(
  tailwind: boolean,
  versions: WebsiteVersions,
): string {
  // pnpm 11+ fails installation for unreviewed dependency builds. Tailwind
  // uses Parcel's native watcher; allow that package rather than all scripts.
  const builds = tailwind ? 'allowBuilds:\n  "@parcel/watcher": true\n' : "";
  // Third-party Vite plugins declare peers on `vite` versions that the
  // Vite+ core's own version numbers never satisfy. Unlike `vp create`, this
  // omits the equivalent `allowAny: [vite]` list: pnpm copies the indentation
  // of an existing YAML list when it appends minimumReleaseAgeExclude during
  // install, which `vp check` would then reject.
  return `${builds}overrides:
  vite: ${viteCore(versions.vitePlus)}
peerDependencyRules:
  allowedVersions:
    vite: "*"
`;
}

const install: InstallFn = (packageManager, cwd) =>
  new Deno.Command(packageManager, {
    args: ["install"],
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();

export default async (
  projectName: string,
  options: WebsiteOptions = {},
  deps: WebsiteDeps = {},
) => {
  const packageManager = await resolvePackageManager(options.packageManager);
  const addTailwind = await resolveOption(
    options.tailwind,
    "Add Tailwind CSS?",
  );

  for (const dir of ["src", "public", "app", ".vscode", ".zed"]) {
    await createDir(join(projectName, dir));
  }
  const versions = await resolveVersions(deps.fetch);
  const files: Record<string, string> = {
    "package.json": packageContent(addTailwind, packageManager, versions),
    "vite.config.ts": viteConfigContent,
    "server.ts": serverContent,
    "tsconfig.json": tsConfigContent,
    // The Tailwind CLI writes public/styles.css on every dev and build run.
    ".gitignore": "node_modules/\ndist/\n" +
      (addTailwind ? "public/styles.css\n" : ""),
    ".vscode/extensions.json": vscodeExtensionsContent,
    ".vscode/settings.json": vscodeSettingsContent,
    ".zed/settings.json": zedSettingsContent,
    "app/root.tsx": rootTsContent(addTailwind),
    "app/page.tsx": indexPageContent,
    "app/counter.client.tsx": counterContent,
  };
  if (packageManager === "npm" || packageManager === "bun") {
    files[".npmrc"] = "@jsr:registry=https://npm.jsr.io\n";
  }
  if (addTailwind) files["src/styles.css"] = '@import "tailwindcss";\n';
  if (packageManager === "pnpm") {
    files["pnpm-workspace.yaml"] = pnpmWorkspaceContent(addTailwind, versions);
  }
  for (const [path, content] of Object.entries(files)) {
    await createFile(join(projectName, path), content);
  }

  if (
    await resolveOption(options.skills, "Add skills bundle from @huuma/ui?")
  ) {
    const outcome = await installBundleForWebsite(projectName);
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

  let installed = false;
  if (options.install) {
    try {
      const result = await (deps.install ?? install)(
        packageManager,
        projectName,
      );
      if (!result.success) throw new Error(`exit code ${result.code}`);
      installed = true;
    } catch (cause) {
      console.error(
        red(
          `✖ Dependency installation failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      );
      Deno.exitCode = 1;
    }
  }
  const run = packageManager === "pnpm" || packageManager === "yarn"
    ? ""
    : "run ";
  const quotedName = "'" + projectName.replaceAll("'", "'\\''") + "'";
  console.log(`\nNext steps:\n  cd ${quotedName}`);
  if (!installed) console.log(`  ${packageManager} install`);
  console.log(`  ${packageManager} ${run}dev`);

  return "Website application created!";
};

export type BundleFn = (opts: BundleOptions) => Promise<BundleResult>;

export interface WebsiteBundleOutcome {
  members: BundleResult["members"];
  failed: boolean;
}

/** Skills are optional: a bundle failure preserves the generated project and
 * reports a partial failure through the exit code (ADR 0002). */
export async function installBundleForWebsite(
  projectName: string,
  bundle: BundleFn = installBundle,
): Promise<WebsiteBundleOutcome> {
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

const viteConfigContent = `import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { huuma } from "@huuma/ui/vite";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [huuma()],
  fmt: {},
  lint: {
    options: { typeAware: true, typeCheck: true },
    jsPlugins: ["@huuma/ui/lint", { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "huuma/async-remote-functions": "error",
      "huuma/no-async-hook-calling": "error",
      "huuma/no-async-client-jsx": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
});
`;

const serverContent = `import { createUIApp } from "@huuma/ui/server";
import Root from "./app/root.tsx";

// Apply additional tasks or middleware to the app here.
export default createUIApp(Root);
`;

const tsConfigContent = json({
  compilerOptions: {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    jsxImportSource: "@huuma/ui",
    types: ["vite/client", "node"],
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    paths: { "@/*": ["./src/*"] },
  },
  include: ["app", "src", "server.ts", "vite.config.ts"],
});

// Editor settings match what `vp create` writes, so the Oxc language server
// lints and formats through the project's `vite-plus` and its vite.config.ts.
const vscodeExtensionsContent = json({
  recommendations: ["VoidZero.vite-plus-extension-pack"],
});

const vscodeSettingsContent = json({
  "npm.scriptRunner": "vp",
  "editor.defaultFormatter": "oxc.oxc-vscode",
  ...Object.fromEntries(
    ["javascript", "javascriptreact", "typescript", "typescriptreact"].map((
      language,
    ) => [`[${language}]`, { "editor.defaultFormatter": "oxc.oxc-vscode" }]),
  ),
  "oxc.disableNestedConfig": true,
  "oxc.fmt.disableNestedConfig": true,
  "editor.formatOnSave": true,
  "editor.formatOnSaveMode": "file",
  "editor.codeActionsOnSave": { "source.fixAll.oxc": "explicit" },
});

const zedFormattedLanguages = [
  "CSS",
  "GraphQL",
  "Handlebars",
  "HTML",
  "JavaScript",
  "JSX",
  "JSON",
  "JSON5",
  "JSONC",
  "Less",
  "Markdown",
  "MDX",
  "SCSS",
  "TypeScript",
  "TSX",
  "Vue.js",
  "YAML",
];

const zedSettingsContent = json({
  lsp: {
    oxlint: {
      initialization_options: {
        settings: {
          run: "onType",
          fixKind: "safe_fix",
          typeAware: true,
          unusedDisableDirectives: "deny",
        },
      },
    },
    oxfmt: {
      initialization_options: {
        settings: { "fmt.configPath": "./vite.config.ts", run: "onSave" },
      },
    },
  },
  languages: Object.fromEntries(
    zedFormattedLanguages.map((language) => [language, {
      format_on_save: "on",
      prettier: { allowed: false },
      formatter: [
        { language_server: { name: "oxfmt" } },
        ...(language === "JavaScript"
          ? [{ code_action: "source.fixAll.oxc" }]
          : []),
      ],
    }]),
  ),
});

export function rootTsContent(tailwind: boolean): string {
  const stylesheet = tailwind
    ? '\n        <link rel="stylesheet" href="/styles.css" />'
    : "";
  return `import { Launch, Meta, type RootPageProps, Scripts } from "@huuma/ui/server";

export default function Root({
  children,
  scripts,
  islands,
  metadata,
  transferState,
}: RootPageProps<unknown>) {
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
}
`;
}

const indexPageContent = `import Counter from "./counter.client.tsx";

export default function HomePage() {
  return (
    <main>
      <h2 class="text-3xl font-bold">Hello Huuma</h2>
      <Counter />
    </main>
  );
}
`;

const counterContent = `import { $signal } from "@huuma/ui/hooks/signal";

export default function Counter() {
  const count = $signal(0);
  return <button on-click={() => count.set(count.get() + 1)}>Count: {count}</button>;
}
`;

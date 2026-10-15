import { join } from "@std/path";
import { create as createFile } from "../file.ts";
import { create as createDir } from "../directory.ts";
import { latest, latestUI03 } from "../version.ts";
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

export async function packageContent(
  tailwind: boolean,
  packageManager: PackageManager,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const [routeVersion, uiVersion] = await Promise.all([
    latest("@huuma/route", "0.3.1", fetcher),
    latestUI03(fetcher),
  ]);
  const dependency = (name: string, version: string) =>
    packageManager === "pnpm" || packageManager === "yarn"
      ? `jsr:^${version}`
      : `npm:@jsr/huuma__${name}@^${version}`;
  const css = "tailwindcss -i src/styles.css -o public/styles.css";
  return JSON.stringify(
    {
      private: true,
      type: "module",
      engines: { node: ">=24" },
      scripts: {
        dev: tailwind
          ? `${css} && concurrently -k "${css} --watch" "vite"`
          : "vite",
        ...(tailwind ? { "dev:css": `${css} --watch` } : {}),
        build: tailwind ? `${css} && vite build` : "vite build",
        start: "node dist/server/server.js",
        lint: "oxlint",
      },
      dependencies: {
        "@huuma/ui": dependency("ui", uiVersion),
        "@huuma/route": dependency("route", routeVersion),
      },
      devDependencies: {
        vite: "^8",
        oxlint: "^1",
        ...(tailwind
          ? {
            tailwindcss: "^4",
            "@tailwindcss/cli": "^4",
            concurrently: "^9",
          }
          : {}),
      },
    },
    null,
    2,
  ) + "\n";
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

  for (const dir of ["src", "public", "app"]) {
    await createDir(join(projectName, dir));
  }
  const files: Record<string, string> = {
    "package.json": await packageContent(
      addTailwind,
      packageManager,
      deps.fetch,
    ),
    "vite.config.ts": viteConfigContent,
    "server.ts": serverContent,
    "tsconfig.json": tsConfigContent,
    ".oxlintrc.json": lintConfigContent,
    ".gitignore": "node_modules/\ndist/\n",
    "app/root.tsx": rootTsContent(addTailwind),
    "app/page.tsx": indexPageContent,
    "app/counter.client.tsx": counterContent,
  };
  if (packageManager === "npm" || packageManager === "bun") {
    files[".npmrc"] = "@jsr:registry=https://npm.jsr.io\n";
  }
  if (addTailwind) files["src/styles.css"] = '@import "tailwindcss";\n';
  if (addTailwind && packageManager === "pnpm") {
    // pnpm 11+ fails installation for unreviewed dependency builds. Tailwind
    // uses Parcel's native watcher; allow that package rather than all scripts.
    files["pnpm-workspace.yaml"] = 'allowBuilds:\n  "@parcel/watcher": true\n';
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
import { defineConfig } from "vite";
import { huuma } from "@huuma/ui/vite";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [huuma()],
});
`;

const serverContent = `import { createUIApp } from "@huuma/ui/server";
import Root from "./app/root.tsx";

// Apply additional tasks or middleware to the app here.
export default createUIApp(Root);
`;

const tsConfigContent = JSON.stringify(
  {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      jsxImportSource: "@huuma/ui",
      types: ["vite/client"],
      allowImportingTsExtensions: true,
      noEmit: true,
      strict: true,
      paths: { "@/*": ["./src/*"] },
    },
    include: ["app", "src", "server.ts", "vite.config.ts"],
  },
  null,
  2,
) + "\n";

const lintConfigContent = JSON.stringify(
  {
    jsPlugins: ["@huuma/ui/lint"],
    rules: {
      "huuma/async-remote-functions": "error",
      "huuma/no-async-hook-calling": "error",
      "huuma/no-async-client-jsx": "error",
    },
  },
  null,
  2,
) + "\n";

export function rootTsContent(tailwind: boolean): string {
  const stylesheet = tailwind
    ? '\n        <link rel="stylesheet" href="/styles.css" />'
    : "";
  return `import { Launch, Meta, type RootPageProps, Scripts } from "@huuma/ui/server";

export default function Root({
  children, scripts, islands, metadata, transferState,
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

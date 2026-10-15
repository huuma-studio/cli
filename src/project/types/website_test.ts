import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import website, {
  type BundleFn,
  installBundleForWebsite,
  json,
  PACKAGE_MANAGERS,
  packageContent,
  resolvePackageManager,
  resolveVersions,
  rootTsContent,
  type WebsiteDeps,
  type WebsiteOptions,
} from "./website.ts";
import { BundleValidationError } from "../../skills/bundle.ts";

const fetchMetadata: typeof fetch = (input) =>
  Promise.resolve(Response.json(
    String(input).includes("registry.npmjs.org")
      ? { versions: { "1.2.0": {}, "1.3.0": {}, "2.0.0": {} } }
      : String(input).includes("/ui/")
      ? { latest: "0.2.11", versions: { "0.3.0-beta.2": { yanked: false } } }
      : { latest: "0.3.1" },
  ));

const core = "npm:@voidzero-dev/vite-plus-core@1.3.0";

async function scaffold(
  options: WebsiteOptions,
  inspect: (
    dir: string,
    logs: string[],
    errors: string[],
  ) => void | Promise<void>,
  deps: WebsiteDeps = {},
) {
  const dir = await Deno.makeTempDir({ prefix: "huuma website " });
  const originalLog = console.log;
  const originalError = console.error;
  const exitCode = Deno.exitCode;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  Deno.exitCode = 0;
  try {
    assertEquals(
      await website(dir, { tailwind: false, skills: false, ...options }, {
        fetch: fetchMetadata,
        ...deps,
      }),
      "Website application created!",
    );
    await inspect(dir, logs, errors);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    Deno.exitCode = exitCode;
    await Deno.remove(dir, { recursive: true });
  }
}

async function paths(dir: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(join(dir, prefix))) {
    const path = prefix + entry.name;
    result.push(path + (entry.isDirectory ? "/" : ""));
    if (entry.isDirectory) result.push(...await paths(dir, path + "/"));
  }
  return result.sort();
}

Deno.test("website writes the Vite+ 0.3 scaffold, aliases, lint rules and island", async () => {
  await scaffold({}, async (dir) => {
    assertEquals(
      await paths(dir),
      [
        ".gitignore",
        ".vscode/",
        ".vscode/extensions.json",
        ".vscode/settings.json",
        ".zed/",
        ".zed/settings.json",
        "app/",
        "app/counter.client.tsx",
        "app/page.tsx",
        "app/root.tsx",
        "package.json",
        "pnpm-workspace.yaml",
        "public/",
        "server.ts",
        "src/",
        "tsconfig.json",
        "vite.config.ts",
      ].sort(),
    );
    const read = (name: string) => Deno.readTextFile(join(dir, name));
    const pkg = JSON.parse(await read("package.json"));
    assertEquals(pkg.type, "module");
    assertEquals(pkg.engines.node, "^24.11.0 || >=26.0.0");
    assertEquals(pkg.dependencies["@huuma/ui"], "jsr:^0.3.0-beta.2");
    assertEquals(pkg.dependencies["@huuma/route"], "jsr:^0.3.1");
    assertEquals(pkg.scripts, {
      dev: "vp dev",
      build: "vp build",
      start: "node dist/server/server.js",
      check: "vp check",
      lint: "vp lint",
      fmt: "vp fmt",
    });
    assertEquals(pkg.devDependencies, {
      "@types/node": "^24",
      vite: core,
      "vite-plus": "1.3.0",
    });
    const config = await read("vite.config.ts");
    assertStringIncludes(config, 'import { defineConfig } from "vite-plus";');
    assertStringIncludes(config, "plugins: [huuma()]");
    assertStringIncludes(
      config,
      'fileURLToPath(new URL("./src", import.meta.url))',
    );
    const tsconfig = JSON.parse(await read("tsconfig.json"));
    assertEquals(tsconfig.compilerOptions.paths, { "@/*": ["./src/*"] });
    assertEquals(tsconfig.compilerOptions.types, ["vite/client", "node"]);
    assertStringIncludes(config, 'jsPlugins: ["@huuma/ui/lint", {');
    for (
      const rule of [
        "async-remote-functions",
        "no-async-hook-calling",
        "no-async-client-jsx",
      ]
    ) assertStringIncludes(config, `"huuma/${rule}": "error"`);
    assertStringIncludes(
      await read("server.ts"),
      "export default createUIApp(Root)",
    );
    assertStringIncludes(await read("app/page.tsx"), "<Counter />");
    assertStringIncludes(
      await read("app/counter.client.tsx"),
      "count.set(count.get() + 1)",
    );
    assertEquals(await read(".gitignore"), "node_modules/\ndist/\n");
    assertEquals(Deno.exitCode, 0);
  });
});

Deno.test("website configures the Oxc language server for VS Code and Zed", async () => {
  await scaffold({}, async (dir) => {
    const read = async (name: string) =>
      JSON.parse(await Deno.readTextFile(join(dir, name)));
    assertEquals(await read(".vscode/extensions.json"), {
      recommendations: ["VoidZero.vite-plus-extension-pack"],
    });
    const vscode = await read(".vscode/settings.json");
    assertEquals(vscode["npm.scriptRunner"], "vp");
    assertEquals(vscode["editor.defaultFormatter"], "oxc.oxc-vscode");
    assertEquals(vscode["[typescriptreact]"], {
      "editor.defaultFormatter": "oxc.oxc-vscode",
    });
    assertEquals(vscode["editor.codeActionsOnSave"], {
      "source.fixAll.oxc": "explicit",
    });
    const zed = await read(".zed/settings.json");
    assertEquals(
      zed.lsp.oxfmt.initialization_options.settings["fmt.configPath"],
      "./vite.config.ts",
    );
    assertEquals(
      zed.lsp.oxlint.initialization_options.settings.typeAware,
      true,
    );
    assertEquals(zed.languages.TSX, {
      format_on_save: "on",
      prettier: { allowed: false },
      formatter: [{ language_server: { name: "oxfmt" } }],
    });
    assertEquals(zed.languages.JavaScript.formatter[1], {
      code_action: "source.fixAll.oxc",
    });
  });
});

Deno.test("json collapses primitive arrays only when they fit oxfmt's width", () => {
  const long = Array.from({ length: 12 }, (_, i) => `entry-${i}`);
  assertEquals(
    json({ short: ["a", 1, true], long, nested: [{ a: 1 }], empty: [] }),
    `{
  "short": ["a", 1, true],
  "long": [
${long.map((item) => `    "${item}"`).join(",\n")}
  ],
  "nested": [
    {
      "a": 1
    }
  ],
  "empty": []
}
`,
  );
});

for (const pm of PACKAGE_MANAGERS) {
  Deno.test(`${pm} writes the correct dependency forms, registry and next steps`, async () => {
    await scaffold({ packageManager: pm }, async (dir, logs) => {
      const pkg = JSON.parse(
        await Deno.readTextFile(join(dir, "package.json")),
      );
      const native = pm === "pnpm" || pm === "yarn";
      assertEquals(
        pkg.dependencies["@huuma/ui"],
        native ? "jsr:^0.3.0-beta.2" : "npm:@jsr/huuma__ui@^0.3.0-beta.2",
      );
      assertEquals(
        pkg.dependencies["@huuma/route"],
        native ? "jsr:^0.3.1" : "npm:@jsr/huuma__route@^0.3.1",
      );
      assertEquals((await paths(dir)).includes(".npmrc"), !native);
      assertEquals(
        (await paths(dir)).includes("pnpm-workspace.yaml"),
        pm === "pnpm",
      );
      // Every package manager must resolve transitive `vite` to the Vite+ core.
      if (pm === "pnpm") {
        assertStringIncludes(
          await Deno.readTextFile(join(dir, "pnpm-workspace.yaml")),
          `overrides:\n  vite: ${core}\n`,
        );
      }
      assertEquals(pkg.resolutions, pm === "yarn" ? { vite: core } : undefined);
      assertEquals(
        pkg.overrides,
        pm === "npm" || pm === "bun" ? { vite: core } : undefined,
      );
      if (!native) {
        assertEquals(
          await Deno.readTextFile(join(dir, ".npmrc")),
          "@jsr:registry=https://npm.jsr.io\n",
        );
      }
      assertStringIncludes(logs.join("\n"), `${pm} install`);
      assertStringIncludes(logs.join("\n"), `${pm} ${native ? "" : "run "}dev`);
    });
  });
}

Deno.test("package manager prompts only when omitted in a terminal", async () => {
  let prompts = 0;
  const select: Parameters<typeof resolvePackageManager>[2] = (
    choices,
    prompt,
  ) => {
    prompts++;
    assertEquals(typeof choices[0], "object");
    assertStringIncludes(JSON.stringify(choices[0]), "pnpm");
    assertStringIncludes(JSON.stringify(choices[0]), "Recommended");
    assertStringIncludes(prompt!, "package manager");
    return Promise.resolve("npm");
  };
  assertEquals(await resolvePackageManager(undefined, false, select), "pnpm");
  assertEquals(await resolvePackageManager("bun", true, select), "bun");
  assertEquals(prompts, 0);
  assertEquals(await resolvePackageManager(undefined, true, select), "npm");
  assertEquals(prompts, 1);
});

Deno.test("root keeps metadata, both script positions and nonce on Launch", () => {
  const content = rootTsContent(false);
  assertStringIncludes(content, "<Meta metadata={metadata} />");
  assertStringIncludes(
    content,
    "<Scripts nonce={scripts?.nonce} scripts={scripts?.head} />",
  );
  assertStringIncludes(
    content,
    "<Scripts nonce={scripts?.nonce} scripts={scripts?.body} />",
  );
  assertStringIncludes(content, "<Launch\n          nonce={scripts?.nonce}");
  assertEquals(content.includes("loadStaticFiles"), false);
  assertEquals(content.includes("styles.css"), false);
});

Deno.test("Tailwind adds the entry, watch/build scripts and stylesheet link", async () => {
  await scaffold({ tailwind: true }, async (dir) => {
    const pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
    assertEquals(pkg.devDependencies.tailwindcss, "^4");
    assertEquals(pkg.devDependencies["@tailwindcss/cli"], "^4");
    assertStringIncludes(pkg.scripts.dev, "concurrently -k");
    assertStringIncludes(
      pkg.scripts["dev:css"],
      "-o public/styles.css --watch",
    );
    assertStringIncludes(pkg.scripts.dev, '"vp dev"');
    assertStringIncludes(
      pkg.scripts.build,
      "-o public/styles.css && vp build",
    );
    assertEquals(
      await Deno.readTextFile(join(dir, ".gitignore")),
      "node_modules/\ndist/\npublic/styles.css\n",
    );
    assertEquals(
      await Deno.readTextFile(join(dir, "src/styles.css")),
      '@import "tailwindcss";\n',
    );
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "app/root.tsx")),
      '<link rel="stylesheet" href="/styles.css" />',
    );
    assertEquals((await paths(dir)).includes("static/"), false);
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "pnpm-workspace.yaml")),
      'allowBuilds:\n  "@parcel/watcher": true\n',
    );
  });
});

Deno.test("Tailwind off omits all its dependencies, styles and scripts", async () => {
  const pkg = packageContent(
    false,
    "pnpm",
    await resolveVersions(fetchMetadata),
  );
  assertEquals(pkg.includes("tailwind"), false);
  assertEquals(pkg.includes("concurrently"), false);
  assertEquals(pkg.includes("dev:css"), false);
});

Deno.test("install runs the chosen package manager in the project and skips manual install", async () => {
  let installedAt: string | undefined;
  await scaffold(
    { packageManager: "npm", install: true },
    (dir, logs) => {
      assertEquals(installedAt, dir);
      assertEquals(logs.join("\n").includes("npm install"), false);
      assertEquals(Deno.exitCode, 0);
    },
    {
      install: (pm, cwd) => {
        assertEquals(pm, "npm");
        installedAt = cwd;
        return Promise.resolve({ success: true, code: 0 });
      },
    },
  );
});

for (const fail of ["exit", "spawn"]) {
  Deno.test(`install ${fail} failure preserves the scaffold and prints recovery`, async () => {
    await scaffold(
      { packageManager: "pnpm", install: true },
      async (dir, logs, errors) => {
        assertEquals(Deno.exitCode, 1);
        assertStringIncludes(
          errors.join("\n"),
          "Dependency installation failed",
        );
        assertStringIncludes(logs.join("\n"), "pnpm install");
        assert((await paths(dir)).includes("server.ts"));
      },
      {
        install: () =>
          fail === "exit"
            ? Promise.resolve({ success: false, code: 7 })
            : Promise.reject(new Error("command not found")),
      },
    );
  });
}

Deno.test("install is opt-in and skills false does not fetch a bundle", async () => {
  await scaffold({}, async (dir) => {
    assertEquals(
      (await paths(dir)).some((path) => path.startsWith(".agents")),
      false,
    );
    assertEquals(Deno.exitCode, 0);
  }, {
    install: () => {
      throw new Error("must not install");
    },
  });
});

Deno.test("installBundleForWebsite propagates the result and uses ui main", async () => {
  const members = [{
    name: "mcp-builder",
    target: "/demo/.agents/skills/mcp-builder",
    warnings: [],
  }];
  const stub: BundleFn = (opts) => {
    assertEquals(opts.cwd, "demo");
    assertEquals(opts.parsed.ref, "main");
    return Promise.resolve({ members });
  };
  assertEquals(await installBundleForWebsite("demo", stub), {
    members,
    failed: false,
  });
});

Deno.test("installBundleForWebsite preserves its non-fatal error contract", async () => {
  const original = console.error;
  const exitCode = Deno.exitCode;
  const errors: string[] = [];
  console.error = (msg) => errors.push(String(msg));
  try {
    const result = await installBundleForWebsite(
      "demo",
      () => Promise.reject(new BundleValidationError("bad skill")),
    );
    assertEquals(result, { members: [], failed: true });
    assertEquals(Deno.exitCode, 1);
    assertStringIncludes(errors.join("\n"), "bad skill");
  } finally {
    console.error = original;
    Deno.exitCode = exitCode;
  }
});

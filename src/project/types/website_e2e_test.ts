/** Network-gated integration checks against the actual packages published to
 * JSR/npm. Run with HUUMA_SCAFFOLD_E2E=1 deno test -A src/project/types/website_e2e_test.ts */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { spawn } from "node:child_process";
import process from "node:process";
import project from "../project.ts";
import type { PackageManager } from "./website.ts";

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function server(
  cwd: string,
  production: boolean,
  tailwind: boolean,
  packageManager: PackageManager,
) {
  const port = freePort();
  if (!production) {
    const config = join(cwd, "vite.config.ts");
    await Deno.writeTextFile(
      config,
      (await Deno.readTextFile(config)).replace(
        "export default defineConfig({",
        `export default defineConfig({ server: { host: "127.0.0.1", port: ${port}, strictPort: true },`,
      ),
    );
  }
  const child = spawn(
    production ? "node" : packageManager,
    production ? ["dist/server/server.js"] : ["run", "dev"],
    {
      cwd,
      env: {
        ...Deno.env.toObject(),
        HOST: "127.0.0.1",
        PORT: String(port),
        ...(production ? { HUUMA_ENV: "PROD" } : {}),
      },
      detached: Deno.build.os !== "windows",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostics = "";
  const record = (chunk: Uint8Array) => {
    diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(
      -32_000,
    );
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  let startupError: Error | undefined;
  child.once("error", (error) => {
    startupError = error;
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve())
  );
  const url = `http://127.0.0.1:${port}`;
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(diagnostics);
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert(response, "server did not start");
    const html = await response.text();
    assertEquals(response.status, 200, html);
    assertStringIncludes(html, "Hello Huuma");
    assertStringIncludes(html, "Count:");
    assertStringIncludes(html, "nonce=");
    const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((
      m,
    ) => m[1]);
    // Production Launch loads its hashed runtime and islands through inline
    // module imports rather than script src attributes. Check those too.
    for (
      const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)
    ) {
      for (
        const imported of script[1].matchAll(
          /\b(?:from|import)\s*["']([^"']+)["']/g,
        )
      ) {
        sources.push(imported[1]);
      }
    }
    assert(
      sources.length > 0,
      "page must include browser scripts for the island",
    );
    for (const src of sources) {
      const script = await fetch(new URL(src, url));
      const body = await script.text();
      assertEquals(script.status, 200, body);
      assert(body.length > 0);
    }
    if (tailwind) {
      assertStringIncludes(html, 'href="/styles.css"');
      const css = await fetch(url + "/styles.css");
      const text = await css.text();
      assertEquals(css.status, 200, text);
      assertStringIncludes(text, ".text-3xl");
      if (!production) {
        assertEquals(text.includes(".text-red-500"), false);
        const page = join(cwd, "app/page.tsx");
        const original = await Deno.readTextFile(page);
        const edited = original.replace(
          "text-3xl font-bold",
          "text-3xl font-bold text-red-500",
        );
        assert(
          edited !== original,
          "the page edit must introduce a new Tailwind class",
        );
        await Deno.writeTextFile(
          page,
          edited,
        );
        let rebuilt = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const response = await fetch(url + "/styles.css");
          const updated = await response.text();
          if (response.ok && updated.includes(".text-red-500")) {
            rebuilt = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert(
          rebuilt,
          "generated dev script must rebuild CSS for an edited Tailwind class without a production build",
        );
      }
    }
  } catch (error) {
    throw new Error(
      `${production ? "production" : "dev"} server: ${error}\n${diagnostics}`,
    );
  } finally {
    try {
      if (Deno.build.os !== "windows" && child.pid) {
        process.kill(-child.pid, "SIGTERM");
      } else child.kill("SIGTERM");
    } catch { /* already exited */ }
    await closed;
  }
}

for (
  const { pm, tailwind } of [
    { pm: "pnpm", tailwind: false },
    { pm: "npm", tailwind: true },
    { pm: "pnpm", tailwind: true },
  ] as const
) {
  Deno.test({
    name:
      `website E2E: ${pm} installs published UI 0.3 and serves dev/production${
        tailwind ? " with Tailwind" : ""
      }`,
    ignore: Deno.env.get("HUUMA_SCAFFOLD_E2E") !== "1",
    fn: async () => {
      const root = await Deno.makeTempDir({ prefix: "huuma-e2e-" });
      const exitCode = Deno.exitCode;
      const dir = join(root, "app with spaces");
      try {
        Deno.exitCode = 0;
        await project([
          dir,
          "--type",
          "website",
          "--package-manager",
          pm,
          "--install",
          tailwind ? "--tailwind" : "--no-tailwind",
          "--no-skills",
        ]);
        assertEquals(Deno.exitCode, 0, "dependency installation must succeed");
        await server(dir, false, tailwind, pm);
        const build = await new Deno.Command(pm, {
          args: ["run", "build"],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(
          build.success,
          new TextDecoder().decode(build.stderr) +
            new TextDecoder().decode(build.stdout),
        );
        await server(dir, true, tailwind, pm);
      } finally {
        Deno.exitCode = exitCode;
        await Deno.remove(root, { recursive: true });
      }
    },
  });
}

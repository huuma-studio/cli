/** Network-gated integration checks against the actual packages published to
 * JSR/npm. Run with HUUMA_SCAFFOLD_E2E=1 deno test -A src/project/types/website_e2e_test.ts */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import project from "../project.ts";

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
) {
  const port = freePort();
  const child = new Deno.Command("node", {
    cwd,
    args: production ? ["dist/server/server.js"] : [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    env: {
      HOST: "127.0.0.1",
      PORT: String(port),
      ...(production ? { HUUMA_ENV: "PROD" } : {}),
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = child.output();
  const url = `http://127.0.0.1:${port}`;
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 150; attempt++) {
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
    }
  } catch (error) {
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
    const result = await output;
    throw new Error(
      `${production ? "production" : "dev"} server: ${error}\n${
        new TextDecoder().decode(result.stderr)
      }\n${new TextDecoder().decode(result.stdout)}`,
    );
  } finally {
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
    await output;
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
        await server(dir, false, tailwind);
        await server(dir, true, tailwind);
      } finally {
        Deno.exitCode = exitCode;
        await Deno.remove(root, { recursive: true });
      }
    },
  });
}

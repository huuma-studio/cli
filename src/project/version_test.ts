import { assertEquals } from "@std/assert";
import { latest, latestUI03 } from "./version.ts";

const metadata =
  (versions: Record<string, { yanked: boolean }>): typeof fetch => () =>
    Promise.resolve(Response.json({ latest: "0.2.11", versions }));

Deno.test("UI resolver uses versions rather than latest and compares prereleases by semver", async () => {
  assertEquals(
    await latestUI03(metadata({
      "0.2.11": { yanked: false },
      "0.3.0-beta.2": { yanked: false },
      "0.3.0-beta.10": { yanked: false },
      "0.3.0-beta.9": { yanked: false },
      "0.4.0": { yanked: false },
    })),
    "0.3.0-beta.10",
  );
});

Deno.test("UI resolver skips yanked and invalid versions; stable wins over prerelease", async () => {
  assertEquals(
    await latestUI03(metadata({
      "0.3.0-beta.9": { yanked: false },
      "0.3.0": { yanked: false },
      "0.3.1": { yanked: true },
      "0.3.0-not a version": { yanked: false },
    })),
    "0.3.0",
  );
});

Deno.test("UI resolver compares patch versions numerically", async () => {
  assertEquals(
    await latestUI03(metadata({
      "0.3.2": { yanked: false },
      "0.3.10": { yanked: false },
      "0.3.9": { yanked: false },
    })),
    "0.3.10",
  );
});

Deno.test("UI resolver accepts JSR version records without a yanked field", async () => {
  assertEquals(
    await latestUI03(() =>
      Promise.resolve(Response.json({
        latest: "0.2.11",
        versions: { "0.3.0-beta.2": { createdAt: "2026-10-15T00:00:00Z" } },
      }))
    ),
    "0.3.0-beta.2",
  );
});

Deno.test("UI resolver falls back for offline, HTTP errors, malformed and empty metadata", async () => {
  const offline: typeof fetch = () => Promise.reject(new Error("offline"));
  assertEquals(await latestUI03(offline), "0.3.0-beta.1");
  for (
    const body of [null, {}, { versions: [] }, { versions: null }, {
      versions: { "0.2.11": { yanked: false }, "0.3.1": { yanked: true } },
    }]
  ) {
    assertEquals(
      await latestUI03(() => Promise.resolve(Response.json(body))),
      "0.3.0-beta.1",
    );
  }
  assertEquals(
    await latestUI03(() =>
      Promise.resolve(new Response("{}", { status: 503 }))
    ),
    "0.3.0-beta.1",
  );
  assertEquals(
    await latestUI03(() => Promise.resolve(new Response("invalid JSON"))),
    "0.3.0-beta.1",
  );
});

Deno.test("latest uses a bare fallback and retries after a failed request", async () => {
  assertEquals(
    await latest(
      "@huuma/route",
      "0.3.1",
      () => Promise.reject(new Error("offline")),
    ),
    "0.3.1",
  );
  assertEquals(
    await latest(
      "@huuma/route",
      "0.3.1",
      () => Promise.resolve(Response.json({ latest: "0.3.2" })),
    ),
    "0.3.2",
  );
});

Deno.test("route latest stays in 0.3 at or above 0.3.1 and rejects malformed releases", async () => {
  for (
    const version of [
      "0.2.11",
      "0.3.0",
      "0.3.2-beta.1",
      "0.4.0",
      "1.0.0",
      "garbage",
      "",
    ]
  ) {
    const fetcher: typeof fetch = () =>
      Promise.resolve(Response.json({ latest: version }));
    assertEquals(
      await latest("@huuma/route", "0.3.1", fetcher),
      "0.3.1",
      version,
    );
  }
});

Deno.test("route selects the newest supported non-yanked stable release when latest is 0.4", async () => {
  const fetcher: typeof fetch = () =>
    Promise.resolve(Response.json({
      latest: "0.4.0",
      versions: {
        "0.2.11": { yanked: false },
        "0.3.0": { yanked: false },
        "0.3.1": { createdAt: "2026-10-13T16:06:55Z" },
        "0.3.2": { yanked: false },
        "0.3.9": { yanked: false },
        "0.3.10": { yanked: true },
        "0.3.11-beta.1": { yanked: false },
        "0.4.0": { yanked: false },
      },
    }));
  assertEquals(await latest("@huuma/route", "0.3.1", fetcher), "0.3.9");
});

Deno.test("route skips a yanked latest and falls back when no supported version exists", async () => {
  for (
    const versions of [
      { "0.3.2": { yanked: true }, "0.3.1": { yanked: false } },
      { "0.4.0": { yanked: false } },
    ]
  ) {
    assertEquals(
      await latest(
        "@huuma/route",
        "0.3.1",
        () => Promise.resolve(Response.json({ latest: "0.3.2", versions })),
      ),
      "0.3.1",
    );
  }
});

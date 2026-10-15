import { object, string } from "@huuma/validate";
import { compare, parse } from "@std/semver";

const jsrMetaSchema = object({
  latest: string(),
});

/** Latest stable release within the fallback's supported minor line. */
export async function latest(
  module: string,
  fallback: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  try {
    const response = await fetcher(`https://jsr.io/${module}/meta.json`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return fallback;
    }
    const version = jsrMetaSchema.parse(await response.json()).latest;
    const candidate = parse(version);
    const minimum = parse(fallback);
    return candidate.major === minimum.major &&
        candidate.minor === minimum.minor &&
        !candidate.prerelease?.length && compare(candidate, minimum) >= 0
      ? version
      : fallback;
  } catch {
    return fallback;
  }
}

/** JSR's `latest` excludes prereleases. New projects need the newest usable
 * UI 0.3 release even while `latest` still points at the Deno-based 0.2 line. */
export async function latestUI03(
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const fallback = "0.3.0-beta.1";
  try {
    const response = await fetcher("https://jsr.io/@huuma/ui/meta.json", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return fallback;
    }
    const metadata = await response.json();
    if (
      !metadata || typeof metadata.versions !== "object" ||
      metadata.versions === null || Array.isArray(metadata.versions)
    ) return fallback;

    const versions = Object.entries(metadata.versions).flatMap(
      ([version, info]) => {
        if (
          !info || typeof info !== "object" || Array.isArray(info) ||
          (info as { yanked?: unknown }).yanked === true
        ) return [];
        try {
          const semver = parse(version);
          return semver.major === 0 && semver.minor === 3
            ? [{ version, semver }]
            : [];
        } catch {
          return [];
        }
      },
    );
    versions.sort((a, b) => compare(b.semver, a.semver));
    return versions[0]?.version ?? fallback;
  } catch {
    return fallback;
  }
}

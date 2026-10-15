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
    const metadata = await response.json();
    const version = jsrMetaSchema.parse(metadata).latest;
    const minimum = parse(fallback);
    // Registry latest may already target the next breaking minor. Select the
    // newest supported release from versions, also respecting yanked records.
    // If a registry omits the index, validate its advertised latest release.
    if (
      metadata.versions !== undefined &&
      (!metadata.versions || typeof metadata.versions !== "object" ||
        Array.isArray(metadata.versions))
    ) return fallback;
    const entries = metadata.versions === undefined
      ? [[version, {}]] as [string, unknown][]
      : Object.entries(metadata.versions);
    const versions = entries.flatMap(([version, info]) => {
      if (
        !info || typeof info !== "object" || Array.isArray(info) ||
        (info as { yanked?: unknown }).yanked === true
      ) return [];
      try {
        const candidate = parse(version);
        return candidate.major === minimum.major &&
            candidate.minor === minimum.minor &&
            !candidate.prerelease?.length && compare(candidate, minimum) >= 0
          ? [{ version, semver: candidate }]
          : [];
      } catch {
        return [];
      }
    });
    versions.sort((a, b) => compare(b.semver, a.semver));
    return versions[0]?.version ?? fallback;
  } catch {
    return fallback;
  }
}

/** Latest stable, non-deprecated npm release within the fallback's major line.
 * Vite+ requires `vite` aliased to its core at the exact same version, so new
 * projects pin one resolved version rather than a range. */
export async function latestNpm(
  name: string,
  fallback: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  try {
    const response = await fetcher(`https://registry.npmjs.org/${name}`, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
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
    const minimum = parse(fallback);
    const versions = Object.entries(metadata.versions).flatMap(
      ([version, info]) => {
        if (
          !info || typeof info !== "object" || Array.isArray(info) ||
          (info as { deprecated?: unknown }).deprecated
        ) return [];
        try {
          const semver = parse(version);
          return semver.major === minimum.major && !semver.prerelease?.length &&
              compare(semver, minimum) >= 0
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

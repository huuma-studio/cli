/**
 * Thin network wrapper around the codeload tarball download.
 *
 * `downloadTarball(url)` fetches a codeload tarball URL, follows redirects,
 * throws `FetchError` on non-2xx (notably 404 for a bad ref) and on network
 * errors, and returns a `ReadableStream<Uint8Array>` of gzip-decompressed
 * bytes ready to feed `@std/tar`'s `UntarStream`.
 */

export class FetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FetchError";
  }
}

/** Default timeout for the codeload request (30s). Slow responses are
 * aborted rather than hanging the install. */
export const FETCH_TIMEOUT_MS = 30_000;

interface DownloadOptions {
  /** Optional override for `fetch` — primarily a test seam. */
  fetchImpl?: typeof fetch;
  /** Optional request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
}

/** Wraps a promise so it rejects with `FetchError` after `ms` milliseconds. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new FetchError(`Request timed out after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Parses the `<owner>/<repo>/<ref>` segments out of a codeload tarball URL
 * for use in error messages like `"Ref '<ref>' not found in '<owner>/<repo>'"`. */
function describeCodeloadUrl(
  url: string,
): { owner: string; repo: string; ref: string } {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>
    const owner = parts[0] ?? "?";
    const repo = parts[1] ?? "?";
    const ref = parts.slice(3).join("/") || "?";
    return { owner, repo, ref };
  } catch {
    return { owner: "?", repo: "?", ref: "?" };
  }
}

/** Downloads a codeload tarball and returns the gzip-decompressed byte stream.
 * Throws `FetchError` on non-2xx responses, network errors, or timeout. */
export async function downloadTarball(
  url: string,
  opts: DownloadOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const { owner, repo, ref } = describeCodeloadUrl(url);

  let response: Response;
  try {
    response = await withTimeout(
      fetchImpl(url, { redirect: "follow" }),
      timeoutMs,
    );
  } catch (cause) {
    if (cause instanceof FetchError) throw cause;
    throw new FetchError(
      `Network error downloading '${url}': ${
        (cause as Error)?.message ?? cause
      }`,
      { cause },
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new FetchError(
        `Ref '${ref}' not found in '${owner}/${repo}' (HTTP 404)`,
      );
    }
    if (response.status >= 400 && response.status < 500) {
      throw new FetchError(
        `Ref '${ref}' not found in '${owner}/${repo}' (HTTP ${response.status})`,
      );
    }
    throw new FetchError(
      `Failed to download '${url}' (HTTP ${response.status})`,
    );
  }

  if (!response.body) {
    throw new FetchError(`Response from '${url}' had no body.`);
  }

  return response.body.pipeThrough(new DecompressionStream("gzip"));
}

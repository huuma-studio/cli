import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { TarStream } from "@std/tar/tar-stream";
import { downloadTarball, FetchError } from "./fetch.ts";

/** Builds an in-memory tarball, gzips it, and returns the gzipped bytes. */
async function gzippedTarball(
  files: { path: string; content: string }[],
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const input = files.map((f) => {
    const bytes = encoder.encode(f.content);
    return {
      type: "file" as const,
      path: f.path,
      size: bytes.byteLength,
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  });
  const tar = ReadableStream.from(input).pipeThrough(new TarStream());
  const gzipped = tar.pipeThrough(new CompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  for await (const chunk of gzipped) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Reads a decompressed gzip stream to bytes, for assertions. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

Deno.test(
  { permissions: { net: true } },
  async function offlineServeReturnsDecompressedTarball() {
    const body = await gzippedTarball([
      { path: "repo-main/SKILL.md", content: "name: demo" },
    ]);
    const server = Deno.serve(
      { port: 0 },
      () =>
        new Response(body as BodyInit, {
          headers: { "content-type": "application/gzip" },
        }),
    );
    try {
      const url = `http://localhost:${
        (server.addr as Deno.NetAddr).port
      }/owner/repo/tar.gz/main`;
      const stream = await downloadTarball(url);
      const bytes = await drain(stream);
      // The decompressed bytes start with a tar header containing "repo-main/SKILL.md".
      assert(bytes.byteLength > 0, "decompressed bytes are empty");
      assert(new TextDecoder().decode(bytes).includes("repo-main/SKILL.md"));
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test(
  { permissions: { net: true } },
  async function offlineServe404ThrowsFetchError() {
    const server = Deno.serve(
      { port: 0 },
      () => new Response("not found", { status: 404 }),
    );
    try {
      const url = `http://localhost:${
        (server.addr as Deno.NetAddr).port
      }/owner/repo/tar.gz/badref`;
      const err = await assertRejects(
        () => downloadTarball(url),
        FetchError,
      );
      assertStringIncludes(err.message, "badref");
      assertStringIncludes(err.message, "owner/repo");
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test("network error is wrapped as FetchError", async () => {
  // Use a fetchImpl that always rejects to simulate a network failure.
  const fetchImpl =
    (() =>
      Promise.reject(new Error("connection reset"))) as unknown as typeof fetch;
  const err = await assertRejects(
    () =>
      downloadTarball("https://codeload.github.com/owner/repo/tar.gz/main", {
        fetchImpl,
      }),
    FetchError,
  );
  assertStringIncludes(err.message, "Network error");
});

Deno.test("times out and aborts when the response never arrives", async () => {
  // A fetch that hangs until its signal aborts — mimics a stalled connection.
  const fetchImpl = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The signal has been aborted", "AbortError"));
      });
    })) as unknown as typeof fetch;

  const err = await assertRejects(
    () =>
      downloadTarball("https://codeload.github.com/owner/repo/tar.gz/main", {
        fetchImpl,
        timeoutMs: 10,
      }),
    FetchError,
  );
  assertStringIncludes(err.message, "timed out");
});

Deno.test("live network test self-skips when offline", {
  permissions: { net: true },
}, async () => {
  // Probe connectivity first; skip silently when offline.
  try {
    await fetch("https://example.com", { method: "HEAD", redirect: "follow" });
  } catch {
    return; // offline — skip the live assertion
  }

  // A small, stable public repo tarball. If it ever moves, the test should be
  // updated; it deliberately targets a well-known repo.
  const url = "https://codeload.github.com/denoland/deno/tar.gz/main";
  const stream = await downloadTarball(url, { timeoutMs: 60_000 });
  const bytes = await drain(stream);
  assert(bytes.byteLength > 0, "live tarball came back empty");
});

// keep assertEquals referenced for future assertions in this module
void assertEquals;

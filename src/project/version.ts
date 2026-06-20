import { object, string } from "@huuma/validate";

const _latest = new Map<string, string>();

const jsrMetaSchema = object({
  latest: string(),
});

export async function latest(
  module: string,
  fallback: string,
): Promise<string> {
  if (!_latest.get(module)) {
    try {
      _latest.set(
        module,
        await fetch(`https://jsr.io/${module}/meta.json`, {
          headers: {
            "Accept": "application/json",
          },
        }).then((res) => res.json()).then((json) =>
          jsrMetaSchema.parse(json).latest
        ),
      );
    } catch (_e) {
      _latest.set(module, fallback);
    }
  }

  return <string> _latest.get(module);
}

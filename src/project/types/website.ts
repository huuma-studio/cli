import { join } from "@std/path";
import { create as createFile } from "../file.ts";
import { create as createDir } from "../directory.ts";

const denoConfigContent = `{
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "huuma",
    "lib": [
      "dom",
      "dom.iterable",
      "dom.asynciterable",
      "deno.ns"
    ]
  },
  "tasks": {
    "dev": "deno run --allow-all --watch dev.ts",
    "debug": "deno run --inspect-brk --allow-all dev.ts"
  },
}`;

export default async (projectName: string) => {
  await createDir(join(projectName, "src"));
  await createDir(join(projectName, "assets"));
  await createDir(join(projectName, "pages"));
  await denoConfig(projectName);
  await appTs(projectName);
  await indexPage(projectName);
  return "Website application created!";
};

async function appTs(projectName: string) {
  //await createFile(join(projectName, "app.ts"), appTsContent);
  //await createFile(join(projectName, "dev.ts"), devTsContent);
}

async function indexPage(projectName: string) {
  // await createFile(join(projectName, "pages", "page.tsx"), indexPageContent);
}

async function denoConfig(projectName: string) {
  await createFile(join(projectName, "deno.json"), denoConfigContent);
}

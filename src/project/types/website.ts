import { join } from "@std/path";
import { create as createFile } from "../file.ts";
import { create as createDir } from "../directory.ts";

const denoConfigContent = (projectName: string) =>
  `{
  "name": "${projectName}",
  "imports": {
    "@huuma/route": "jsr:@huuma/route@^0.0.1",
    "@huuma/ui": "jsr:@huuma/ui@^0.0.9",
    "@/": "./src/"
  },
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "@huuma/ui",
    "lib": ["dom", "dom.iterable", "dom.asynciterable", "deno.ns"]
  },
  "tasks": {
    "dev": "deno -ERWN --allow-run --watch dev.ts",
    "bundle": "deno -ERW --allow-run dev.ts --bundle",
    "start": "deno -ERN app.ts"
  }
}`;

export default async (projectName: string) => {
  await createDir(join(projectName, "src"));
  await createDir(join(projectName, "assets"));
  await createDir(join(projectName, "pages"));
  await denoConfig(projectName);
  await rootTs(projectName);
  await appTs(projectName);
  await indexPage(projectName);
  return "Website application created!";
};

const rootTsContent =
  `import { createUIApp, Launch, Scripts } from "@huuma/ui/server";

const app = createUIApp(({ children, scripts, islands, transferState }) => {
  return (
    <html lang="en">
      <head>
        <Scripts nonce={scripts?.nonce} scripts={scripts?.head} />
        <title>Hello Huuma</title>
      </head>
      <body>
        {children}
        <Scripts nonce={scripts?.nonce} scripts={scripts?.body} />
        <Launch
          nonce={scripts?.nonce}
          body={scripts?.body}
          islands={islands}
          transferState={transferState}
        />
      </body>
    </html>
  );
});

export default app;
`;

async function rootTs(projectName: string) {
  await createFile(join(projectName, "pages", "root.tsx"), rootTsContent);
}

const appTsContent = `import { pack } from "@huuma/ui/server/pack";
import app from "./pages/root.tsx";
import List from "./.pack/list.ts";

await pack(app, List);
Deno.serve(app.deliver());
`;
const devTsContent = `import { prepare } from "@huuma/ui/server/pack";
import app from "./pages/root.tsx";

const handler = (await prepare(app))?.deliver();
if (handler) Deno.serve(handler);
`;
async function appTs(projectName: string) {
  await createFile(join(projectName, "app.ts"), appTsContent);
  await createFile(join(projectName, "dev.ts"), devTsContent);
}

const indexPageContent = `export default () => {
  return (
    <>
      <main>
        <h2>Hello Huuma</h2>
      </main>
    </>
  );
};
`;
async function indexPage(projectName: string) {
  await createFile(join(projectName, "pages", "page.tsx"), indexPageContent);
}

async function denoConfig(projectName: string) {
  await createFile(
    join(projectName, "deno.json"),
    denoConfigContent(projectName),
  );
}

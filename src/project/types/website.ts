import { join } from "@std/path";
import { create as createFile } from "../file.ts";
import { create as createDir } from "../directory.ts";
import { latest } from "../version.ts";
import { confirm } from "../../input.ts";

const modules = ["@huuma/route", "@huuma/ui"] as const;

const denoConfigContent = `{
  "imports": {
    "${modules[0]}": "jsr:${modules[0]}@^${await latest(modules[0])}",
    "${modules[1]}": "jsr:${modules[1]}@^${await latest(modules[1])}",
    "@/": "./src/",
    "@app/": "./app/",
    "@manifest/": "./.huuma/"
  },
  "lint": {
    "plugins": ["jsr:@huuma/ui/lint"]
  },
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "@huuma/ui",
    "lib": ["dom", "dom.iterable", "dom.asynciterable", "deno.ns"]
  },
  "tasks": {
    "dev": "deno -ERWN --allow-run --watch dev.ts",
    "bundle": "deno -ERWN --allow-run dev.ts --bundle",
    "start": "deno -ERN app.ts"
  }
}`;

export default async (projectName: string) => {
  const addZedSettings = await confirm("\nAdd .zed/settings.json for Deno?");
  const addVscodeSettings = await confirm(
    "\nAdd .vscode/settings.json for Deno?",
  );

  await createDir(join(projectName, "src"));
  await createDir(join(projectName, "static"));
  await createDir(join(projectName, "app"));
  await denoConfig(projectName);
  await rootTs(projectName);
  await appTs(projectName);
  await indexPage(projectName);

  if (addZedSettings) {
    await zedSettings(projectName);
  }

  if (addVscodeSettings) {
    await vscodeSettings(projectName);
  }

  return "Website application created!";
};

const rootTsContent = `import { createUIApp, Launch, Scripts, Meta } from "@huuma/ui/server";
import { AppContext } from "@huuma/route";
import { loadStaticFiles } from "@huuma/route/http/tasks/static-files";

const app = createUIApp(
  ({ children, scripts, islands, metadata, transferState }) => {
    return (
      <html lang="en">
        <head>
          <Meta metadata={metadata} />
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
  },
);

// Apply additional tasks or middleware here.
await loadStaticFiles(app);

export default app;

`;

async function rootTs(projectName: string) {
  await createFile(join(projectName, "app", "root.tsx"), rootTsContent);
}

const appTsContent = `import { pack } from "@huuma/ui/server/pack";
import app from "@app/root.tsx";
import List from "./.huuma/list.ts";

await pack(app, List);
Deno.serve(app.deliver());
`;
const devTsContent = `import { prepare } from "@huuma/ui/server/pack/list";
import app from "@app/root.tsx";

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
  await createFile(join(projectName, "app", "page.tsx"), indexPageContent);
}

async function denoConfig(projectName: string) {
  await createFile(join(projectName, "deno.json"), denoConfigContent);
}

const zedSettingsContent = `{
  "lsp": {
    "deno": {
      "settings": {
        "deno": {
          "enable": true
        }
      }
    }
  },
  "languages": {
    "JavaScript": {
      "language_servers": [
        "deno",
        "!typescript-language-server",
        "!vtsls",
        "!eslint",
        "..."
      ],
      "formatter": "language_server"
    },
    "TypeScript": {
      "language_servers": [
        "deno",
        "!typescript-language-server",
        "!vtsls",
        "!eslint",
        "..."
      ],
      "formatter": "language_server"
    },
    "TSX": {
      "language_servers": [
        "deno",
        "!typescript-language-server",
        "!vtsls",
        "!eslint",
        "..."
      ],
      "formatter": "language_server"
    }
  }
}
`;

async function zedSettings(projectName: string) {
  await createDir(join(projectName, ".zed"));
  await createFile(
    join(projectName, ".zed", "settings.json"),
    zedSettingsContent,
  );
}

const vscodeSettingsContent = `{
  "deno.enable": true,
  "deno.lint": true,
  "editor.defaultFormatter": "denoland.vscode-deno",
  "[typescript]": {
    "editor.defaultFormatter": "denoland.vscode-deno"
  },
  "[typescriptreact]": {
    "editor.defaultFormatter": "denoland.vscode-deno"
  },
  "[javascript]": {
    "editor.defaultFormatter": "denoland.vscode-deno"
  },
  "[javascriptreact]": {
    "editor.defaultFormatter": "denoland.vscode-deno"
  },
  "[json]": {
    "editor.defaultFormatter": "denoland.vscode-deno"
  }
}
`;

async function vscodeSettings(projectName: string) {
  await createDir(join(projectName, ".vscode"));
  await createFile(
    join(projectName, ".vscode", "settings.json"),
    vscodeSettingsContent,
  );
}

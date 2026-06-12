import { choose, confirm, question } from "../input.ts";

const name = await question("Project name:", {
  validate: (value) => value ? undefined : "Project name is required",
});
const ok = await confirm("Add settings?", true);
const type = await choose(["website", "api"], "Select the type:");

console.log(JSON.stringify({ name, ok, type }));

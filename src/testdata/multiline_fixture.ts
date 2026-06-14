import { multiline } from "../input.ts";

const text = await multiline("Paste your block:");

console.log(JSON.stringify({ text }));

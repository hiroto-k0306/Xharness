import { projectPreflight } from "../src/main/workflow/official/preflight.js";
const args = process.argv.slice(2),
  files: string[] = [];
let cwd: string | undefined;
for (let i = 0; i < args.length; i++) {
  const value = args[++i];
  if (!value)
    throw new Error(
      "Expected --project PATH and repeated --file RELATIVE_PATH",
    );
  if (args[i - 1] === "--project" && !cwd) cwd = value;
  else if (args[i - 1] === "--file") files.push(value);
  else throw new Error("Unknown or duplicate argument");
}
if (!cwd)
  throw new Error("Expected --project PATH and repeated --file RELATIVE_PATH");
console.log(
  JSON.stringify(
    await projectPreflight(cwd, files, new AbortController().signal),
    null,
    2,
  ),
);

/**
 * Compile the engine for the tests. See `tsconfig.test.json` for why a build is
 * needed at all.
 *
 * The `package.json` written beside the output is not decoration: the repository
 * declares `"type": "module"`, so without a nearer declaration Node would read
 * every emitted `.js` as ESM and refuse the `exports` assignments tsc puts in
 * them.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, ".test-build");

const tsc = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.test.json"],
  { cwd: root, stdio: "inherit" }
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "package.json"), '{ "type": "commonjs" }\n');

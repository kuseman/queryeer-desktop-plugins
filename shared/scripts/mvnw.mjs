// Runs the repository's Maven wrapper with the given arguments on any OS.
//   node shared/scripts/mvnw.mjs -pl plugins/mongodb/backend -am package
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const isWindows = process.platform === "win32";
const args = ["-B", ...process.argv.slice(2)];
// Through sh on Unix: a checkout made on Windows may lack the executable bit on mvnw
const result = isWindows
  ? spawnSync(resolve(repoRoot, "mvnw.cmd"), args, { cwd: repoRoot, stdio: "inherit", shell: true })
  : spawnSync("sh", [resolve(repoRoot, "mvnw"), ...args], { cwd: repoRoot, stdio: "inherit" });
process.exit(result.status ?? 1);

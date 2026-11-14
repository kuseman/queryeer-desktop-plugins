// End-to-end smoke test of the packaged MongoDB plugin inside Queryeer's real backend runner.
// No frontend involved: talks to the runner over its stdio protocol (Content-Length framed JSON).
//
// Requires:
//   - Docker (starts a throwaway mongo:7.0 container on port 27099)
//   - A local Queryeer Desktop development checkout with the backend built (dev mode does this):
//       QUERYEER_DESKTOP_DIR (default: ../queryeer-desktop/development next to this repository)
//   - The plugin packaged first: npm run mongodb:package
//
//   node plugins/mongodb/scripts/smoke-backend.mjs
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const core = resolve(process.env.QUERYEER_DESKTOP_DIR ?? join(repoRoot, "..", "queryeer-desktop", "development"));
const manifest = JSON.parse(readFileSync(join(repoRoot, "plugins", "mongodb", "plugin.json"), "utf8"));
const pluginFolder = join(repoRoot, "dist", `${manifest.id}-${manifest.version}`);
const runnerTarget = join(core, "queryeer-backend", "backend-runner", "target");
const container = "queryeer-mongodb-smoke";
const port = 27099;

for (const [path, hint] of [
  [pluginFolder, "run `npm run mongodb:package` first"],
  [join(runnerTarget, "classes"), "build the Queryeer backend (start Queryeer Desktop in dev mode once, or run Maven install in queryeer-backend)"],
  [join(runnerTarget, "queryeer-runner-classpath.txt"), "build the Queryeer backend"]
]) {
  if (!existsSync(path)) {
    console.error(`smoke: missing ${path} (${hint})`);
    process.exit(1);
  }
}

const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures.push(message);
};

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
docker("rm", "-f", container);
const started = docker("run", "-d", "--name", container, "-p", `${port}:27017`, "mongo:7.0");
if (started.status !== 0) {
  console.error(`smoke: could not start MongoDB container: ${started.stderr}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "queryeer-mongodb-smoke-"));
let java;
try {
  await waitForMongo();
  docker("exec", container, "mongosh", "--quiet", "shop", "--eval",
    'db.orders.insertMany([{_id:1,status:"open",total:10,customer:{name:"A"}},{_id:2,status:"closed",total:20},{_id:3,status:"open",total:30,note:"late"}])');

  const pluginsDir = join(work, "plugins");
  const settingsDir = join(work, "settings");
  mkdirSync(settingsDir, { recursive: true });
  cpSync(pluginFolder, join(pluginsDir, manifest.id), { recursive: true });
  writeFileSync(join(settingsDir, "com.queryeer.mongodb.connections.json"), JSON.stringify({
    moduleId: "com.queryeer.mongodb.connections",
    version: 1,
    updatedAt: new Date().toISOString(),
    values: { "com.queryeer.mongodb.connections.list": [{ connectionId: "local", title: "Local", hosts: `localhost:${port}`, defaultDatabase: "shop" }] }
  }));

  const classpath = [join(runnerTarget, "classes"), readFileSync(join(runnerTarget, "queryeer-runner-classpath.txt"), "utf8").trim()].join(delimiter);
  java = spawn("java", ["--enable-native-access=ALL-UNNAMED", `-Dqueryeer.builtins.dir=${join(core, "plugins", "builtin")}`, `-Dqueryeer.plugins.dir=${pluginsDir}`,
    `-Dqueryeer.settings.dir=${settingsDir}`, "-cp", classpath, "com.queryeer.backend.runner.BackendRunnerApp"], { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
  const stderr = [];
  java.stderr.on("data", (d) => stderr.push(d.toString()));
  const client = createClient(java);

  try {
    const handshake = await client.request("backend.handshake", {
      client: { name: "queryeer-mongodb-smoke", version: "0" },
      supportedProtocolMajors: [1],
      requestedCapabilities: ["backend.runtimeStatus", "queryengine.execute", "queryengine.invoke", "queryengine.chunkStart", "queryengine.chunkRows", "queryengine.completed", "queryengine.failed"]
    });
    check(!handshake.error, "handshake");

    const status = await client.request("backend.runtimeStatus", {});
    const activated = (status.result?.runtimeStatus ?? status.result)?.activatedPluginIds ?? [];
    check(activated.includes(manifest.id), `plugin ${manifest.id} activated`);

    const find = await client.execute("smoke-find", '{ "find": "orders", "sort": { "_id": 1 }, "batchSize": 2 }', { timeoutMs: 15000 });
    check(find.terminal.method === "queryengine.completed", "find completes with a timeout set (multi-batch)");
    check(JSON.stringify(find.columns[0]) === JSON.stringify(["_id", "status", "total", "customer", "$extra"]), `find columns ${JSON.stringify(find.columns[0])}`);
    check(find.rows.length === 3 && String(find.rows[2][4]).includes("late"), "late key arrives in $extra");

    const multi = await client.execute("smoke-multi", '{ "count": "orders" }\n{ "distinct": "orders", "key": "status" }');
    check(multi.columns.length === 2 && multi.rows[0][0] === 3, "two commands give two result sets; count = 3");

    const rejected = await client.execute("smoke-delete", '{ "delete": "orders", "deletes": [] }');
    check(rejected.terminal.params?.error?.code === "VALIDATION", "write command rejected as VALIDATION");

    const databases = await client.request("queryengine.invoke", { engineId: "mongodb", fileId: "smoke-file", action: "mongodb.databases", payload: { connectionId: "local" } });
    // queryengine.invoke wraps the engine's return value as result.result
    const names = databases.result?.result;
    check(Array.isArray(names) && names.includes("shop"), `invoke mongodb.databases lists shop: ${JSON.stringify(databases.result ?? databases.error)}`);
  } catch (e) {
    failures.push(e.message);
    console.error(`smoke: ${e.message}\n--- backend stderr (tail) ---\n${stderr.join("").slice(-4000)}`);
  }
} finally {
  java?.stdin.end();
  java?.kill();
  docker("rm", "-f", container);
  rmSync(work, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nSmoke test passed" : `\nSmoke test failed (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);

async function waitForMongo() {
  for (let i = 0; i < 60; i++) {
    const ping = docker("exec", container, "mongosh", "--quiet", "--eval", "db.runCommand({ ping: 1 }).ok");
    if (ping.stdout?.trim() === "1") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("MongoDB container did not become ready");
}

function createClient(child) {
  const waiters = [];
  const events = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString());
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8"));
      buffer = buffer.subarray(headerEnd + 4 + length);
      events.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  });

  const waitFor = (match, ms = 30000) => new Promise((resolve, reject) => {
    waiters.push({ match, resolve });
    setTimeout(() => reject(new Error("timed out waiting for the backend")), ms);
  });
  let counter = 0;
  const request = (method, params) => {
    const id = `smoke-${++counter}`;
    const body = Buffer.from(JSON.stringify({ protocolVersion: "1.0.0", type: "request", id, method, params }), "utf8");
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
    return waitFor((m) => m.type === "response" && m.id === id);
  };
  const execute = async (queryExecutionId, text, options = {}) => {
    const done = waitFor((m) => (m.method === "queryengine.completed" || m.method === "queryengine.failed") && m.params?.queryExecutionId === queryExecutionId);
    await request("queryengine.execute", { queryExecutionId, engineId: "mongodb", fileId: "smoke-file", text, engineState: { connectionId: "local" }, options });
    const terminal = await done;
    const mine = events.filter((e) => e.params?.queryExecutionId === queryExecutionId);
    return {
      terminal,
      columns: mine.filter((e) => e.method === "queryengine.chunkStart").map((e) => e.params.schema.columns.map((c) => c.name)),
      rows: mine.filter((e) => e.method === "queryengine.chunkRows").flatMap((e) => e.params.rows)
    };
  };
  return { request, execute };
}

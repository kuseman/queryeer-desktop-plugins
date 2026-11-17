// End-to-end smoke test of the packaged MySQL and MariaDB dialect inside Queryeer's real backend runner.
// No frontend involved: talks to the runner over its stdio protocol (Content-Length framed JSON).
//
// What it proves, beyond the Testcontainers tests (which run on one flat classpath):
//   - the runner loads an external dialect next to the built-in JDBC plugin, and the dialect finds JdbcRuntimeService
//   - the driver is not in the plugin: it sits in <appDir>/libShared, as core's driver service would install it,
//     and reaches the dialect through the shared class loader
//
// Requires:
//   - Docker (starts a throwaway mysql:8.4 container on port 33099)
//   - A local Queryeer Desktop development checkout with the backend built (dev mode does this):
//       QUERYEER_DESKTOP_DIR (default: ../queryeer-desktop/development next to this repository)
//   - The plugin packaged first: npm run mysql:package
//
//   node plugins/mysql/scripts/smoke-backend.mjs
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const core = resolve(process.env.QUERYEER_DESKTOP_DIR ?? join(repoRoot, "..", "queryeer-desktop", "development"));
const manifest = JSON.parse(readFileSync(join(repoRoot, "plugins", "mysql", "plugin.json"), "utf8"));
const pluginFolder = join(repoRoot, "dist", `${manifest.id}-${manifest.version}`);
const runnerTarget = join(core, "queryeer-backend", "backend-runner", "target");
const pom = readFileSync(join(repoRoot, "plugins", "mysql", "backend", "pom.xml"), "utf8");
const driverVersion = /<mariadb\.driver\.version>([^<]+)</.exec(pom)[1];
const container = "queryeer-mysql-smoke";
const port = 33099;
const password = "queryeer-smoke";

for (const [path, hint] of [
  [pluginFolder, "run `npm run mysql:package` first"],
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

const work = mkdtempSync(join(tmpdir(), "queryeer-mysql-smoke-"));
const appDir = join(work, "app");
const libShared = join(appDir, "libShared");
mkdirSync(libShared, { recursive: true });

// The driver goes where core's driver service puts it, never into the plugin
const copied = spawnSync(process.execPath, [join(repoRoot, "shared", "scripts", "mvnw.mjs"), "-q",
  "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy", `-Dartifact=org.mariadb.jdbc:mariadb-java-client:${driverVersion}`, `-DoutputDirectory=${libShared}`],
{ cwd: repoRoot, stdio: "inherit" });
if (copied.status !== 0 || readdirSync(libShared).length === 0) {
  console.error("smoke: could not fetch the MariaDB driver into libShared");
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
const bundled = readdirSync(join(pluginFolder, "lib")).filter((name) => /mariadb|mysql-connector/i.test(name));
check(bundled.length === 0, `plugin bundles no driver ${bundled.length ? JSON.stringify(bundled) : ""}`);

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
docker("rm", "-f", container);
const started = docker("run", "-d", "--name", container, "-p", `${port}:3306`, "-e", `MYSQL_ROOT_PASSWORD=${password}`, "-e", "MYSQL_DATABASE=shop", "mysql:8.4.13");
if (started.status !== 0) {
  console.error(`smoke: could not start the MySQL container: ${started.stderr}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

let java;
try {
  await waitForMySql();
  const seeded = docker("exec", container, "mysql", "-uroot", `-p${password}`, "shop", "-e",
    "CREATE TABLE orders (id INT PRIMARY KEY, status VARCHAR(20), total DECIMAL(10, 2)); INSERT INTO orders VALUES (1, 'open', 10.50), (2, 'closed', 20.00), (3, 'open', 30.25);");
  if (seeded.status !== 0) throw new Error(`could not seed MySQL: ${seeded.stderr}`);

  const pluginsDir = join(work, "plugins");
  const settingsDir = join(work, "settings");
  mkdirSync(settingsDir, { recursive: true });
  cpSync(pluginFolder, join(pluginsDir, manifest.id), { recursive: true });
  writeFileSync(join(settingsDir, "core.queryengine.jdbc.json"), JSON.stringify({
    moduleId: "core.queryengine.jdbc",
    version: 1,
    updatedAt: new Date().toISOString(),
    values: {
      "core.queryengine.jdbc.connections": [{
        connectionId: "local",
        title: "Local MySQL",
        dialectId: "mysql",
        username: "root",
        password,
        // The image's certificate is self-signed
        properties: { host: "localhost", port, database: "shop", sslMode: "trust" }
      }]
    }
  }));

  const classpath = [join(runnerTarget, "classes"), readFileSync(join(runnerTarget, "queryeer-runner-classpath.txt"), "utf8").trim()].join(delimiter);
  java = spawn("java", ["--enable-native-access=ALL-UNNAMED", `-Dqueryeer.app.dir=${appDir}`, `-Dqueryeer.builtins.dir=${join(core, "plugins", "builtin")}`,
    `-Dqueryeer.plugins.dir=${pluginsDir}`, `-Dqueryeer.settings.dir=${settingsDir}`, "-cp", classpath, "com.queryeer.backend.runner.BackendRunnerApp"],
  { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
  const stderr = [];
  java.stderr.on("data", (d) => stderr.push(d.toString()));
  const client = createClient(java);

  try {
    const handshake = await client.request("backend.handshake", {
      client: { name: "queryeer-mysql-smoke", version: "0" },
      supportedProtocolMajors: [1],
      requestedCapabilities: ["backend.runtimeStatus", "queryengine.execute", "queryengine.invoke", "queryengine.chunkStart", "queryengine.chunkRows", "queryengine.completed", "queryengine.failed"]
    });
    check(!handshake.error, "handshake");

    const status = await client.request("backend.runtimeStatus", {});
    const runtimeStatus = status.result?.runtimeStatus ?? status.result;
    const activated = runtimeStatus?.activatedPluginIds ?? [];
    check(activated.includes(manifest.id), `plugin ${manifest.id} activated`);
    // The JDBC family shares classes through the JDBC plugin's exports: every member must still activate
    const jdbcFamily = ["queryengine.jdbc", "queryengine.jdbc.dialect.postgres", "queryengine.jdbc.dialect.sqlite", "queryengine.jdbc.dialect.sqlserver", "queryengine.payloadbuilder"];
    const notActivated = jdbcFamily.filter((id) => !activated.includes(id));
    check(notActivated.length === 0, `built-in JDBC plugins activated ${notActivated.length ? `(not: ${notActivated.join(", ")})` : ""}`);
    if (!activated.includes(manifest.id) || notActivated.length > 0) console.log(`runtime status: ${JSON.stringify(runtimeStatus)}`);

    // The settings editor renders the connection form from these fields; no frontend code needed
    const dialects = await client.request("queryengine.invoke", { engineId: "jdbc", fileId: "smoke-file", action: "jdbc.connection.dialects", payload: {} });
    const mysqlEntry = (dialects.result?.result ?? []).find((entry) => entry.id === "mysql");
    const fieldIds = mysqlEntry?.connectionSetup?.fields?.map((field) => field.id) ?? [];
    check(JSON.stringify(fieldIds) === JSON.stringify(["host", "port", "database", "username", "password", "sslMode"]), `connection form fields ${JSON.stringify(fieldIds)}`);

    const select = await client.execute("smoke-select", "SELECT id, status, total FROM orders WHERE status = 'open' ORDER BY id");
    check(select.terminal.method === "queryengine.completed", `query completes: ${select.terminal.method} ${JSON.stringify(select.terminal.params?.error ?? "")}`);
    check(JSON.stringify(select.columns[0]) === JSON.stringify(["id", "status", "total"]), `columns ${JSON.stringify(select.columns[0])}`);
    check(select.rows.length === 2 && select.rows[0][0] === 1 && select.rows[1][1] === "open", `rows ${JSON.stringify(select.rows)}`);

    const version = await client.execute("smoke-version", "SELECT VERSION()");
    check(String(version.rows[0]?.[0] ?? "").startsWith("8.4"), `server version ${JSON.stringify(version.rows[0])}`);
  } catch (e) {
    failures.push(e.message);
    console.error(`smoke: ${e.message}`);
  }
  if (failures.length > 0) {
    console.error(`--- backend stderr (tail) ---\n${stderr.join("").slice(-6000)}`);
  }
} finally {
  java?.stdin.end();
  java?.kill();
  docker("rm", "-f", container);
  rmSync(work, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nSmoke test passed" : `\nSmoke test failed (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);

// The image starts a temporary server on port 0 to initialise, then the real one on 3306 (33060 is the X Plugin)
async function waitForMySql() {
  for (let i = 0; i < 180; i++) {
    const logs = docker("logs", container);
    if (/port: 3306(?!\d)/.test(`${logs.stdout}${logs.stderr}`)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("MySQL container did not become ready");
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
    await request("queryengine.execute", { queryExecutionId, engineId: "jdbc", fileId: "smoke-file", text, engineState: { connectionId: "local" }, options });
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

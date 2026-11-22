# Queryeer Kafka Plugin

Kafka connections for Queryeer Desktop, and payloadbuilder's `kafka` catalog over them. Plugin id `com.queryeer.kafka`. Needs Queryeer 0.23 for its own backend actions (`context.actions()` / `context.backend.invoke`).

## What it adds

- **Connections** in Settings → Query Engine → Kafka (also the command **Manage Kafka Connections**):
  - bootstrap servers, security protocol (`PLAINTEXT`, `SSL`, `SASL_PLAINTEXT`, `SASL_SSL`) and an optional schema registry URL;
  - SASL `PLAIN`, `SCRAM-SHA-256` and `SCRAM-SHA-512` with a username and a password; the plugin builds the JAAS configuration;
  - SASL `OAUTHBEARER` and `GSSAPI` with a whole JAAS configuration (optional for GSSAPI, which may be set up for the JVM);
  - passwords and JAAS configurations are kept in the Queryeer vault, never in settings;
  - **Test connection** asks the cluster for its id and brokers, also for a connection that isn't saved yet.
- **The `kafka` payloadbuilder catalog**, when payloadbuilder is installed (an optional dependency). It replaces Queryeer's built-in one, so files that use the `kafka` catalog keep working after picking one of the plugin's connections.
  - The catalog panel picks the connection and, optionally, a topic. **Reload topics** lists the cluster's topics.
  - Tables: `kafka#topic.<name>` (or `kafka#topic` with the panel's topic), `kafka#metadata.topics`, `kafka#metadata.partitions` and the other tables of payloadbuilder's kafka catalog.
  - Table completion and hover come from the catalog's system tables.
- **Backend actions** of the plugin itself, not of payloadbuilder: `topics.list` and `connection.test`. They work without payloadbuilder, so a later Kafka browser can use them.

Connections start fresh: Queryeer's built-in Kafka connections (`core.queryengine.payloadbuilder.kafka.connections`) aren't migrated.

## Not yet

- A Kafka browser (topics, consumer groups, messages) without payloadbuilder.
- SSL trust and key stores; TLS uses the JVM's default trust store.
- Schema registry credentials.

## Building

From the repository root (requires Java 25, Node 20+, and Docker for the Testcontainers tests):

| Command | Does |
|---|---|
| `npm install` | Installs the packaging tooling and the frontend workspaces, including `@queryeer/api` from npm |
| `npm run kafka:test` | Runs the frontend typecheck and tests, then the backend tests (unit tests, and a Kafka container for the actions and a payloadbuilder query through the catalog) |
| `npm run kafka:package` | Builds the backend and the frontend, then assembles and verifies `dist/com.queryeer.kafka-<version>.zip`, its `.sha256`, and the unpacked folder `dist/com.queryeer.kafka-<version>/` |
| `npm run kafka:dev` | Frontend watch mode: rebuilds on save into the unpacked folder. Run `kafka:package` once first |

- **Versions it builds against:** `backend-api` and the payloadbuilder foundation at `0.23.0-SNAPSHOT` (its own `queryeer.backend.version` in `backend/pom.xml`), and the root `pom.xml`'s `payloadbuilder.version` for the bundled `payloadbuilder-catalog-kafka`.
- **Bundled:** `kafka-clients` (`kafka.clients.version`, the version payloadbuilder's catalog is built with), the catalog and its libraries, and `avro` for Avro and schema-registry topics.
- **`@queryeer/api` 0.23** isn't on npm yet: `frontend/src/pluginBackend.ts` repeats the `PluginBackend` type until it is.
- **The plugin version** lives in `plugin.json`, the `<version>` in `backend/pom.xml` and `frontend/package.json`. `shared/scripts/plugin-version.mjs` checks that they match.
- **Development loop:** as for the [MongoDB plugin](../mongodb/README.md#building), with `QUERYEER_DEV_PLUGINS` pointing at the unpacked folder.
- **A local Kafka to try it on:** `sh plugins/kafka/scripts/local-kafka.sh start`, then `seed` for the topics `orders` (3 partitions, keys and headers), `payments` and `customers`, and a consumer group `billing` part way into `orders`. `status` lists them, `stop` keeps the data, `rm` removes it. Connect with `localhost:9092` and `PLAINTEXT`.

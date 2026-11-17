import type { Plugin } from "@queryeer/api/plugin/Plugin";
import type { JdbcManagedDriverContribution } from "@queryeer/api/queryengine/JdbcDriverExtension";

// The backend uses the same values (plugin.json, MySqlDialect.DIALECT_ID, MySqlDialect.DRIVER_CLASS_NAME).
export const PLUGIN_ID = "com.queryeer.jdbc.mysql";
export const DIALECT_ID = "mysql";

/**
 * MariaDB Connector/J serves both MySQL and MariaDB. It is never bundled (it is LGPL, and core owns `libShared`):
 * core downloads it from Maven Central after the user confirms, and the backend dialect loads it from there.
 */
export const MARIADB_DRIVER: JdbcManagedDriverContribution = {
  dialectId: DIALECT_ID,
  displayName: "MariaDB Connector/J (MySQL and MariaDB)",
  groupId: "org.mariadb.jdbc",
  artifactId: "mariadb-java-client",
  driverClassName: "org.mariadb.jdbc.Driver",
  // The repository shows the LGPL licence and links the releases
  downloadPageUrl: "https://github.com/mariadb-corporation/mariadb-connector-j"
};

/**
 * The dialect needs no other frontend: its connection form comes from the backend's `connectionSetup()` fields.
 */
export const mysqlPlugin: Plugin = {
  manifest: {
    id: PLUGIN_ID,
    name: "MySQL and MariaDB",
    version: "0.1.0",
    kind: "feature",
    description: "MySQL and MariaDB dialect for the JDBC query engine",
    dependencies: ["core.queryengine.jdbc"]
  },

  activate: (context) => {
    context.jdbcDrivers.registerDriver(MARIADB_DRIVER);
  }
};

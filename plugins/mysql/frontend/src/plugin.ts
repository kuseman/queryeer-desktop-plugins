import type { Disposable } from "@queryeer/api/editor/EditorApi";
import type { Plugin } from "@queryeer/api/plugin/Plugin";
import type { WhenExpressionTemplate } from "@queryeer/api/commands/WhenExpressionTypes";
import type { JdbcManagedDriverContribution } from "@queryeer/api/queryengine/JdbcDriverExtension";
import type { SymbolActionTemplateContribution } from "@queryeer/api/queryengine/SymbolActionTemplateContribution";
import type { TreeActionTemplateContribution } from "@queryeer/api/settings/TreeActionTemplateContribution";

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

const NODE_IS_MYSQL = `node.dialectId == '${DIALECT_ID}'`;
const FILE_IS_MYSQL = `activeFile.mimeType == 'application/sql' && activeFile.metadata.core.queryengine.jdbc?.dialectId == '${DIALECT_ID}'`;

/**
 * A tree node's name quoted for MySQL. A table, view, procedure or trigger node carries its database as `catalog`
 * (see the backend's MySqlSchemaResolvers).
 */
const NODE_QUALIFIED_NAME = "`${node.attributes.catalog}`.`${node.name}`";

export const TREE_ACTION_TEMPLATES: TreeActionTemplateContribution[] = [
  {
    id: `${PLUGIN_ID}.treeAction.selectTop100`,
    title: "MySQL: Select Top 100 Rows",
    description: "Select the first 100 rows of a table or view",
    order: 13,
    action: {
      label: "Select Top 100 Rows",
      when: `${NODE_IS_MYSQL} && (node.kind == 'table' || node.kind == 'view')`,
      query: `select * from ${NODE_QUALIFIED_NAME} limit 100`,
      mode: "execute",
      outputTarget: "output"
    }
  },
  {
    id: `${PLUGIN_ID}.treeAction.showCreate`,
    title: "MySQL: Show Create Statement",
    description: "Show the CREATE statement of a table, view, procedure or trigger",
    order: 14,
    action: {
      label: "Show Create Statement",
      when: `${NODE_IS_MYSQL} && (node.kind == 'table' || node.kind == 'view' || node.kind == 'procedure' || node.kind == 'trigger')`,
      // The node kinds are MySQL's own keywords: SHOW CREATE TABLE / VIEW / PROCEDURE / TRIGGER
      query: `show create \${node.kind} ${NODE_QUALIFIED_NAME}`,
      mode: "execute",
      outputTarget: "output"
    }
  }
];

export const SYMBOL_ACTION_TEMPLATES: SymbolActionTemplateContribution[] = [
  {
    id: `${PLUGIN_ID}.symbolAction.describe`,
    title: "MySQL Describe",
    description: "Describe the columns of a table or view in MySQL or MariaDB",
    order: 10,
    action: {
      label: "Describe",
      when: `${FILE_IS_MYSQL} && (symbol.kind == 'table' || symbol.kind == 'view')`,
      // Without a database in the symbol, the file's current database
      query: "SELECT column_name, column_type, is_nullable, column_key, column_default FROM information_schema.columns"
        + " WHERE table_schema = COALESCE(NULLIF('${symbol.attributes.schema || ''}', ''), DATABASE())"
        + " AND table_name = '${symbol.attributes.name || symbol.name}' ORDER BY ordinal_position"
    }
  }
];

export const WHEN_EXPRESSION_TEMPLATES: WhenExpressionTemplate[] = [
  {
    name: "MySQL / MariaDB Database",
    description: "Match SQL files using MySQL or MariaDB against a specific selected database",
    when: `${FILE_IS_MYSQL} && activeFile.metadata.core.queryengine.jdbc?.database == 'my_database'`
  }
];

let disposables: Disposable[] = [];

/**
 * Registers the driver and the templates users can create actions from. The connection form comes from the
 * backend's `connectionSetup()` fields, and the database tree from its schema resolvers.
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
    disposables = [
      ...TREE_ACTION_TEMPLATES.map((template) => context.jdbcTreeActions.registerTemplate(template)),
      ...SYMBOL_ACTION_TEMPLATES.map((template) => context.symbolActions.registerTemplate(template)),
      context.whenExpressions.registerTemplates(WHEN_EXPRESSION_TEMPLATES)
    ];
  },

  deactivate: () => {
    for (const disposable of disposables.splice(0)) {
      disposable.dispose();
    }
  }
};

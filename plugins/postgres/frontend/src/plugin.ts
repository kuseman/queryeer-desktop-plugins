import type { Disposable } from "@queryeer/api/editor/EditorApi";
import type { WhenExpressionTemplate } from "@queryeer/api/commands/WhenExpressionTypes";
import type { ExternalPlugin } from "@queryeer/api/plugin/PluginModule";
import type { JdbcManagedDriverContribution } from "@queryeer/api/queryengine/JdbcDriverExtension";
import type { SymbolActionTemplateContribution } from "@queryeer/api/queryengine/SymbolActionTemplateContribution";
import type { TreeActionTemplateContribution } from "@queryeer/api/settings/TreeActionTemplateContribution";

// The backend uses the same values (plugin.json, PostgresDialect.DIALECT_ID, PostgresDialectContributor.DRIVER_CLASS_NAME)
export const PLUGIN_ID = "com.queryeer.jdbc.postgres";
export const DIALECT_ID = "postgres";

/** pgJDBC. Never bundled: core downloads it from Maven Central after the user confirms, and the backend loads it from there. */
export const POSTGRES_DRIVER: JdbcManagedDriverContribution = {
  dialectId: DIALECT_ID,
  displayName: "PostgreSQL JDBC Driver",
  groupId: "org.postgresql",
  artifactId: "postgresql",
  driverClassName: "org.postgresql.Driver",
  downloadPageUrl: "https://jdbc.postgresql.org/download/"
};

const NODE_IS_POSTGRES = `node.dialectId == '${DIALECT_ID}'`;
const FILE_IS_POSTGRES = `activeFile.mimeType == 'application/sql' && activeFile.metadata.core.queryengine.jdbc?.dialectId == '${DIALECT_ID}'`;

export const TREE_ACTION_TEMPLATES: TreeActionTemplateContribution[] = [
  {
    id: `${PLUGIN_ID}.treeAction.selectTop100`,
    title: "PostgreSQL: Select Top 100 Rows",
    description: "Select top 100 rows from a table or view",
    order: 13,
    action: {
      label: "Select Top 100 Rows",
      when: `${NODE_IS_POSTGRES} && (node.kind == 'table' || node.kind == 'view')`,
      query: "select * from ${node.fullName} limit 100",
      mode: "execute",
      outputTarget: "output"
    }
  }
];

export const SYMBOL_ACTION_TEMPLATES: SymbolActionTemplateContribution[] = [
  {
    id: `${PLUGIN_ID}.symbolAction.describe`,
    title: "PostgreSQL Describe",
    description: "Describe a table or view in PostgreSQL",
    order: 10,
    action: {
      label: "Describe",
      when: `${FILE_IS_POSTGRES} && (symbol.kind == 'table' || symbol.kind == 'view')`,
      query: "SELECT column_name, data_type, is_nullable, ordinal_position FROM information_schema.columns WHERE table_schema = '${symbol.attributes.schema}' AND table_name = '${symbol.attributes.name || symbol.name}' ORDER BY ordinal_position"
    }
  }
];

export const WHEN_EXPRESSION_TEMPLATES: WhenExpressionTemplate[] = [
  {
    name: "PostgreSQL Database",
    description: "Match SQL files using PostgreSQL against a specific selected database",
    when: `${FILE_IS_POSTGRES} && activeFile.metadata.core.queryengine.jdbc?.database == 'postgres'`
  }
];

let disposables: Disposable[] = [];

/**
 * Registers pgJDBC, the dialect's query plans, and its tree action, symbol action and when-expression templates. The
 * connection form comes from the backend's `connectionSetup()` fields, and the database tree from its schema resolvers.
 * Estimated Plan and the Actual Plan toggle are core's, turned on by `supportsQueryPlan`; the backend runs
 * `EXPLAIN (FORMAT JSON)` and returns the plan graph.
 */
export const postgresPlugin: ExternalPlugin = {
  manifest: {
    kind: "feature",
    dependencies: ["core.queryengine.jdbc"]
  },

  activate: (context) => {
    context.jdbcDrivers.registerDriver(POSTGRES_DRIVER);
    disposables = [
      context.jdbcDialects.registerDialect({ dialectId: DIALECT_ID, supportsQueryPlan: true }),
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

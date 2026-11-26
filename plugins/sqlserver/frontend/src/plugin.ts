import type { Disposable } from "@queryeer/api/editor/EditorApi";
import type { WhenExpressionTemplate } from "@queryeer/api/commands/WhenExpressionTypes";
import type { PluginContext } from "@queryeer/api/plugin/Plugin";
import type { ExternalPlugin } from "@queryeer/api/plugin/PluginModule";
import type { JdbcManagedDriverContribution } from "@queryeer/api/queryengine/JdbcDriverExtension";
import type { SymbolActionTemplateContribution } from "@queryeer/api/queryengine/SymbolActionTemplateContribution";
import type { SettingsContribution } from "@queryeer/api/settings/SettingsExtension";
import type { TreeActionTemplateContribution } from "@queryeer/api/settings/TreeActionTemplateContribution";

// The backend uses the same values (plugin.json, SqlServerDialect's id, SqlServerDialectContributor.DRIVER_CLASS_NAME)
export const PLUGIN_ID = "com.queryeer.jdbc.sqlserver";
export const DIALECT_ID = "sqlserver";

export const SETTINGS_MODULE_ID = PLUGIN_ID;
export const PLAN_XML_OUTPUT_SETTING_ID = `${PLUGIN_ID}.planXmlOutput`;
/** Where Queryeer kept the setting while SQL Server was built in. */
export const LEGACY_SETTINGS_MODULE_ID = "core.queryengine.jdbc";
export const LEGACY_PLAN_XML_OUTPUT_SETTING_ID = "core.queryengine.jdbc.sqlserver.planXmlOutput";
export const MIGRATION_ID = "plan-xml-output-from-core.v1";

/**
 * Microsoft's JDBC driver, and on Windows its native authentication library, which Windows authentication needs. Never
 * bundled: core downloads the driver from Maven Central, and the library from the driver's GitHub release, after the
 * user confirms. The library's version must match the driver's.
 */
export const SQLSERVER_DRIVER: JdbcManagedDriverContribution = {
  dialectId: DIALECT_ID,
  displayName: "Microsoft JDBC Driver for SQL Server",
  groupId: "com.microsoft.sqlserver",
  artifactId: "mssql-jdbc",
  driverClassName: "com.microsoft.sqlserver.jdbc.SQLServerDriver",
  compatibleVersionRegex: "\\.jre11$",
  downloadPageUrl: "https://learn.microsoft.com/sql/connect/jdbc/download-microsoft-jdbc-driver-for-sql-server",
  companionArtifacts: [{
    id: "native-auth",
    displayName: "Windows Native Authentication",
    kind: "nativeLibrary",
    platforms: [
      { os: "windows", arch: "x64" },
      { os: "windows", arch: "x86" }
    ],
    source: {
      type: "githubReleaseArchive",
      repository: "microsoft/mssql-jdbc",
      releaseTagTemplate: "v{releaseVersion}",
      assetName: "mssql-jdbc_auth.zip",
      driverVersionToReleaseVersion: { pattern: "^([0-9]+\\.[0-9]+\\.[0-9]+)\\.jre[0-9]+$", replacement: "$1" },
      archiveEntryTemplate: "{arch}/mssql-jdbc_auth-{releaseVersion}.{arch}.dll"
    },
    targetDirectory: "libNative",
    expectedFileExtension: ".dll",
    versionLockedToDriver: true
  }]
};

const NODE_IS_SQLSERVER = `node.dialectId == '${DIALECT_ID}'`;
const FILE_IS_SQLSERVER = `activeFile.mimeType == 'application/sql' && activeFile.metadata.core.queryengine.jdbc?.dialectId == '${DIALECT_ID}'`;

// `fn.sqlserver.identifier` brackets a name ([a]]b] for a]b). Queryeer registers it, so the actions users made from these
// templates while SQL Server was built in keep working. The plugin can't register it too: a name registers once.
export const SYMBOL_ACTION_TEMPLATES: SymbolActionTemplateContribution[] = [
  {
    id: `${PLUGIN_ID}.symbolAction.describe`,
    title: "SQLServer Describe",
    description: "Describe a table, view or procedure in SQL Server",
    order: 10,
    action: {
      label: "Describe",
      when: `${FILE_IS_SQLSERVER} && (symbol.kind == 'table' || symbol.kind == 'view' || symbol.kind == 'procedure')`,
      query: "${symbol.attributes.database ? `exec ${fn.sqlserver.identifier(symbol.attributes.database)}.sys.sp_help ${fn.sql.literal(symbol.name)}` : `exec sp_help ${fn.sql.literal(symbol.name)}`}"
    }
  },
  {
    id: `${PLUGIN_ID}.symbolAction.definition`,
    title: "SQLServer Procedure Definition",
    description: "Show a procedure's full source (sys.sql_modules, no 255-char line splitting like sp_helptext) in the text output",
    order: 11,
    action: {
      label: "Definition",
      when: `${FILE_IS_SQLSERVER} && symbol.kind == 'procedure'`,
      query: "${symbol.attributes.database && symbol.attributes.name ? `select definition from ${fn.sqlserver.identifier(symbol.attributes.database)}.sys.sql_modules where object_id = object_id(${fn.sql.literal(fn.sqlserver.identifier(symbol.attributes.database) + '.' + (symbol.attributes.schema ? fn.sqlserver.identifier(symbol.attributes.schema) : '') + '.' + fn.sqlserver.identifier(symbol.attributes.name))})` : `select object_definition(object_id(${fn.sql.literal(symbol.fullName)})) as definition`}",
      outputId: "core.queryengine.output.text"
    }
  }
];

export const TREE_ACTION_TEMPLATES: TreeActionTemplateContribution[] = [
  {
    id: `${PLUGIN_ID}.treeAction.definitionToText`,
    title: "SQL Server: Procedure Definition to Text",
    description: "Show the procedure's full source (object_definition) in text output",
    order: 10,
    action: {
      label: "Definition to Text",
      when: `${NODE_IS_SQLSERVER} && node.kind == 'procedure'`,
      query: "select object_definition(object_id(${fn.sql.literal(node.fullName)})) as definition",
      mode: "execute",
      outputTarget: "output",
      outputId: "core.queryengine.output.text"
    }
  },
  {
    id: `${PLUGIN_ID}.treeAction.definitionToNewQuery`,
    title: "SQL Server: Procedure Definition to New Query",
    description: "Open the procedure's full source (object_definition) in a new query file",
    order: 11,
    action: {
      label: "Definition to New Query",
      when: `${NODE_IS_SQLSERVER} && node.kind == 'procedure'`,
      query: "select object_definition(object_id(${fn.sql.literal(node.fullName)})) as definition",
      mode: "execute",
      outputTarget: "newQuery"
    }
  },
  {
    id: `${PLUGIN_ID}.treeAction.help`,
    title: "SQL Server: Object Help",
    description: "Run sp_help on database objects",
    order: 12,
    action: {
      label: "Help",
      when: `${NODE_IS_SQLSERVER} && (node.kind == 'table' || node.kind == 'view' || node.kind == 'procedure')`,
      query: "exec sp_help '${node.fullName}'",
      mode: "execute",
      outputTarget: "output"
    }
  },
  {
    id: `${PLUGIN_ID}.treeAction.selectTop100`,
    title: "SQL Server: Select Top 100 Rows",
    description: "Select top 100 rows from a table or view",
    order: 13,
    action: {
      label: "Select Top 100 Rows",
      when: `${NODE_IS_SQLSERVER} && (node.kind == 'table' || node.kind == 'view')`,
      query: "select top 100 * from ${node.fullName}",
      mode: "execute",
      outputTarget: "output"
    }
  }
];

export const WHEN_EXPRESSION_TEMPLATES: WhenExpressionTemplate[] = [
  {
    name: "SQLServer Database",
    description: "Match SQL files using SQL Server against a specific selected database",
    when: `${FILE_IS_SQLSERVER} && activeFile.metadata.core.queryengine.jdbc?.database == 'OrderService'`
  }
];

export const SETTINGS: SettingsContribution = {
  moduleId: SETTINGS_MODULE_ID,
  title: "SQL Server",
  order: 32,
  settings: [
    {
      id: PLAN_XML_OUTPUT_SETTING_ID,
      moduleId: SETTINGS_MODULE_ID,
      title: "SQL Server Plan XML Output",
      description: "Controls whether SQL Server query plan XML result sets are also shown as raw query output when plan graph artifacts are produced.",
      sectionPath: ["Query Engine", "SQL Databases", "SQL Server"],
      tags: ["jdbc", "sqlserver", "plan", "showplan"],
      type: "enum",
      defaultValue: "suppress",
      options: [
        { label: "Suppress raw XML", value: "suppress" },
        { label: "Include raw XML", value: "include" }
      ]
    }
  ]
};

/**
 * Copies the plan XML setting from where Queryeer kept it while SQL Server was built in, once per installation. Only
 * "include" needs copying: "suppress" is the default. Queryeer's own settings are left as they are.
 */
export async function migratePlanXmlOutput(settings: PluginContext["settings"]): Promise<void> {
  const legacy = (await settings.readModuleValues(LEGACY_SETTINGS_MODULE_ID))[LEGACY_PLAN_XML_OUTPUT_SETTING_ID];
  if (legacy !== "include" || settings.getValue(PLAN_XML_OUTPUT_SETTING_ID) === "include") {
    return;
  }
  const result = await settings.setValue(PLAN_XML_OUTPUT_SETTING_ID, "include");
  if (!result.ok) {
    // Runs again on the next start
    throw new Error(result.message);
  }
}

let disposables: Disposable[] = [];

/**
 * Registers Microsoft's driver with its native authentication library, the dialect's query plans, its plan XML setting,
 * and its tree action, symbol action and when-expression templates. The connection form comes from the backend's
 * `connectionSetup()` fields, and the database tree from its schema resolvers. Estimated Plan and the Actual Plan toggle
 * are core's, turned on by `supportsQueryPlan`; the backend runs the batches with SHOWPLAN_XML or STATISTICS XML and
 * returns the plan graph.
 */
export const sqlServerPlugin: ExternalPlugin = {
  manifest: {
    kind: "feature",
    dependencies: ["core.queryengine.jdbc"]
  },

  activate: (context) => {
    context.jdbcDrivers.registerDriver(SQLSERVER_DRIVER);
    disposables = [
      context.jdbcDialects.registerDialect({ dialectId: DIALECT_ID, supportsQueryPlan: true }),
      context.settings.registerSettings(SETTINGS),
      ...TREE_ACTION_TEMPLATES.map((template) => context.jdbcTreeActions.registerTemplate(template)),
      ...SYMBOL_ACTION_TEMPLATES.map((template) => context.symbolActions.registerTemplate(template)),
      context.whenExpressions.registerTemplates(WHEN_EXPRESSION_TEMPLATES),
      // Adds the plan XML option to a SQL Server file's plan runs; the backend reads it (SqlServerQueryExecutor)
      context.queryEngines.registerExecutionContextProvider("jdbc", (params) => {
        if (!params.fileId) {
          return undefined;
        }
        const file = context.files.getFile(params.fileId);
        if (file?.metadata?.["core.queryengine.jdbc.dialectId"] !== DIALECT_ID) {
          return undefined;
        }
        const planXmlOutput = context.settings.getValue(PLAN_XML_OUTPUT_SETTING_ID) === "include" ? "include" : "suppress";
        return {
          options: {
            ...params.options,
            dialectOptions: {
              ...(params.options?.dialectOptions ?? {}),
              sqlserverPlanXmlOutput: planXmlOutput
            }
          }
        };
      })
    ];
    context.settings.runOnce(MIGRATION_ID, () => migratePlanXmlOutput(context.settings));
  },

  deactivate: () => {
    for (const disposable of disposables.splice(0)) {
      disposable.dispose();
    }
  }
};

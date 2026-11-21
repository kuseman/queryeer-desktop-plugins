/**
 * What the editor knows about MongoDB's query language, for completion, hover and parameter hints in `.mongo` files. Only what this
 * plugin runs: read commands and the shell methods the backend's ShellParser accepts (writes are rejected before they reach the server).
 */

export type OperatorInfo = { name: string; doc: string };

export type MethodInfo = {
  name: string;
  /** Parameter names, as in mongosh. Optional ones end with `?`. */
  parameters: string[];
  doc: string;
};

const operators = (entries: Record<string, string>): OperatorInfo[] => Object.entries(entries).map(([name, doc]) => ({ name, doc }));

/** Operators on a field's value: `{ total: { $gt: 100 } }`. */
export const QUERY_OPERATORS = operators({
  $eq: "Matches values equal to the given value.",
  $ne: "Matches values not equal to the given value, and documents without the field.",
  $gt: "Matches values greater than the given value.",
  $gte: "Matches values greater than or equal to the given value.",
  $lt: "Matches values less than the given value.",
  $lte: "Matches values less than or equal to the given value.",
  $in: "Matches any of the values in an array.",
  $nin: "Matches none of the values in an array, and documents without the field.",
  $exists: "Matches documents that have the field (`true`) or don't (`false`).",
  $type: "Matches values of a BSON type, by name (`\"string\"`) or number.",
  $regex: "Matches strings against a regular expression. Options go in `$options`.",
  $options: "Options for `$regex`: `i` (case-insensitive), `m`, `x`, `s`.",
  $all: "Matches arrays that contain all of the given elements.",
  $elemMatch: "Matches arrays with at least one element matching all of the given conditions.",
  $size: "Matches arrays with exactly this many elements.",
  $mod: "Matches numbers whose remainder is `[divisor, remainder]`.",
  $not: "Matches values that don't match the given operator expression.",
  $bitsAllSet: "Matches numbers or binary data with all of the given bits set.",
  $bitsAnySet: "Matches numbers or binary data with any of the given bits set.",
  $bitsAllClear: "Matches numbers or binary data with all of the given bits clear.",
  $bitsAnyClear: "Matches numbers or binary data with any of the given bits clear.",
  $geoWithin: "Matches geometries within a shape.",
  $geoIntersects: "Matches geometries that intersect a GeoJSON geometry.",
  $near: "Sorts by distance from a point, nearest first (needs a geospatial index).",
  $nearSphere: "Sorts by spherical distance from a point, nearest first (needs a geospatial index)."
});

/** Operators at the top of a filter: `{ $or: [ … ] }`. */
export const FILTER_OPERATORS = operators({
  $and: "Matches documents that match all of the filters in an array.",
  $or: "Matches documents that match any of the filters in an array.",
  $nor: "Matches documents that match none of the filters in an array.",
  $expr: "Matches documents for which an aggregation expression is true, e.g. comparing two fields.",
  $text: "Full-text search over the collection's text index: `{ $search: \"words\" }`.",
  $jsonSchema: "Matches documents that are valid against a JSON Schema.",
  $where: "Matches documents for which a JavaScript expression is true. Slow: runs JavaScript on the server for each document.",
  $comment: "A comment, shown in logs and profiler output."
});

/** Aggregation pipeline stages this plugin runs ($out and $merge write, and are rejected). */
export const STAGES = operators({
  $match: "Keeps the documents that match a filter.",
  $project: "Includes, excludes or computes fields.",
  $addFields: "Adds computed fields.",
  $set: "Adds computed fields (an alias of `$addFields`).",
  $unset: "Removes fields.",
  $group: "Groups documents by `_id` and computes accumulators per group.",
  $sort: "Sorts documents: `{ field: 1 }` ascending, `-1` descending.",
  $limit: "Passes on at most this many documents.",
  $skip: "Skips this many documents.",
  $count: "Counts the documents into a field with the given name.",
  $unwind: "Outputs one document per element of an array field.",
  $lookup: "Joins documents from another collection of the same database.",
  $graphLookup: "Recursively joins documents from a collection, e.g. a tree.",
  $unionWith: "Adds the documents of another collection (or pipeline).",
  $facet: "Runs several pipelines over the same documents.",
  $bucket: "Groups documents into buckets by boundaries.",
  $bucketAuto: "Groups documents into a number of evenly filled buckets.",
  $sortByCount: "Groups by an expression and sorts by the count of each group.",
  $replaceRoot: "Replaces each document with an embedded document.",
  $replaceWith: "Replaces each document with an expression (an alias of `$replaceRoot`).",
  $sample: "Picks this many random documents: `{ size: n }`.",
  $redact: "Keeps or prunes parts of documents by an expression.",
  $setWindowFields: "Computes window functions over sorted partitions.",
  $densify: "Fills gaps in a sequence of numbers or dates.",
  $fill: "Fills null and missing field values.",
  $geoNear: "Sorts by distance from a point (must be the first stage).",
  $collStats: "Statistics about the collection (must be the first stage).",
  $indexStats: "Usage statistics of the collection's indexes (must be the first stage)."
});

/** Accumulators of `$group` (and window functions of `$setWindowFields`). */
export const ACCUMULATORS = operators({
  $sum: "The sum of numeric values; `{ $sum: 1 }` counts.",
  $avg: "The average of numeric values.",
  $min: "The smallest value.",
  $max: "The largest value.",
  $first: "The value of the group's first document.",
  $last: "The value of the group's last document.",
  $push: "An array of all values.",
  $addToSet: "An array of the distinct values.",
  $count: "The number of documents in the group: `{ $count: {} }`.",
  $mergeObjects: "The documents merged into one.",
  $stdDevPop: "The population standard deviation.",
  $stdDevSamp: "The sample standard deviation.",
  $top: "The top element of the group by `sortBy`.",
  $bottom: "The bottom element of the group by `sortBy`.",
  $topN: "The top `n` elements of the group by `sortBy`.",
  $bottomN: "The bottom `n` elements of the group by `sortBy`.",
  $firstN: "The first `n` values.",
  $lastN: "The last `n` values.",
  $maxN: "The `n` largest values.",
  $minN: "The `n` smallest values."
});

/** Common aggregation expression operators. */
export const EXPRESSION_OPERATORS = operators({
  $add: "Adds numbers, or a number of milliseconds to a date.",
  $subtract: "Subtracts numbers or dates.",
  $multiply: "Multiplies numbers.",
  $divide: "Divides one number by another.",
  $mod: "The remainder of a division.",
  $abs: "The absolute value.",
  $round: "Rounds to a number of decimals.",
  $concat: "Concatenates strings.",
  $toUpper: "A string in upper case.",
  $toLower: "A string in lower case.",
  $substrCP: "Part of a string, by code points.",
  $split: "Splits a string into an array.",
  $trim: "A string without leading and trailing whitespace.",
  $regexMatch: "Whether a string matches a regular expression.",
  $dateToString: "A date formatted as a string.",
  $dateFromString: "A date parsed from a string.",
  $year: "The year of a date.",
  $month: "The month of a date (1–12).",
  $dayOfMonth: "The day of the month of a date (1–31).",
  $toString: "A value converted to a string.",
  $toInt: "A value converted to an int.",
  $toDouble: "A value converted to a double.",
  $toDate: "A value converted to a date.",
  $toObjectId: "A value converted to an ObjectId.",
  $type: "The BSON type name of a value.",
  $cond: "`if`/`then`/`else`: one of two values by a condition.",
  $ifNull: "The first value that isn't null or missing.",
  $switch: "The value of the first matching branch.",
  $eq: "Whether two values are equal.",
  $ne: "Whether two values differ.",
  $gt: "Whether the first value is greater.",
  $gte: "Whether the first value is greater or equal.",
  $lt: "Whether the first value is less.",
  $lte: "Whether the first value is less or equal.",
  $and: "Whether all expressions are true.",
  $or: "Whether any expression is true.",
  $not: "The opposite of an expression.",
  $in: "Whether a value is in an array.",
  $size: "The number of elements of an array.",
  $arrayElemAt: "The element at an index of an array.",
  $filter: "The elements of an array that match a condition.",
  $map: "Applies an expression to each element of an array.",
  $reduce: "Combines the elements of an array into one value.",
  $slice: "Part of an array.",
  $concatArrays: "Concatenates arrays.",
  $objectToArray: "A document as an array of `{ k, v }`.",
  $arrayToObject: "An array of `{ k, v }` (or pairs) as a document.",
  $literal: "A value as is, not parsed as an expression.",
  $getField: "The value of a field, also one whose name has `.` or `$`."
});

/** Every operator name, for completion and hover where the context isn't known. */
export const ALL_OPERATORS: OperatorInfo[] = (() => {
  const seen = new Map<string, OperatorInfo>();
  for (const info of [...STAGES, ...FILTER_OPERATORS, ...QUERY_OPERATORS, ...ACCUMULATORS, ...EXPRESSION_OPERATORS]) {
    if (!seen.has(info.name)) {
      seen.set(info.name, info);
    }
  }
  return [...seen.values()];
})();

/** Methods on `db`. */
export const DATABASE_METHODS: MethodInfo[] = [
  { name: "getCollection", parameters: ["name"], doc: "A collection by name, also one whose name isn't a plain identifier." },
  { name: "getSiblingDB", parameters: ["database"], doc: "Another database on the same connection." },
  { name: "runCommand", parameters: ["command"], doc: "Runs a database command, e.g. `{ dbStats: 1 }`. Only read commands are allowed." },
  { name: "adminCommand", parameters: ["command"], doc: "Runs a command against the `admin` database. Only read commands are allowed." },
  { name: "getCollectionNames", parameters: [], doc: "The names of the database's collections." },
  { name: "getCollectionInfos", parameters: ["filter?"], doc: "The database's collections, with their options." },
  { name: "stats", parameters: ["scale?"], doc: "Statistics about the database." }
];

/** Methods on a collection. */
export const COLLECTION_METHODS: MethodInfo[] = [
  { name: "find", parameters: ["filter?", "projection?", "options?"], doc: "The documents that match a filter." },
  { name: "findOne", parameters: ["filter?", "projection?", "options?"], doc: "The first document that matches a filter." },
  { name: "aggregate", parameters: ["pipeline", "options?"], doc: "Runs an aggregation pipeline: an array of stages." },
  { name: "countDocuments", parameters: ["filter?", "options?"], doc: "The number of documents that match a filter." },
  { name: "estimatedDocumentCount", parameters: ["options?"], doc: "The collection's document count from its metadata: fast, but approximate." },
  { name: "count", parameters: ["filter?", "options?"], doc: "The number of documents that match a filter (deprecated in mongosh; prefer `countDocuments`)." },
  { name: "distinct", parameters: ["field", "filter?", "options?"], doc: "The distinct values of a field." },
  { name: "getIndexes", parameters: [], doc: "The collection's indexes." },
  { name: "getIndexSpecs", parameters: [], doc: "The collection's indexes (an alias of `getIndexes`)." },
  { name: "stats", parameters: ["scale?"], doc: "Statistics about the collection." },
  { name: "explain", parameters: ["verbosity?"], doc: "Explains the next call instead of running it: `queryPlanner`, `executionStats` or `allPlansExecution`." }
];

/** Methods on the cursor `find` returns. */
export const CURSOR_METHODS: MethodInfo[] = [
  { name: "sort", parameters: ["sort"], doc: "Sorts the documents: `{ field: 1 }` ascending, `-1` descending." },
  { name: "limit", parameters: ["count"], doc: "Returns at most this many documents." },
  { name: "skip", parameters: ["count"], doc: "Skips this many documents." },
  { name: "projection", parameters: ["projection"], doc: "Includes (`1`) or excludes (`0`) fields." },
  { name: "hint", parameters: ["index"], doc: "Uses this index, by name or key pattern." },
  { name: "collation", parameters: ["collation"], doc: "Compares strings by language rules, e.g. `{ locale: \"sv\", strength: 2 }`." },
  { name: "comment", parameters: ["comment"], doc: "A comment, shown in logs and profiler output." },
  { name: "maxTimeMS", parameters: ["milliseconds"], doc: "Stops the query after this long on the server." },
  { name: "batchSize", parameters: ["size"], doc: "The number of documents per batch from the server." },
  { name: "allowDiskUse", parameters: ["allow?"], doc: "Lets a large sort use temporary files." },
  { name: "min", parameters: ["indexBounds"], doc: "The inclusive lower bound of the index to use." },
  { name: "max", parameters: ["indexBounds"], doc: "The exclusive upper bound of the index to use." },
  { name: "returnKey", parameters: ["enabled"], doc: "Returns only the index keys." },
  { name: "showRecordId", parameters: ["enabled?"], doc: "Adds each document's record id." },
  { name: "noCursorTimeout", parameters: [], doc: "Keeps an idle cursor open on the server." },
  { name: "count", parameters: ["applySkipLimit?"], doc: "The number of matching documents, instead of the documents." },
  { name: "size", parameters: [], doc: "The number of matching documents after `skip` and `limit`, instead of the documents." },
  { name: "explain", parameters: ["verbosity?"], doc: "Explains the query instead of running it: `queryPlanner`, `executionStats` or `allPlansExecution`." },
  { name: "pretty", parameters: [], doc: "Accepted for mongosh compatibility; changes nothing." },
  { name: "toArray", parameters: [], doc: "Accepted for mongosh compatibility; changes nothing." }
];

/** What the backend accepts after a call: every cursor method after `find`, `batchSize` after `aggregate`, and otherwise neither. */
export function cursorMethodsAfter(kind: "find" | "aggregate" | "other"): MethodInfo[] {
  if (kind === "find") {
    return CURSOR_METHODS;
  }
  const allowed = kind === "aggregate" ? ["batchSize", "explain", "pretty", "toArray"] : ["explain", "pretty", "toArray"];
  return CURSOR_METHODS.filter((method) => allowed.includes(method.name));
}

/** The commands whose first value names a collection. */
export const COLLECTION_COMMANDS: ReadonlySet<string> = new Set(["find", "aggregate", "count", "distinct", "listIndexes", "collStats"]);

/** The top-level keys of a JSON command document, by command. */
export const COMMANDS: Record<string, string[]> = {
  find: ["filter", "projection", "sort", "limit", "skip", "hint", "collation", "comment", "maxTimeMS", "batchSize", "allowDiskUse"],
  aggregate: ["pipeline", "cursor", "allowDiskUse", "hint", "collation", "comment", "maxTimeMS"],
  count: ["query", "limit", "skip", "hint", "collation", "comment", "maxTimeMS"],
  distinct: ["key", "query", "collation", "comment", "maxTimeMS"],
  listCollections: ["filter", "nameOnly", "authorizedCollections"],
  listIndexes: [],
  listDatabases: ["filter", "nameOnly"],
  collStats: ["scale"],
  dbStats: ["scale"],
  explain: ["verbosity"],
  ping: [],
  buildInfo: []
};

export const COMMAND_DOCS: Record<string, string> = {
  find: "Finds the documents of a collection that match `filter`.",
  aggregate: "Runs an aggregation `pipeline` over a collection.",
  count: "Counts the documents of a collection that match `query`.",
  distinct: "The distinct values of the field `key`.",
  listCollections: "The database's collections.",
  listIndexes: "A collection's indexes.",
  listDatabases: "The connection's databases.",
  collStats: "Statistics about a collection.",
  dbStats: "Statistics about the database.",
  explain: "Explains a command instead of running it.",
  ping: "Checks that the server answers.",
  buildInfo: "The server's version and build."
};

export function findMethod(name: string, receiver: "db" | "collection" | "cursor"): MethodInfo | undefined {
  const methods = receiver === "db" ? DATABASE_METHODS : receiver === "collection" ? COLLECTION_METHODS : CURSOR_METHODS;
  return methods.find((method) => method.name === name);
}

export function signatureLabel(method: MethodInfo): string {
  return `${method.name}(${method.parameters.join(", ")})`;
}

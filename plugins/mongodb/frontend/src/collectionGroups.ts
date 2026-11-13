// Groups a database's collections into the explorer's folders: Collections, Views, System.

export type CollectionInfo = {
  name: string;
  type: string;
  count: number | null;
  viewOn?: string;
  pipeline?: string;
  timeField?: string;
  metaField?: string;
  granularity?: string;
  /** Validation rules as JSON, when the collection has any. Level and action default to "strict" and "error". */
  validator?: string;
  validationLevel?: string;
  validationAction?: string;
};

/** One node in a folder. `name` is the collection that actions run against; `label` is what the tree shows. */
export type CollectionEntry = {
  name: string;
  label: string;
  info: CollectionInfo;
  /** Set for a GridFS bucket shown as one node: `<bucket>.files` is browsed, `<bucket>.chunks` is hidden. */
  gridFsBucket?: string;
};

export type CollectionGroups = {
  collections: CollectionEntry[];
  views: CollectionEntry[];
  system: CollectionEntry[];
};

/**
 * - `system.*` (profile, views, js, time-series buckets) goes to System.
 * - Views go to Views.
 * - A GridFS bucket (`X.files` + `X.chunks`) becomes one Collections node "X". Its actions use `X.files`.
 * - Everything else, including time-series collections, goes to Collections.
 * The backend's order (by name) is kept.
 */
export function groupCollections(items: readonly CollectionInfo[]): CollectionGroups {
  const names = new Set(items.map((item) => item.name));
  const groups: CollectionGroups = { collections: [], views: [], system: [] };

  for (const info of items) {
    const { name } = info;
    if (name.startsWith("system.")) {
      groups.system.push({ name, label: name, info });
      continue;
    }
    if (info.type === "view") {
      groups.views.push({ name, label: name, info });
      continue;
    }
    const bucket = gridFsBucketOf(name);
    if (bucket !== undefined && names.has(`${bucket}.files`) && names.has(`${bucket}.chunks`)) {
      if (name.endsWith(".files")) {
        groups.collections.push({ name, label: bucket, info, gridFsBucket: bucket });
      }
      // <bucket>.chunks is represented by the bucket node
      continue;
    }
    groups.collections.push({ name, label: name, info });
  }
  return groups;
}

function gridFsBucketOf(name: string): string | undefined {
  const match = /^(.+)\.(files|chunks)$/.exec(name);
  return match ? match[1] : undefined;
}

/** Tooltip text describing what a node is. */
export function describeEntry(entry: CollectionEntry): string {
  const { info } = entry;
  const lines: string[] = [];
  if (entry.gridFsBucket !== undefined) {
    lines.push(`GridFS bucket "${entry.gridFsBucket}": files in ${entry.gridFsBucket}.files, data in ${entry.gridFsBucket}.chunks`);
  } else if (info.type === "view") {
    lines.push(`View on ${info.viewOn ?? "?"}`);
    if (info.pipeline) {
      lines.push(`Pipeline: ${info.pipeline}`);
    }
  } else if (info.type === "timeseries") {
    lines.push(`Time series: time field "${info.timeField ?? "?"}"${info.metaField ? `, meta field "${info.metaField}"` : ""}${info.granularity ? `, granularity ${info.granularity}` : ""}`);
  }
  if (info.count !== null) {
    lines.push(`${info.count.toLocaleString()} documents (estimate)`);
  }
  return lines.join("\n");
}

/**
 * Badge for a validator that is enforced differently from the default (strict level, reject invalid writes),
 * e.g. "warn" or "moderate, warn"; undefined otherwise.
 */
export function validationBadge(info: CollectionInfo): string | undefined {
  const parts: string[] = [];
  if (info.validationLevel && info.validationLevel !== "strict") {
    parts.push(info.validationLevel);
  }
  if (info.validationAction && info.validationAction !== "error") {
    parts.push(info.validationAction);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Short badge for the tree row, or undefined for a plain collection. */
export function badgeFor(entry: CollectionEntry): string | undefined {
  if (entry.gridFsBucket !== undefined) {
    return "GridFS";
  }
  switch (entry.info.type) {
    case "view":
      return "view";
    case "timeseries":
      return "time series";
    default:
      return undefined;
  }
}

/**
 * What the text before a cursor in a `.mongo` file is in, for completion, hover and parameter hints: a `db.…` chain, an object key or
 * value, a call's arguments, a string. Works on half-typed text and never throws. Covers both forms a file holds: shell statements and
 * JSON command documents.
 */

/** What an object, array or argument holds, which decides what to offer in it. */
export type Role =
  | "filter"
  | "filterList"
  | "fieldCondition"
  | "projection"
  | "sort"
  | "pipeline"
  | "stage"
  | "facet"
  | "group"
  | "accumulator"
  | "expression"
  | "lookup"
  | "unionWith"
  | "command"
  | "commandList"
  | "unknown";

export type Receiver = "db" | "path" | "collection" | "cursor";

/** What a call chain's result came from: `find`/`findOne` take every cursor method, `aggregate` only `batchSize`, the rest neither. */
export type CursorKind = "find" | "aggregate" | "other";

/** The database and collection a statement works on, as far as the text says. */
export type Target = { database?: string; collection?: string };

export type CallInfo = { name: string; receiver: Receiver; argIndex: number };

export type CursorContext = {
  /** The partial word before the cursor: a name (with `$` and, for keys, `.`), or a string's text up to the cursor. */
  prefix: string;
  /** Where the prefix starts, an offset into the text. */
  prefixFrom: number;
  /** Set when the cursor is inside a string that isn't closed before it: the quote character and its offset. */
  inString?: { quote: string; from: number };
  /** Set right after `db.`, `db.name.` or `).`: what the member is looked up on. */
  member?: {
    receiver: Receiver;
    /** The names after `db.` so far, for a collection named with dots: `db.reports.mo` has `["reports"]`. */
    segments: string[];
    /** Where the first segment starts, or the prefix when there is none. */
    segmentsFrom: number;
    /** The offset of the `.` after `db`, for replacing `.name` with `["name"]`. */
    dotFrom: number;
    /** For a cursor: what it came from. */
    cursorKind?: CursorKind;
    /** Inside `db[…]`: a collection name, which must be quoted. */
    bracket?: boolean;
  };
  /** The innermost object the cursor is in, directly (not inside a nested array or call). */
  object?: { role: Role; expectKey: boolean; key?: string; command?: string };
  /** The innermost array the cursor is in, directly. */
  array?: { role: Role };
  /** The innermost call the cursor is in, at any depth below it. */
  call?: CallInfo;
  /** The direct parent call when the cursor is one of its arguments (not inside an object of it). */
  inCallArguments?: boolean;
  target: Target;
  /** Inside a comment or a regular expression literal: nothing to offer. */
  inComment?: boolean;
};

type Token =
  | { type: "ident"; value: string; from: number; to: number }
  | { type: "string"; value: string; from: number; to: number }
  | { type: "number"; from: number; to: number }
  | { type: "punct"; value: string; from: number; to: number };

type Frame =
  | { kind: "object"; role: Role; expectKey: boolean; key?: string; keyFrom?: number; command?: string; target: Target; joined?: string }
  | { kind: "array"; role: Role; target: Target }
  | { kind: "call"; name: string; receiver: Receiver; argIndex: number; firstString?: string; target: Target; chain?: Chain }
  | { kind: "paren"; target: Target }
  | { kind: "dbBracket"; chain: Chain; value?: string };

type Chain = {
  receiver: Receiver | "done";
  segments: string[];
  segmentsFrom: number;
  dotFrom: number;
  /** Waiting for a member name after `.`. */
  afterDot: boolean;
  target: Target;
  cursorKind?: CursorKind;
};

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

export function cursorContext(text: string, offset: number): CursorContext {
  const end = Math.max(0, Math.min(offset, text.length));
  const scan = tokenize(text, end);
  if (scan.inComment) {
    return { prefix: "", prefixFrom: end, target: {}, inComment: true };
  }
  return interpret(text, scan.tokens, end, scan.openString);
}

type Scan = { tokens: Token[]; openString?: { quote: string; from: number }; inComment?: boolean };

function tokenize(text: string, end: number): Scan {
  const tokens: Token[] = [];
  let i = 0;
  while (i < end) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      if (newline < 0 || newline >= end) {
        return { tokens, inComment: true };
      }
      i = newline + 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0 || close + 2 > end) {
        return { tokens, inComment: true };
      }
      i = close + 2;
    } else if (c === "\"" || c === "'") {
      let j = i + 1;
      let value = "";
      while (j < end && text[j] !== c && text[j] !== "\n") {
        if (text[j] === "\\" && j + 1 < end) {
          value += text[j + 1];
          j += 2;
        } else {
          value += text[j];
          j++;
        }
      }
      if (j >= end) {
        return { tokens, openString: { quote: c, from: i } };
      }
      tokens.push({ type: "string", value, from: i, to: j + 1 });
      i = text[j] === c ? j + 1 : j;
    } else if (c === "/") {
      // A regular expression literal (the language has no division)
      let j = i + 1;
      let inClass = false;
      while (j < end && text[j] !== "\n") {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "[") {
          inClass = true;
        } else if (text[j] === "]") {
          inClass = false;
        } else if (text[j] === "/" && !inClass) {
          break;
        }
        j++;
      }
      if (j >= end) {
        return { tokens, inComment: true };
      }
      if (text[j] === "/") {
        j++;
        while (j < end && /[a-z]/i.test(text[j])) {
          j++;
        }
      }
      tokens.push({ type: "number", from: i, to: j });
      i = j;
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j])) {
        j++;
      }
      // A name that reaches the cursor is the prefix, not a token
      if (j >= end) {
        break;
      }
      tokens.push({ type: "ident", value: text.slice(i, j), from: i, to: j });
      i = j;
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9.]/.test(text[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < end && /[\w.+-]/.test(text[j])) {
        j++;
      }
      tokens.push({ type: "number", from: i, to: j });
      i = j;
    } else {
      tokens.push({ type: "punct", value: c, from: i, to: i + 1 });
      i++;
    }
  }
  return { tokens };
}

function interpret(text: string, tokens: Token[], end: number, openString: Scan["openString"]): CursorContext {
  const stack: Frame[] = [];
  let chain: Chain | undefined;
  let pendingName: Token | undefined;

  const top = (): Frame | undefined => stack[stack.length - 1];
  const currentTarget = (): Target => {
    const frame = top();
    if (frame && frame.kind !== "dbBracket") {
      return frame.target;
    }
    return chain?.target ?? {};
  };

  const openCall = (name: string, receiver: Receiver, target: Target, owner?: Chain) => {
    stack.push({ kind: "call", name, receiver, argIndex: 0, target, chain: owner });
  };

  // A member name after `.` waits for the next token: `(` makes it a call
  const resolvePendingName = (next: Token | undefined) => {
    if (!pendingName || !chain || pendingName.type !== "ident") {
      pendingName = undefined;
      return;
    }
    const name = pendingName.value;
    const from = pendingName.from;
    pendingName = undefined;
    const isCall = next?.type === "punct" && next.value === "(";
    const receiver = chain.receiver;
    if (receiver === "done") {
      return;
    }
    if (!isCall) {
      if (receiver === "db" || receiver === "path") {
        if (chain.segments.length === 0) {
          chain.segmentsFrom = from;
        }
        chain.segments.push(name);
        chain.receiver = "path";
      } else {
        chain.receiver = "done";
      }
      return;
    }
    if (receiver === "path") {
      chain.target = { ...chain.target, collection: chain.segments.join(".") };
      chain.receiver = "collection";
    }
    openCall(name, chain.receiver as Receiver, chain.target, chain);
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (pendingName) {
      resolvePendingName(token);
      if (token.type === "punct" && token.value === "(") {
        continue;
      }
    }
    const frame = top();

    if (token.type === "ident") {
      if (stack.length === 0 && token.value === "db") {
        chain = { receiver: "db", segments: [], segmentsFrom: token.to, dotFrom: token.to, afterDot: false, target: {} };
        continue;
      }
      if (chain && chain.afterDot && stack.length === 0) {
        chain.afterDot = false;
        pendingName = token;
        continue;
      }
      if (frame?.kind === "object" && frame.expectKey) {
        if (frame.key === undefined || frame.keyFrom === undefined) {
          frame.keyFrom = token.from;
        }
        frame.key = text.slice(frame.keyFrom, token.to);
      }
      continue;
    }

    if (token.type === "string") {
      if (frame?.kind === "object") {
        if (frame.expectKey) {
          frame.key = token.value;
          frame.keyFrom = undefined;
        } else if (frame.role === "command" && frame.command !== undefined && frame.key === frame.command && frame.target.collection === undefined) {
          // { "find": "orders", … }
          frame.target = { ...frame.target, collection: token.value };
        } else if ((frame.role === "lookup" && frame.key === "from") || (frame.role === "unionWith" && frame.key === "coll")) {
          frame.joined = token.value;
        }
      } else if (frame?.kind === "call" && frame.argIndex === 0 && frame.firstString === undefined) {
        frame.firstString = token.value;
      } else if (frame?.kind === "dbBracket") {
        frame.value = token.value;
      }
      continue;
    }

    if (token.type === "number") {
      continue;
    }

    const p = token.value;
    if (p === "." && chain && stack.length === 0 && chain.receiver !== "done") {
      chain.afterDot = true;
      if (chain.receiver === "db" && chain.segments.length === 0) {
        chain.dotFrom = token.from;
      }
      continue;
    }
    if (p === "." && frame?.kind === "object" && frame.expectKey && frame.keyFrom !== undefined) {
      // A dotted key being typed: address.city
      continue;
    }
    if (p === ";" && stack.length === 0) {
      chain = undefined;
      continue;
    }
    if (p === "{") {
      if (stack.length === 0) {
        chain = undefined;
        stack.push({ kind: "object", role: "command", expectKey: true, target: {} });
        continue;
      }
      stack.push({ kind: "object", role: childRole(frame, "object"), expectKey: true, target: childTarget(frame) });
      continue;
    }
    if (p === "[") {
      if (stack.length === 0) {
        if (chain && chain.receiver === "db" && !chain.afterDot) {
          stack.push({ kind: "dbBracket", chain });
          continue;
        }
        chain = undefined;
        stack.push({ kind: "array", role: "commandList", target: {} });
        continue;
      }
      stack.push({ kind: "array", role: childRole(frame, "array"), target: childTarget(frame) });
      continue;
    }
    if (p === "(") {
      stack.push({ kind: "paren", target: currentTarget() });
      continue;
    }
    if (p === "}" || p === "]" || p === ")") {
      const kinds = p === "}" ? ["object"] : p === "]" ? ["array", "dbBracket"] : ["call", "paren"];
      const at = findLast(stack, (f) => kinds.includes(f.kind));
      if (at < 0) {
        continue;
      }
      const closed = stack[at];
      stack.length = at;
      if (closed.kind === "dbBracket") {
        closed.chain.target = { ...closed.chain.target, collection: closed.value };
        closed.chain.receiver = closed.value !== undefined ? "collection" : "done";
      } else if (closed.kind === "call" && closed.chain) {
        afterCall(closed.chain, closed);
      }
      continue;
    }
    if (p === ":" && frame?.kind === "object" && frame.expectKey) {
      frame.expectKey = false;
      if (frame.role === "command" && frame.command === undefined) {
        frame.command = frame.key;
      }
      continue;
    }
    if (p === ",") {
      if (frame?.kind === "object") {
        frame.expectKey = true;
        frame.key = undefined;
        frame.keyFrom = undefined;
      } else if (frame?.kind === "call") {
        frame.argIndex++;
      }
      continue;
    }
  }
  if (pendingName) {
    resolvePendingName(undefined);
  }

  // The prefix: a string's text, a (dotted) key, or the name before the cursor
  let prefixFrom = end;
  let inString: CursorContext["inString"];
  if (openString) {
    inString = openString;
    prefixFrom = openString.from + 1;
  } else {
    while (prefixFrom > 0 && IDENT_PART.test(text[prefixFrom - 1])) {
      prefixFrom--;
    }
    const frame = top();
    // A dotted key being typed (address.ci), not a finished one followed by a space
    if (frame?.kind === "object" && frame.expectKey && frame.keyFrom !== undefined && /^[\w$.]*$/.test(text.slice(frame.keyFrom, end))) {
      prefixFrom = frame.keyFrom;
    }
  }
  const prefix = openString ? unescape(text.slice(prefixFrom, end)) : text.slice(prefixFrom, end);

  const context: CursorContext = { prefix, prefixFrom, target: currentTarget() };
  if (inString) {
    context.inString = inString;
  }
  const frame = top();
  if (chain && chain.afterDot && stack.length === 0 && chain.receiver !== "done" && !inString) {
    context.member = {
      receiver: chain.receiver,
      segments: [...chain.segments],
      segmentsFrom: chain.segments.length ? chain.segmentsFrom : prefixFrom,
      dotFrom: chain.dotFrom,
      ...(chain.receiver === "cursor" ? { cursorKind: chain.cursorKind ?? "other" } : {})
    };
  }
  if (frame?.kind === "object") {
    context.object = { role: frame.role, expectKey: frame.expectKey, key: frame.expectKey ? undefined : frame.key, command: frame.command };
  } else if (frame?.kind === "array") {
    context.array = { role: frame.role };
  } else if (frame?.kind === "dbBracket") {
    context.member = { receiver: "db", segments: [], segmentsFrom: prefixFrom, dotFrom: prefixFrom, bracket: true };
  }
  const call = findLast(stack, (f) => f.kind === "call");
  if (call >= 0) {
    const callFrame = stack[call] as Extract<Frame, { kind: "call" }>;
    context.call = { name: callFrame.name, receiver: callFrame.receiver, argIndex: callFrame.argIndex };
    context.inCallArguments = call === stack.length - 1;
  }
  return context;
}

function afterCall(chain: Chain, call: Extract<Frame, { kind: "call" }>): void {
  if (call.receiver === "db") {
    if (call.name === "getCollection" && call.firstString !== undefined) {
      chain.target = { ...chain.target, collection: call.firstString };
      chain.receiver = "collection";
    } else if (call.name === "getSiblingDB" && call.firstString !== undefined) {
      chain.target = { database: call.firstString };
      chain.receiver = "db";
      chain.segments = [];
    } else {
      chain.receiver = "done";
    }
    return;
  }
  // explain() returns something you call find() etc. on
  if (call.name === "explain" && call.receiver === "collection") {
    chain.receiver = "collection";
    return;
  }
  if (call.receiver === "collection") {
    chain.cursorKind = call.name === "find" || call.name === "findOne" ? "find" : call.name === "aggregate" ? "aggregate" : "other";
  }
  chain.receiver = "cursor";
}

/** What an object or array opened in `parent` holds. */
function childRole(parent: Frame | undefined, shape: "object" | "array"): Role {
  if (!parent) {
    return "unknown";
  }
  if (parent.kind === "call") {
    return argumentRole(parent.name, parent.receiver, parent.argIndex, shape);
  }
  if (parent.kind === "array") {
    switch (parent.role) {
      case "commandList":
        return shape === "object" ? "command" : "unknown";
      case "pipeline":
        return shape === "object" ? "stage" : "unknown";
      case "filterList":
        return shape === "object" ? "filter" : "unknown";
      default:
        return parent.role === "expression" ? "expression" : "unknown";
    }
  }
  if (parent.kind !== "object" || parent.expectKey) {
    return "unknown";
  }
  return valueRole(parent.role, parent.key ?? "", shape);
}

function argumentRole(method: string, receiver: Receiver, argIndex: number, shape: "object" | "array"): Role {
  if (receiver === "db") {
    return (method === "runCommand" || method === "adminCommand") && argIndex === 0 && shape === "object" ? "command" : "unknown";
  }
  if (receiver === "cursor") {
    switch (method) {
      case "sort":
      case "hint":
      case "min":
      case "max":
        return shape === "object" ? "sort" : "unknown";
      case "projection":
        return shape === "object" ? "projection" : "unknown";
      default:
        return "unknown";
    }
  }
  switch (method) {
    case "find":
    case "findOne":
      return shape === "object" ? (argIndex === 0 ? "filter" : argIndex === 1 ? "projection" : "unknown") : "unknown";
    case "countDocuments":
    case "count":
      return argIndex === 0 && shape === "object" ? "filter" : "unknown";
    case "distinct":
      return argIndex === 1 && shape === "object" ? "filter" : "unknown";
    case "aggregate":
      return argIndex === 0 && shape === "array" ? "pipeline" : "unknown";
    default:
      return "unknown";
  }
}

function valueRole(role: Role, key: string, shape: "object" | "array"): Role {
  switch (role) {
    case "filter":
      if (key === "$and" || key === "$or" || key === "$nor") {
        return shape === "array" ? "filterList" : "unknown";
      }
      if (key === "$expr") {
        return "expression";
      }
      return key.startsWith("$") ? "unknown" : shape === "object" ? "fieldCondition" : "unknown";
    case "fieldCondition":
      if (key === "$elemMatch") {
        return shape === "object" ? "filter" : "unknown";
      }
      return key === "$not" && shape === "object" ? "fieldCondition" : "unknown";
    case "stage":
      switch (key) {
        case "$match":
          return "filter";
        case "$sort":
          return "sort";
        case "$project":
        case "$addFields":
        case "$set":
          return "projection";
        case "$group":
          return "group";
        case "$lookup":
        case "$graphLookup":
          return "lookup";
        case "$facet":
          return "facet";
        case "$unionWith":
          return shape === "object" ? "unionWith" : "unknown";
        default:
          return "expression";
      }
    case "facet":
      return shape === "array" ? "pipeline" : "unknown";
    case "lookup":
    case "unionWith":
      return key === "pipeline" && shape === "array" ? "pipeline" : "unknown";
    case "group":
      return key === "_id" ? "expression" : shape === "object" ? "accumulator" : "unknown";
    case "accumulator":
    case "projection":
    case "expression":
      return "expression";
    case "command":
      switch (key) {
        case "filter":
        case "query":
          return "filter";
        case "pipeline":
          return shape === "array" ? "pipeline" : "unknown";
        case "sort":
        case "hint":
          return "sort";
        case "projection":
          return "projection";
        case "explain":
          return "command";
        default:
          return "unknown";
      }
    default:
      return "unknown";
  }
}

/** The collection an object or array opened in `parent` is about: a $lookup's or $unionWith's pipeline runs on the joined one. */
function childTarget(parent: Frame | undefined): Target {
  if (!parent || parent.kind === "dbBracket") {
    return {};
  }
  if (parent.kind === "object" && (parent.role === "lookup" || parent.role === "unionWith") && parent.key === "pipeline" && parent.joined !== undefined) {
    return { ...parent.target, collection: parent.joined };
  }
  return parent.target;
}

function findLast<T>(items: T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (test(items[i])) {
      return i;
    }
  }
  return -1;
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

import {
  CompletionItemKind,
  type CompletionItem,
  type CompletionProvider,
  type Diagnostic,
  type DiagnosticsProvider,
  type HoverProvider,
  type SignatureHelpProvider,
  type TextDocument,
  type TextRange
} from "@queryeer/api/editor/EditorApi";
import { cursorContext, type CursorContext, type Receiver, type Role } from "./mongoCursorContext.js";
import {
  ACCUMULATORS,
  ALL_OPERATORS,
  COLLECTION_COMMANDS,
  COLLECTION_METHODS,
  COMMAND_DOCS,
  COMMANDS,
  CURSOR_METHODS,
  DATABASE_METHODS,
  EXPRESSION_OPERATORS,
  FILTER_OPERATORS,
  QUERY_OPERATORS,
  STAGES,
  cursorMethodsAfter,
  findMethod,
  signatureLabel,
  type MethodInfo,
  type OperatorInfo
} from "./mongoReference.js";

/** A sampled field, as the explorer has it. */
export type FieldSample = { name: string; types: string[]; elementTypes?: string[]; count: number; sampled: number };

/** A problem the backend's parser reports, with a 1-based position. */
export type Problem = { message: string; line: number; column: number };

/** What the editor features ask the plugin for. Every method may reject; the features then offer less. */
export type MongoEditorData = {
  /** The connection and database a file runs against, or undefined when it has none. */
  scope(fileId: string | undefined): { connectionId: string; database?: string } | undefined;
  collections(connectionId: string, database: string): Promise<string[] | undefined>;
  fields(connectionId: string, database: string, collection: string): Promise<FieldSample[] | undefined>;
  validate(text: string): Promise<Problem[]>;
};

export type MongoEditorFeatures = {
  completion: CompletionProvider;
  hover: HoverProvider;
  signatureHelp: SignatureHelpProvider;
  diagnostics: DiagnosticsProvider;
};

const PLAIN_NAME = /^[A-Za-z_$][\w$]*$/;
const FIELD_ROLES: ReadonlySet<Role> = new Set(["filter", "projection", "sort"]);
/** Values that name a field with `$` in aggregation expressions, not in filters. */
const NO_FIELD_REFERENCES: ReadonlySet<Role> = new Set(["filter", "fieldCondition", "command"]);

export function createMongoEditorFeatures(data: MongoEditorData): MongoEditorFeatures {
  return {
    completion: {
      triggerCharacters: [".", "$", "\"", "'"],
      async provideCompletionItems(document, position) {
        const text = document.getText();
        const offset = offsetAt(text, position.lineNumber, position.column);
        const context = cursorContext(text, offset);
        // Empty results, not null: Queryeer 0.22's types don't let an async provider return null (0.23's do)
        if (context.inComment) {
          return { suggestions: [] };
        }
        return { suggestions: await completions(context, text, offset, document, data) };
      }
    },

    hover: {
      async provideHover(document, position) {
        const text = document.getText();
        const offset = offsetAt(text, position.lineNumber, position.column);
        const hover = await hoverAt(text, offset, document, data);
        // No contents: no hover
        return hover ? { range: rangeOf(text, hover.word.from, hover.word.to), contents: [{ value: hover.content }] } : { contents: [] };
      }
    },

    signatureHelp: {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [","],
      provideSignatureHelp(document, position) {
        const text = document.getText();
        const context = cursorContext(text, offsetAt(text, position.lineNumber, position.column));
        const method = context.call ? findMethod(context.call.name, receiverOf(context.call.receiver)) : undefined;
        if (!method || !context.call) {
          return null;
        }
        return {
          activeSignature: 0,
          activeParameter: Math.min(context.call.argIndex, Math.max(0, method.parameters.length - 1)),
          signatures: [{ label: signatureLabel(method), documentation: method.doc, parameters: method.parameters.map((label) => ({ label })) }]
        };
      }
    },

    diagnostics: {
      async provideDiagnostics(document) {
        const text = document.getText();
        if (!text.trim()) {
          return [];
        }
        let problems: Problem[];
        try {
          problems = await data.validate(text);
        } catch {
          // The backend isn't running or is restarting: nothing to show until the next check
          return [];
        }
        return problems.filter((problem) => problem.line >= 1).map((problem) => diagnosticFor(document, problem));
      }
    }
  };
}

async function completions(context: CursorContext, text: string, offset: number, document: TextDocument, data: MongoEditorData): Promise<CompletionItem[]> {
  const prefixRange = rangeOf(text, context.prefixFrom, offset);
  const singleLine = prefixRange.startLineNumber === prefixRange.endLineNumber;

  if (context.member) {
    return memberCompletions(context, text, offset, document, data);
  }

  const object = context.object;
  if (context.inString) {
    const quote = context.inString.quote;
    const call = context.call;
    // db.getCollection("…"), { "find": "…" }, { $lookup: { from: "…" } }, { $unionWith: "…" }
    const wantsCollection =
      (call?.name === "getCollection" && call.receiver === "db" && context.inCallArguments) ||
      (object && !object.expectKey && ((object.role === "command" && object.key === object.command && COLLECTION_COMMANDS.has(object.command ?? "")) ||
        (object.role === "lookup" && object.key === "from") || (object.role === "unionWith" && object.key === "coll") ||
        (object.role === "stage" && object.key === "$unionWith")));
    if (wantsCollection) {
      const names = await collectionNames(context, document, data);
      return names.filter((name) => !name.includes(quote)).map((name) => item(name, CompletionItemKind.Class, name, prefixRange, "collection"));
    }
    if (object?.expectKey) {
      return keyCompletions(context, document, data, prefixRange, quote);
    }
    if (context.prefix.startsWith("$") && !(object && NO_FIELD_REFERENCES.has(object.role))) {
      const fields = await fieldSamples(context, document, data);
      return fields
        .filter((field) => !field.name.includes(quote))
        .map((field) => ({ ...item(`$${field.name}`, CompletionItemKind.Field, `$${field.name}`, prefixRange, describeTypes(field)), documentation: sampledIn(field) }));
    }
    return [];
  }

  if (!singleLine) {
    return [];
  }
  if (object?.expectKey) {
    return keyCompletions(context, document, data, prefixRange, undefined);
  }
  if (context.prefix.startsWith("$")) {
    return operatorItems(ALL_OPERATORS, prefixRange);
  }
  return [];
}

async function memberCompletions(context: CursorContext, text: string, offset: number, document: TextDocument, data: MongoEditorData): Promise<CompletionItem[]> {
  const member = context.member!;
  const prefixRange = rangeOf(text, context.prefixFrom, offset);
  const items: CompletionItem[] = [];
  if (member.bracket) {
    // db[…]: a collection name, quoted; db["my-coll"] keeps its quotes, db[or gets them
    const quote = context.inString?.quote;
    return (await collectionNames(context, document, data))
      .filter((name) => !quote || !name.includes(quote))
      .map((name) => item(name, CompletionItemKind.Class, quote ? name : JSON.stringify(name), prefixRange, "collection"));
  }
  if (member.receiver === "db" || member.receiver === "path") {
    const path = member.segments.length ? `${member.segments.join(".")}.` : "";
    const names = (await collectionNames(context, document, data)).filter((name) => name.startsWith(path));
    for (const name of names) {
      const rest = name.slice(path.length);
      if (rest.split(".").every((part) => PLAIN_NAME.test(part))) {
        items.push({ ...item(name, CompletionItemKind.Class, rest, prefixRange, "collection"), filterText: rest });
      } else if (!path) {
        // A name that needs quoting replaces the dot: db["my-collection"]
        const dotRange = rangeOf(text, member.dotFrom, offset);
        if (dotRange.startLineNumber === dotRange.endLineNumber) {
          items.push({ ...item(name, CompletionItemKind.Class, `[${JSON.stringify(name)}]`, dotRange, "collection"), filterText: `.${name}` });
        }
      }
    }
    const methods = member.receiver === "db" ? DATABASE_METHODS : COLLECTION_METHODS;
    items.push(...methodItems(methods, prefixRange));
    return items;
  }
  return methodItems(member.receiver === "collection" ? COLLECTION_METHODS : cursorMethodsAfter(member.cursorKind ?? "other"), prefixRange);
}

async function keyCompletions(context: CursorContext, document: TextDocument, data: MongoEditorData, range: TextRange, quote: string | undefined): Promise<CompletionItem[]> {
  const object = context.object!;
  const key = (name: string) => (quote ? name : PLAIN_NAME.test(name) ? name : JSON.stringify(name));
  const fieldItems = async () =>
    (await fieldSamples(context, document, data))
      .filter((field) => !quote || !field.name.includes(quote))
      .map((field, index) => ({
        ...item(field.name, CompletionItemKind.Field, key(field.name), range, describeTypes(field)),
        documentation: sampledIn(field),
        // Fields first, top-level before nested
        sortText: `0${field.name.includes(".") ? 1 : 0}${String(index).padStart(4, "0")}`,
        filterText: quote ? field.name : key(field.name)
      }));
  switch (object.role) {
    case "filter":
      return [...(await fieldItems()), ...operatorItems(FILTER_OPERATORS, range, key)];
    case "projection":
    case "sort":
      return fieldItems();
    case "fieldCondition":
      return operatorItems(QUERY_OPERATORS, range, key);
    case "stage":
      return operatorItems(STAGES, range, key);
    case "group":
      return [item("_id", CompletionItemKind.Keyword, key("_id"), range, "the group key")];
    case "accumulator":
      return operatorItems(ACCUMULATORS, range, key);
    case "expression":
      return operatorItems(EXPRESSION_OPERATORS, range, key);
    case "lookup":
      return ["from", "localField", "foreignField", "as", "let", "pipeline"].map((name) => item(name, CompletionItemKind.Property, key(name), range));
    case "unionWith":
      return ["coll", "pipeline"].map((name) => item(name, CompletionItemKind.Property, key(name), range));
    case "command":
      if (object.command === undefined) {
        return Object.keys(COMMANDS).map((name) => ({ ...item(name, CompletionItemKind.Method, key(name), range), documentation: COMMAND_DOCS[name] }));
      }
      return (COMMANDS[object.command] ?? []).map((name) => item(name, CompletionItemKind.Property, key(name), range));
    default:
      return context.prefix.startsWith("$") ? operatorItems(ALL_OPERATORS, range, key) : [];
  }
}

async function hoverAt(text: string, offset: number, document: TextDocument, data: MongoEditorData): Promise<{ word: Word; content: string } | undefined> {
  const word = wordAt(text, offset, /[\w$]/);
  if (!word) {
    return undefined;
  }
  const context = cursorContext(text, word.from);
  if (context.inComment || context.inString) {
    return undefined;
  }
  if (word.text.startsWith("$")) {
    const operator = operatorsFor(context.object?.role).find((info) => info.name === word.text) ?? ALL_OPERATORS.find((info) => info.name === word.text);
    return operator ? { word, content: `**${operator.name}**\n\n${operator.doc}` } : undefined;
  }
  // A method: after `.`, before `(`
  if (context.member && /^\s*\(/.test(text.slice(word.to))) {
    const receiver = context.member.receiver === "path" ? "collection" : context.member.receiver;
    const method = findMethod(word.text, receiver);
    return method ? { word, content: methodHover(method) } : undefined;
  }
  if (context.object?.role === "command" && context.object.command === undefined && COMMAND_DOCS[word.text]) {
    return { word, content: `**${word.text}**\n\n${COMMAND_DOCS[word.text]}` };
  }
  // A field key, also a dotted one: address.city
  const path = wordAt(text, offset, /[\w$.]/);
  if (!path || !/^\s*:/.test(text.slice(path.to))) {
    return undefined;
  }
  const keyContext = cursorContext(text, path.from);
  if (!keyContext.object?.expectKey || !FIELD_ROLES.has(keyContext.object.role)) {
    return undefined;
  }
  const field = (await fieldSamples(keyContext, document, data)).find((candidate) => candidate.name === path.text);
  return field ? { word: path, content: `**${field.name}**: ${describeTypes(field)}\n\n${sampledIn(field)}` } : undefined;
}

function methodHover(method: MethodInfo): string {
  return `\`\`\`\n${signatureLabel(method)}\n\`\`\`\n\n${method.doc}`;
}

function operatorsFor(role: Role | undefined): OperatorInfo[] {
  switch (role) {
    case "stage":
      return STAGES;
    case "filter":
      return FILTER_OPERATORS;
    case "fieldCondition":
      return QUERY_OPERATORS;
    case "accumulator":
      return ACCUMULATORS;
    case "expression":
    case "projection":
    case "group":
      return EXPRESSION_OPERATORS;
    default:
      return ALL_OPERATORS;
  }
}

function receiverOf(receiver: Receiver): "db" | "collection" | "cursor" {
  return receiver === "path" ? "collection" : receiver;
}

/** The statement's collection, from the file's connection and database (or the statement's getSiblingDB). */
async function collectionNames(context: CursorContext, document: TextDocument, data: MongoEditorData): Promise<string[]> {
  const scope = data.scope(document.fileId);
  const database = context.target.database ?? scope?.database;
  if (!scope || !database) {
    return [];
  }
  try {
    return (await data.collections(scope.connectionId, database)) ?? [];
  } catch {
    return [];
  }
}

async function fieldSamples(context: CursorContext, document: TextDocument, data: MongoEditorData): Promise<FieldSample[]> {
  const scope = data.scope(document.fileId);
  const database = context.target.database ?? scope?.database;
  const collection = context.target.collection;
  if (!scope || !database || !collection) {
    return [];
  }
  try {
    return (await data.fields(scope.connectionId, database, collection)) ?? [];
  } catch {
    return [];
  }
}

function methodItems(methods: MethodInfo[], range: TextRange): CompletionItem[] {
  return methods.map((method) => ({
    ...item(method.name, CompletionItemKind.Method, method.name, range, signatureLabel(method)),
    documentation: method.doc,
    sortText: `1${method.name}`
  }));
}

function operatorItems(operators: OperatorInfo[], range: TextRange, key: (name: string) => string = (name) => name): CompletionItem[] {
  return operators.map((operator) => ({
    ...item(operator.name, CompletionItemKind.Operator, key(operator.name), range),
    documentation: operator.doc,
    sortText: `2${operator.name}`
  }));
}

function item(label: string, kind: CompletionItemKind, insertText: string, range: TextRange, detail?: string): CompletionItem {
  return { label, kind, insertText, range, ...(detail ? { detail } : {}) };
}

function describeTypes(field: FieldSample): string {
  const elements = field.elementTypes?.length ? ` of ${field.elementTypes.join(" | ")}` : "";
  return field.types.map((type) => (type === "array" ? `array${elements}` : type)).join(" | ");
}

function sampledIn(field: FieldSample): string {
  return `In ${field.count} of ${field.sampled} sampled documents.`;
}

function diagnosticFor(document: TextDocument, problem: Problem): Diagnostic {
  const lineNumber = Math.min(problem.line, Math.max(1, document.lineCount));
  const line = document.lineAt(lineNumber).text;
  // Underline the word at the position, or one character; past the end of the line, its last character
  let start = Math.max(1, Math.min(problem.column, line.length));
  let end = start + 1;
  const word = /^[\w$.]+/.exec(line.slice(start - 1));
  if (word) {
    end = start + word[0].length;
  } else if (line.length === 0) {
    start = 1;
    end = 1;
  }
  return {
    range: { startLineNumber: lineNumber, startColumn: start, endLineNumber: lineNumber, endColumn: end },
    message: problem.message,
    severity: "error",
    source: "mongodb"
  };
}

type Word = { text: string; from: number; to: number };

/** The run of `part` characters around an offset, when it is a name. */
function wordAt(text: string, offset: number, part: RegExp): Word | undefined {
  let from = offset;
  let to = offset;
  while (from > 0 && part.test(text[from - 1])) {
    from--;
  }
  while (to < text.length && part.test(text[to])) {
    to++;
  }
  const word = text.slice(from, to);
  return /^[A-Za-z_$]/.test(word) ? { text: word, from, to } : undefined;
}

export function offsetAt(text: string, lineNumber: number, column: number): number {
  let line = 1;
  let index = 0;
  while (line < lineNumber) {
    const newline = text.indexOf("\n", index);
    if (newline < 0) {
      return text.length;
    }
    index = newline + 1;
    line++;
  }
  return Math.min(index + column - 1, text.length);
}

function rangeOf(text: string, from: number, to: number): TextRange {
  const start = positionAt(text, from);
  const end = positionAt(text, to);
  return { startLineNumber: start.line, startColumn: start.column, endLineNumber: end.line, endColumn: end.column };
}

function positionAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

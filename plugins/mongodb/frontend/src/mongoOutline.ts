import type { OutlineSymbol } from "@queryeer/api/extensions/OutlineExtension";
import { guessCollection } from "./queryBarModel.js";

/**
 * Outline for `.mongo` files: one entry per statement, in either form, named after its command and collection ("find orders",
 * "count campaign-variantsku", "runCommand dbStats"). Statement boundaries follow the backend parser: strings, comments and regular
 * expression literals are skipped as units. Never throws: half-typed text gives an entry up to where it ends.
 */
export function mongoOutline(content: string): OutlineSymbol[] {
  const text = content.replace(/\r\n?/g, "\n");
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }
  const position = (offset: number): { line: number; column: number } => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  };

  const symbols: OutlineSymbol[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c) || c === "," || c === ";" || c === "[" || c === "]") {
      i++;
    } else if (isCommentStart(text, i)) {
      i = skipNonCode(text, i);
    } else if (c === "{" || startsShellStatement(text, i)) {
      const shell = c !== "{";
      const end = shell ? shellStatementEnd(text, i) : closingBracket(text, i);
      const statement = text.slice(i, end);
      const start = position(i);
      const last = position(Math.max(i, end - 1));
      const firstLineEnd = text.indexOf("\n", i);
      symbols.push({
        id: `mongo:${start.line}:${start.column}`,
        name: shell ? describeShell(statement) : describeJson(statement),
        detail: shell ? "shell" : "JSON",
        kind: "Method",
        range: { startLineNumber: start.line, startColumn: start.column, endLineNumber: last.line, endColumn: last.column + 1 },
        selectionRange: {
          startLineNumber: start.line,
          startColumn: start.column,
          endLineNumber: start.line,
          endColumn: (firstLineEnd < 0 || firstLineEnd > end ? end : firstLineEnd) - lineStarts[start.line - 1] + 1
        }
      });
      i = Math.max(end, i + 1);
    } else {
      // Not a statement (half-typed or invalid): skip the rest of the line
      const newline = text.indexOf("\n", i);
      i = newline < 0 ? text.length : newline + 1;
    }
  }
  return symbols;
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const DATABASE_SELECTORS = new Set(["getCollection", "getSiblingDB"]);

/** "find orders", "aggregate reports.monthly", "runCommand dbStats". */
function describeShell(statement: string): string {
  const calls = [...statement.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]).filter((name) => !DATABASE_SELECTORS.has(name));
  const method = calls.find((name) => name !== "explain") ?? calls[0] ?? "db";
  if (method === "runCommand" || method === "adminCommand") {
    const command = /(?:runCommand|adminCommand)\s*\(\s*\{\s*["']?([A-Za-z_$][\w$]*)/.exec(statement);
    return command ? `${method} ${command[1]}` : method;
  }
  const collection = guessCollection(statement);
  const explained = calls.includes("explain") ? "explain " : "";
  return `${explained}${method}${collection ? ` ${collection}` : ""}`;
}

/** "find orders", "dbStats", "explain find orders". */
function describeJson(statement: string): string {
  const first = /^\{\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*:\s*(?:"([^"]*)"|'([^']*)'|(\{))?/.exec(statement);
  if (!first) {
    return "{ }";
  }
  const name = first[1] ?? first[2] ?? first[3];
  const value = first[4] ?? first[5];
  if (value !== undefined) {
    return `${name} ${value}`;
  }
  if (first[6] && name === "explain") {
    return `explain ${describeJson(statement.slice(first[0].length - 1))}`;
  }
  return name;
}

function startsShellStatement(text: string, i: number): boolean {
  return text.startsWith("db", i) && (i === 0 || !/[\w$]/.test(text[i - 1])) && /^db[ \t]*\./.test(text.slice(i, i + 32));
}

/** The end of a `db.….…(…)` chain: after its last name or call, where no further `.` follows (new lines and comments may come before it). */
function shellStatementEnd(text: string, start: number): number {
  let pos = start + 2;
  let end = pos;
  while (pos < text.length) {
    const next = skipBlanks(text, pos);
    if (text[next] !== ".") {
      return end;
    }
    pos = skipBlanks(text, next + 1);
    IDENTIFIER.lastIndex = pos;
    const name = IDENTIFIER.exec(text);
    if (!name) {
      return pos;
    }
    pos += name[0].length;
    end = pos;
    const open = skipBlanks(text, pos);
    if (text[open] === "(") {
      pos = closingBracket(text, open);
      end = pos;
    }
  }
  return end;
}

/** The index after the bracket closing the one at `start`, or the end of the text when it is not closed. */
function closingBracket(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const next = skipNonCode(text, i);
    if (next > i) {
      i = next;
      continue;
    }
    const c = text[i];
    if (c === "{" || c === "[" || c === "(") {
      depth++;
    } else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
    i++;
  }
  return text.length;
}

function skipBlanks(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
    } else if (isCommentStart(text, i)) {
      i = skipNonCode(text, i);
    } else {
      break;
    }
  }
  return i;
}

function isCommentStart(text: string, i: number): boolean {
  return text[i] === "/" && (text[i + 1] === "/" || text[i + 1] === "*");
}

/** After a string, comment or regular expression literal starting at `i`; `i` itself when none starts there. Unclosed ones end the line (or text). */
function skipNonCode(text: string, i: number): number {
  const c = text[i];
  if (c === "\"" || c === "'") {
    let j = i + 1;
    while (j < text.length && text[j] !== c && text[j] !== "\n") {
      j += text[j] === "\\" ? 2 : 1;
    }
    return Math.min(j + 1, text.length);
  }
  if (c !== "/") {
    return i;
  }
  if (text[i + 1] === "/") {
    const newline = text.indexOf("\n", i);
    return newline < 0 ? text.length : newline + 1;
  }
  if (text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length : end + 2;
  }
  let j = i + 1;
  let inClass = false;
  while (j < text.length && text[j] !== "\n") {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === "[") {
      inClass = true;
    } else if (text[j] === "]") {
      inClass = false;
    } else if (text[j] === "/" && !inClass) {
      j++;
      while (j < text.length && /[a-z]/i.test(text[j])) {
        j++;
      }
      return j;
    }
    j++;
  }
  return j;
}

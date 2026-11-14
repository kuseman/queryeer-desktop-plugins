import { describe, expect, it } from "vitest";
import { mongoLanguage, REGEX_LITERAL } from "./mongoLanguage.js";

type Rule = [RegExp, unknown, string?] | { include: string };

/**
 * A minimal Monarch interpreter for tests: per line, the rules of the current state are tried in order, anchored at the current position,
 * and the first match wins. Supports group actions, `cases` with @keywords-style lists, @brackets, and state @push / @pop. Enough to check
 * these rules without loading Monaco.
 */
function tokenize(text: string): Array<[string, string]> {
  const monarch = mongoLanguage.monarch;
  const tokenizer = monarch.tokenizer as Record<string, Rule[]>;
  const rulesOf = (state: string): Array<[RegExp, unknown, string?]> =>
    tokenizer[state].flatMap((rule) => ("include" in rule ? rulesOf(rule.include.replace(/^@/, "")) : [rule]));
  const tokens: Array<[string, string]> = [];
  const stack = ["root"];
  const push = (value: string, type: unknown): void => {
    if (value === "") {
      return;
    }
    let name: string;
    if (typeof type === "string") {
      name = type;
    } else {
      const cases = (type as { cases: Record<string, string> }).cases;
      const listed = Object.entries(cases).find(([key]) => key !== "@default" && (monarch[key.slice(1)] as string[]).includes(value));
      name = listed ? listed[1] : cases["@default"];
    }
    if (name === "@brackets") {
      name = "delimiter.bracket";
    }
    tokens.push([value, name]);
  };
  for (const line of text.split("\n")) {
    let pos = 0;
    while (pos < line.length) {
      const state = stack[stack.length - 1];
      let matched = false;
      for (const [regex, action, next] of rulesOf(state)) {
        const sticky = new RegExp(regex.source, "y");
        sticky.lastIndex = pos;
        const match = sticky.exec(line);
        if (!match || match[0] === "") {
          continue;
        }
        if (Array.isArray(action)) {
          action.forEach((type, index) => push(match[index + 1] ?? "", type));
        } else {
          push(match[0], action);
        }
        if (next === "@pop") {
          stack.pop();
        } else if (next) {
          stack.push(next.replace(/^@/, ""));
        }
        pos += match[0].length;
        matched = true;
        break;
      }
      if (!matched) {
        throw new Error(`No rule in state ${state} matches at ${pos}: ${line.slice(pos)}`);
      }
    }
  }
  return tokens.filter(([value, type]) => type !== "" || value.trim() !== "");
}

const typeOf = (tokens: Array<[string, string]>, value: string): string | undefined => tokens.find(([v]) => v === value)?.[1];

describe("mongodb editor language", () => {
  it("highlights shell statements", () => {
    const tokens = tokenize("db.orders.find({ status: 'paid', total: { $gt: 100 } }).sort({ _id: -1 }).limit(20)");
    expect(typeOf(tokens, "db")).toBe("keyword");
    expect(typeOf(tokens, "orders")).toBe("variable");
    expect(typeOf(tokens, "find")).toBe("type");
    expect(typeOf(tokens, "sort")).toBe("type");
    expect(typeOf(tokens, "status")).toBe("string.key.json");
    expect(typeOf(tokens, "$gt")).toBe("variable.predefined");
    expect(typeOf(tokens, "paid")).toBe("string");
    expect(typeOf(tokens, "100")).toBe("number");
    expect(typeOf(tokens, "-1")).toBe("number");
  });

  it("highlights JSON command documents", () => {
    const tokens = tokenize('{ "aggregate": "orders", "pipeline": [{ "$match": { "a": true } }], "cursor": {} }');
    expect(typeOf(tokens, '"aggregate"')).toBe("string.key.json");
    expect(typeOf(tokens, '"$match"')).toBe("string.key.json");
    expect(typeOf(tokens, "orders")).toBe("string");
    expect(typeOf(tokens, "true")).toBe("keyword");
  });

  it("highlights helpers, regular expressions and comments, also across lines", () => {
    const tokens = tokenize([
      "/* a block comment",
      "   over two lines */ db.orders.find({ _id: ObjectId(\"650000000000000000000001\"), name: /^a\\/b[/]/i }) // done",
      "{ \"at\": ISODate('2026-11-14'), \"n\": NumberLong(5), \"url\": \"http://x // not a comment\" }"
    ].join("\n"));
    expect(tokens[0]).toEqual(["/*", "comment"]);
    expect(tokens.filter(([, type]) => type === "comment").map(([value]) => value).join("")).toContain("over two lines */");
    expect(typeOf(tokens, "ObjectId")).toBe("type.identifier");
    expect(typeOf(tokens, "ISODate")).toBe("type.identifier");
    expect(typeOf(tokens, "NumberLong")).toBe("type.identifier");
    expect(typeOf(tokens, "/^a\\/b[/]/i")).toBe("regexp");
    expect(typeOf(tokens, "// done")).toBe("comment");
    expect(tokens.some(([value, type]) => value.includes("// not a comment") && type === "string")).toBe(true);
  });

  it("tells regular expressions from comments", () => {
    const sticky = new RegExp(`^(?:${REGEX_LITERAL.source})$`);
    expect(sticky.test("/^ab+c$/gi")).toBe(true);
    expect(sticky.test("/a[/]b/")).toBe(true);
    expect(sticky.test("// comment")).toBe(false);
    expect(sticky.test("/* comment */")).toBe(false);
  });
});

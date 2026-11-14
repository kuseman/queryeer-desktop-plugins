import type { EditorLanguageDefinition } from "@queryeer/api/editor/EditorLanguageExtension";

/** Monaco language for `.mongo` files: JSON command documents and mongosh-style statements, which can be mixed in one file. */
export const MONGO_LANGUAGE_ID = "mongodb";

/** Value helpers the BSON reader accepts, as in mongosh. */
export const SHELL_HELPERS = ["ObjectId", "ISODate", "Date", "NumberLong", "NumberInt", "NumberDecimal", "Timestamp", "UUID", "BinData", "HexData", "MinKey", "MaxKey", "DBRef"];

/** A regular expression literal: `/`, not followed by `/` or `*` (comments), up to the closing `/` outside a character class, then flags. */
export const REGEX_LITERAL = /\/(?![/*])(?:[^\\/[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*/;

/**
 * Highlighting only (the editor has no validation for plugin languages; the backend parser reports errors with line and column):
 * `db` and literals as keywords, method names, shell helpers, `$operators`, keys in both forms, strings, numbers, regular expressions
 * and comments.
 */
export const mongoLanguage: EditorLanguageDefinition = {
  id: MONGO_LANGUAGE_ID,
  aliases: ["MongoDB", "mongo"],
  monarch: {
    defaultToken: "",
    tokenPostfix: ".mongo",
    keywords: ["db", "new", "true", "false", "null", "undefined"],
    helpers: SHELL_HELPERS,
    brackets: [
      { open: "{", close: "}", token: "delimiter.bracket" },
      { open: "[", close: "]", token: "delimiter.square" },
      { open: "(", close: ")", token: "delimiter.parenthesis" }
    ],
    tokenizer: {
      root: [
        { include: "@whitespace" },
        // Keys: "quoted": or unquoted: (also $operators used as keys, e.g. $match:)
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key.json"],
        [/'(?:[^'\\]|\\.)*'(?=\s*:)/, "string.key.json"],
        [/\$[\w$]*(?=\s*:)/, "variable.predefined"],
        [/[A-Za-z_][\w$]*(?=\s*:)/, "string.key.json"],
        // Method calls after a dot: db.orders.find(
        [/(\.)(\s*)([A-Za-z_$][\w$]*)(?=\s*\()/, ["delimiter", "", "type"]],
        // Collection names in a dotted path: db.orders.
        [/(\.)(\s*)([A-Za-z_$][\w$]*)/, ["delimiter", "", "variable"]],
        [/\$[\w$.]*/, "variable.predefined"],
        [/[A-Za-z_][\w$]*/, { cases: { "@keywords": "keyword", "@helpers": "type.identifier", "@default": "identifier" } }],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, "number"],
        [REGEX_LITERAL, "regexp"],
        [/"/, "string", "@stringDouble"],
        [/'/, "string", "@stringSingle"],
        [/[{}()[\]]/, "@brackets"],
        [/[,:;.]/, "delimiter"]
      ],
      whitespace: [
        [/\s+/, ""],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"]
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"]
      ],
      stringDouble: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"]
      ],
      stringSingle: [
        [/[^\\']+/, "string"],
        [/\\./, "string.escape"],
        [/'/, "string", "@pop"]
      ]
    }
  },
  configuration: {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"", notIn: ["string", "comment"] },
      { open: "'", close: "'", notIn: ["string", "comment"] }
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
      { open: "'", close: "'" }
    ]
  }
};

// Generates a plugin's CHANGELOG.md from git history, like Queryeer Desktop's own generate-changelog.mjs.
//
//   node shared/scripts/generate-changelog.mjs plugins/<name> <output file>
//
// Only commits that touch plugins/<name> count, so other plugins' changes never show up. Each release tag
// <name>/v<semver> becomes a section, newest first; commits after the latest tag become a section for plugin.json's
// version (or "Unreleased" when that version is already tagged). Subjects are grouped by their conventional-commit
// type. Needs the full history with tags (CI: fetch-depth 0); without git it writes a single placeholder section.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

const [pluginArg, outputArg] = process.argv.slice(2);
if (!pluginArg || !outputArg) {
  console.error("Usage: node shared/scripts/generate-changelog.mjs plugins/<name> <output file>");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "..", "..");
const pluginDir = resolve(repoRoot, pluginArg);
const pluginPath = relative(repoRoot, pluginDir).replace(/\\/g, "/");
const tagPrefix = `${basename(pluginDir)}/v`;
const outputPath = resolve(outputArg);
const manifest = JSON.parse(readFileSync(resolve(pluginDir, "plugin.json"), "utf8"));

const TYPES = "feat|fix|chore|build|ci|docs|refactor|test|perf|style";
const CATEGORIES = ["Features", "Bug Fixes", "Chores", "Other Changes"];

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function categorize(subject) {
  if (/^feat(\(.+?\))?!?:/i.test(subject)) {
    return "Features";
  }
  if (/^fix(\(.+?\))?!?:/i.test(subject)) {
    return "Bug Fixes";
  }
  if (new RegExp(`^(${TYPES})(\\(.+?\\))?!?:`, "i").test(subject)) {
    return "Chores";
  }
  return "Other Changes";
}

function formatSubject(subject) {
  const text = subject.replace(new RegExp(`^(${TYPES})(\\(.+?\\))?!?:\\s*`, "i"), "").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Commit subjects in `range` that touch this plugin, grouped by category. */
function commits(range) {
  const groups = new Map(CATEGORIES.map((title) => [title, []]));
  const log = git(["log", range, "--no-merges", "--pretty=format:%s", "--", pluginPath]) ?? "";
  for (const subject of log.split(/\r?\n/).filter(Boolean)) {
    if (/^release(\(.+?\))?:|^chore(\(.+?\))?: prepare for next development iteration/i.test(subject)) {
      continue;
    }
    groups.get(categorize(subject)).push(formatSubject(subject));
  }
  return groups;
}

function isEmpty(groups) {
  return [...groups.values()].every((entries) => entries.length === 0);
}

function writeSection(lines, title, groups) {
  if (lines.at(-1) !== "") {
    lines.push("");
  }
  lines.push(`## ${title}`, "");
  if (isEmpty(groups)) {
    lines.push("- Release build", "");
    return;
  }
  for (const [category, entries] of groups) {
    if (entries.length === 0) {
      continue;
    }
    lines.push(`### ${category}`, "");
    lines.push(...entries.map((entry) => `- ${entry}`), "");
  }
}

const lines = [`# ${manifest.name} Changelog`];
const head = git(["rev-parse", "HEAD"]);
if (!head) {
  writeSection(lines, `v${manifest.version}`, new Map());
} else {
  const tags = (git(["tag", "-l", `${tagPrefix}*`, "--sort=-version:refname"]) ?? "").split(/\r?\n/).filter(Boolean);
  const latest = tags[0];
  const unreleased = commits(latest ? `${latest}..HEAD` : "HEAD");
  if (!latest || !isEmpty(unreleased)) {
    const tagged = tags.includes(`${tagPrefix}${manifest.version}`);
    writeSection(lines, tagged ? "Unreleased" : `v${manifest.version}`, unreleased);
  }
  tags.forEach((tag, index) => {
    const previous = tags[index + 1];
    writeSection(lines, `v${tag.slice(tagPrefix.length)}`, commits(previous ? `${previous}..${tag}` : tag));
  });
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, lines.join("\n").trim() + "\n", "utf8");
console.log(`Generated ${relative(process.cwd(), outputPath)}`);

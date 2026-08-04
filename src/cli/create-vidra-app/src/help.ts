import { dim, lime, row, value, wordmark, CLI_VERSION } from "./theme.js";
import type { ParsedArgs } from "./utils.js";

/**
 * One declaration per command, three things out of it: the global list, the
 * command's own `--help`, and rejection of flags nothing reads.
 *
 * That last one is why this exists rather than a prose help string. `vidra build
 * --targets macos` used to build for the current platform and say nothing,
 * because an unrecognised flag is indistinguishable from an absent one to a
 * parser that only ever asks for the flags it wants.
 *
 * Deliberately not a CLI framework. Vidra has eight flat commands and one
 * nesting level, and the help is typeset in the brand's glyphs and colours,
 * which is the part a framework would want to own.
 */
export interface CommandFlag {
  name: string;
  /** Placeholder shown after the flag, when it takes a value. */
  arg?: string;
  describe: string;
}

export interface CommandExample {
  args: string;
  describe: string;
}

export interface CommandSpec {
  name: string;
  /** One line, shown in the global list. */
  summary: string;
  usage?: string;
  flags?: CommandFlag[];
  examples?: CommandExample[];
}

/** Flags every command answers, so no spec has to repeat them. */
const UNIVERSAL: CommandFlag[] = [
  { name: "--help", describe: "show this message" },
];

export const renderCommandHelp = (spec: CommandSpec): string => {
  const lines: string[] = [
    "",
    `  ${lime("vidra")} ${value(spec.name)} ${dim(`— ${spec.summary}`)}`,
    "",
    `  ${dim("usage")}`,
    `    ${lime("vidra")} ${value(spec.usage ?? spec.name)}`,
  ];

  const flags = [...(spec.flags ?? []), ...UNIVERSAL];
  const width = Math.max(...flags.map((flag) => flagLabel(flag).length));

  lines.push("", `  ${dim("options")}`);
  for (const flag of flags) {
    lines.push(`    ${value(flagLabel(flag).padEnd(width))}  ${dim(flag.describe)}`);
  }

  if (spec.examples?.length) {
    lines.push("", `  ${dim("examples")}`);
    const exampleWidth = Math.max(...spec.examples.map((example) => example.args.length));
    for (const example of spec.examples) {
      lines.push(
        `    ${lime("vidra")} ${value(example.args.padEnd(exampleWidth))}  ${dim(`# ${example.describe}`)}`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
};

export const renderIndex = (specs: CommandSpec[]): string => {
  const width = Math.max(...specs.map((spec) => spec.name.length));
  const lines: string[] = [
    "",
    `  ${wordmark()} ${dim(`v${CLI_VERSION}`)}`,
    "",
    `  ${dim("usage")}`,
    `    ${lime("vidra")} ${dim("<command> [options]")}`,
    "",
    `  ${dim("commands")}`,
  ];

  for (const spec of specs) {
    lines.push(`    ${value(spec.name.padEnd(width))}  ${dim(spec.summary)}`);
  }

  lines.push(
    "",
    `  ${dim("any command takes")} ${value("--help")}${dim(", for its own options and examples")}`,
    "",
  );
  return lines.join("\n");
};

/**
 * Flags the command does not declare.
 *
 * `_` is the positional bucket, and a spec that declares no flags at all opts
 * out — a command still being written should not start rejecting input.
 */
export const unknownFlags = (spec: CommandSpec, args: ParsedArgs): string[] => {
  if (!spec.flags?.length) return [];

  const known = new Set([
    ...spec.flags.map((flag) => flag.name.replace(/^--/, "")),
    ...UNIVERSAL.map((flag) => flag.name.replace(/^--/, "")),
  ]);

  return Object.keys(args).filter((key) => key !== "_" && !known.has(key));
};

/** Prints the unknown flags and returns true when the command should stop. */
export const rejectUnknownFlags = (spec: CommandSpec, args: ParsedArgs): boolean => {
  const unknown = unknownFlags(spec, args);
  if (unknown.length === 0) return false;

  for (const flag of unknown) {
    const suggestion = nearest(flag, spec);
    console.error(
      row({
        glyph: "error",
        detail: dim(
          `unknown option --${flag}${suggestion ? `: did you mean ${value(suggestion)}?` : ""}`,
        ),
      }),
    );
  }
  console.error(`  ${dim(`see`)} ${lime(`vidra ${spec.name} --help`)}`);
  return true;
};

const flagLabel = (flag: CommandFlag): string =>
  flag.arg ? `${flag.name} <${flag.arg}>` : flag.name;

/** One edit apart, or a prefix: enough to catch a typo, not enough to guess wildly. */
const nearest = (typo: string, spec: CommandSpec): string | null => {
  const candidates = [...(spec.flags ?? []), ...UNIVERSAL].map((flag) => flag.name);
  return (
    candidates.find((candidate) => {
      const name = candidate.replace(/^--/, "");
      return name.startsWith(typo) || typo.startsWith(name) || editDistanceIsOne(name, typo);
    }) ?? null
  );
};

const editDistanceIsOne = (a: string, b: string): boolean => {
  if (Math.abs(a.length - b.length) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Catalog, type Binding } from "./bindings.js";
import { CORE_SCHEMA_VERSION } from "./schema.js";
import { ProfilerError } from "./errors.js";
import { Extractor, projectFiles } from "./extract.js";
import { buildProfile, profileYaml } from "./profile.js";

const USAGE = `usage: runtimeconditions-typescript-profiler [profile] verify-bindings --project DIR [--json]
       runtimeconditions-typescript-profiler [profile] generate --project DIR --name NAME --workload-uri URI [--workload-version VERSION] [--out FILE] [--json]
       runtimeconditions-typescript-profiler --version [--json]`;

export interface Streams {
  out: (text: string) => void;
  err: (text: string) => void;
}

const OPTIONS: Record<string, string[]> = {
  "verify-bindings": ["--project", "--json"],
  generate: ["--project", "--name", "--workload-uri", "--workload-version", "--out", "--json"],
};

function parse(args: string[], allowed: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.includes(flag) || values.has(flag)) {
      throw new ProfilerError("usage", `unexpected argument ${flag}\n${USAGE}`);
    }
    if (flag === "--json") {
      values.set(flag, "true");
    } else {
      const value = args[(index += 1)];
      if (value === undefined) {
        throw new ProfilerError("usage", `${flag} needs a value\n${USAGE}`);
      }
      values.set(flag, value);
    }
  }
  return values;
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) {
    throw new ProfilerError("usage", `${flag} is required\n${USAGE}`);
  }
  return value;
}

export function run(args: string[], streams: Streams): number {
  const json = args.includes("--json");
  try {
    if (args[0] === "--version") {
      const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
      streams.out(json ? `${JSON.stringify({ name: pkg.name, version: pkg.version, coreSchemas: [CORE_SCHEMA_VERSION] })}\n` : `${pkg.version}\n`);
      return 0;
    }
    const [command, ...rest] = args[0] === "profile" ? args.slice(1) : args;
    if (!command || !(command in OPTIONS)) {
      throw new ProfilerError("usage", USAGE);
    }
    const values = parse(rest, OPTIONS[command]!);
    const project = resolve(required(values, "--project"));
    const identity =
      command === "generate"
        ? { name: required(values, "--name"), workloadUri: required(values, "--workload-uri"), workloadVersion: values.get("--workload-version") }
        : undefined;
    if (!existsSync(project)) {
      throw new ProfilerError("usage", `the project directory ${project} does not exist`);
    }
    const catalog = new Catalog();
    const extractor = new Extractor(project, catalog);
    const files = projectFiles(project);
    if (command === "verify-bindings") {
      const direct = extractor.discover(files);
      const rows = catalog.closure(direct).map((binding: Binding) => ({
        package: binding.name,
        version: binding.version,
        extension: binding.extensionId,
        direct: direct.includes(binding),
      }));
      streams.out(
        values.has("--json")
          ? `${JSON.stringify({ project, bindings: rows }, null, 2)}\n`
          : rows.map((row) => `${row.package}@${row.version} ${row.extension}${row.direct ? "" : " (dependency)"}\n`).join(""),
      );
      return 0;
    }
    const profile = buildProfile(extractor.run(files), catalog, identity!);
    const yaml = profileYaml(profile);
    const out = values.get("--out");
    if (out) {
      const target = resolve(out);
      const temporary = join(dirname(target), `.${process.pid}.profile.tmp`);
      writeFileSync(temporary, yaml);
      renameSync(temporary, target);
    } else {
      streams.out(yaml);
    }
    return 0;
  } catch (error) {
    const known = error instanceof ProfilerError;
    streams.err(
      json
        ? `${JSON.stringify({ error: { stage: known ? error.stage : "internal", message: (error as Error).message, ...(known && error.location ? { location: error.location } : {}) } })}\n`
        : `${known ? error.toString() : `error: ${(error as Error).message}`}\n`,
    );
    return 1;
  }
}

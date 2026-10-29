import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

import { fail } from "./errors.js";
import { readLimited } from "./read.js";
import { compile, CORE_SCHEMA_ID, CORE_SCHEMA_SEMANTIC_SHA256, CORE_SCHEMA_VERSION, describeErrors, loadSchema, type JsonObject } from "./schema.js";

export interface TypeEntry {
  nativeName: string;
  sourceName: string;
  construct: "scalar" | "object" | "collection" | "map" | "union" | "any" | "wrapper";
  fields?: { sourceName: string; nativeName: string; required: boolean; value: TypeRef }[];
  members?: { nativeName: string; value: string | number | boolean | null }[];
  element?: { value: TypeRef };
  variants?: { value: TypeRef }[];
}

export interface TypeRef {
  type?: string;
  builtin?: string;
}

export interface RootBinding {
  role: "interface" | "condition-field" | "schema-field";
  declarationCoordinate: string;
  scope: { kind: string; interfaceType?: string };
  sourceName: string;
  path: { name: string }[];
  value: TypeRef;
  fixedInterfaceType?: string;
}

export interface Binding {
  directory: string;
  name: string;
  version: string;
  extensionId: string;
  extensionSha256: string;
  declarations: { sourceName: string; function: string; owner: string }[];
  rootBindings: RootBinding[];
  types: Map<string, TypeEntry>;
  model: JsonObject;
  dependencies: string[];
}

const RESOURCES = "runtimeconditions";
const REQUIRED = ["bindings", "binding-model", "extension"].map(
  (name) => `${RESOURCES}/runtimeconditions.${name}.yaml`,
);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function yamlFile(directory: string, relative: string, stage = "bindings"): any {
  const path = join(directory, relative);
  if (!existsSync(path)) {
    fail(stage, `${relative} is missing`, directory);
  }
  return parse(readLimited(path, stage).toString("utf-8"));
}

// The published 0.1.0 bindings were normalized against core 0.2.0, whose profile structure 0.4.0 keeps.
// Only that exact id, version and digest is accepted; output is still validated with 0.4.0.
const CORE_SCHEMA_0_2_0 = [
  "https://runtimeconditions.io/schemas/profile/0.2.0/runtimeconditions.profile.schema.yaml",
  "0.2.0",
  "a090a8016d045f9c3fa872a67f8df293b77ca2809a1bea5ae9fa31a27a06109a",
] as const;

export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

export function findPackage(from: string, name: string): string | undefined {
  for (let current = resolve(from); ; current = dirname(current)) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    if (dirname(current) === current) {
      return undefined;
    }
  }
}

export function isBinding(directory: string): boolean {
  return existsSync(join(directory, RESOURCES, "runtimeconditions.bindings.yaml"));
}

export function loadBinding(directory: string): Binding {
  const stage = "bindings";
  const pkg = JSON.parse(readLimited(join(directory, "package.json"), stage).toString("utf-8"));
  const where = `${pkg.name}@${pkg.version}`;
  const listing = yamlFile(directory, "runtimeconditions.file-manifest.yaml");
  const files: Record<string, string> = listing?.files ?? {};
  for (const required of REQUIRED) {
    if (!(required in files)) {
      fail(stage, `${required} is not listed in the file manifest`, where);
    }
  }
  for (const [relative, digest] of Object.entries(files)) {
    const path = join(directory, relative);
    if (!existsSync(path)) {
      continue;
    }
    if (sha256(readLimited(path, stage)) !== digest) {
      fail(stage, `${relative} differs from its file manifest digest`, where);
    }
  }
  const manifest = yamlFile(directory, REQUIRED[0]!);
  const model = yamlFile(directory, REQUIRED[1]!);
  const extension = yamlFile(directory, REQUIRED[2]!);
  for (const [name, document, schemaFile] of [
    ["binding manifest", manifest, "runtimeconditions.binding-manifest.schema.yaml"],
    ["binding model", model, "runtimeconditions.binding-model.schema.yaml"],
  ] as const) {
    const validate = compile(loadSchema(schemaFile));
    if (!validate(document)) {
      fail(stage, `the ${name} does not match its schema: ${describeErrors(validate)}`, where);
    }
  }
  const core = model.coreProfileSchema;
  const identity = (id: string, version: string, digest: string) => core?.id === id && core?.version === version && core?.semanticSha256 === digest;
  if (!identity(CORE_SCHEMA_ID, CORE_SCHEMA_VERSION, CORE_SCHEMA_SEMANTIC_SHA256) && !identity(...CORE_SCHEMA_0_2_0)) {
    fail(stage, `the package was generated against core profile schema ${core?.version} (${core?.semanticSha256}); this profiler bundles ${CORE_SCHEMA_VERSION} (${CORE_SCHEMA_SEMANTIC_SHA256})`, where);
  }
  if (manifest.package.language !== "typescript") {
    fail(stage, `the package language is ${manifest.package.language}, not typescript`, where);
  }
  if (manifest.package.coordinate !== pkg.name || manifest.package.version !== pkg.version) {
    fail(stage, "the manifest package identity differs from package.json", where);
  }
  if (manifest.model.semanticSha256 !== model.metadata.semanticSha256) {
    fail(stage, "the manifest and the binding model disagree on the model digest", where);
  }
  if (manifest.extension.id !== model.rootExtension.id || manifest.extension.semanticSha256 !== model.rootExtension.semanticSha256) {
    fail(stage, "the manifest and the binding model disagree on the root extension", where);
  }
  if (extension?.metadata?.id !== manifest.extension.id) {
    fail(stage, "the extension definition id differs from the manifest extension id", where);
  }
  return {
    directory,
    name: pkg.name,
    version: pkg.version,
    extensionId: manifest.extension.id,
    extensionSha256: manifest.extension.semanticSha256,
    declarations: manifest.declarations.map((item: any) => ({
      sourceName: item.sourceName,
      function: item.function,
      owner: item.owner,
    })),
    rootBindings: manifest.rootBindings,
    types: new Map(manifest.types.map((item: TypeEntry) => [item.nativeName, item])),
    model,
    dependencies: Object.keys(pkg.dependencies ?? {}),
  };
}

export class Catalog {
  private readonly loaded = new Map<string, Binding>();

  load(directory: string): Binding {
    const key = resolve(directory);
    let binding = this.loaded.get(key);
    if (!binding) {
      binding = loadBinding(key);
      this.loaded.set(key, binding);
    }
    return binding;
  }

  closure(roots: Binding[]): Binding[] {
    const seen = new Map<string, Binding>();
    const visit = (binding: Binding): void => {
      if (seen.has(binding.directory)) {
        return;
      }
      seen.set(binding.directory, binding);
      for (const name of binding.dependencies) {
        const directory = findPackage(binding.directory, name);
        if (directory && isBinding(directory)) {
          visit(this.load(directory));
        }
      }
    };
    roots.forEach(visit);
    const closure = [...seen.values()];
    for (const binding of closure) {
      for (const entry of binding.model.extensions as any[]) {
        if (entry.id === binding.extensionId) {
          continue;
        }
        const provider = closure.find((other) => other.extensionId === entry.id);
        if (!provider) {
          fail("bindings", `the dependency ${entry.id} has no installed binding package`, `${binding.name}@${binding.version}`);
        }
        if (provider.extensionSha256 !== entry.semanticSha256) {
          fail("bindings", `the installed ${provider.name} differs from the extension ${entry.id} that ${binding.name} was generated against`);
        }
      }
    }
    return closure.sort((a, b) => a.name.localeCompare(b.name));
  }
}

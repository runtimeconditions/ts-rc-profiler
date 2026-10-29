import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import ts from "typescript";

import { findPackage, isBinding, packageName, type Binding, type Catalog, type RootBinding, type TypeEntry, type TypeRef } from "./bindings.js";
import { fail } from "./errors.js";
import { readLimited } from "./read.js";
import type { Json, JsonObject } from "./schema.js";

export interface Extraction {
  conditions: JsonObject[];
  used: Binding[];
}

interface Imported {
  module: string;
  name: string;
}

interface Source {
  path: string;
  file: ts.SourceFile;
  imports: Map<string, Imported>;
}

interface Expected {
  binding: Binding;
  ref: TypeRef;
}

interface Instance {
  binding: Binding;
  entry: TypeEntry;
  value: Json;
}

const SKIPPED = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

export function projectFiles(root: string): string[] {
  const configPath = join(root, "tsconfig.json");
  return (existsSync(configPath) ? configuredFiles(root, configPath) : scannedFiles(root)).sort();
}

function scannedFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name) && !entry.name.startsWith(".")) {
          walk(join(directory, entry.name));
        }
      } else if (isSource(entry.name)) {
        found.push(join(directory, entry.name));
      }
    }
  };
  walk(root);
  return found;
}

// The files tsconfig.json selects through files, include, exclude and extends, minus anything
// reached through a symbolic link.
function configuredFiles(root: string, configPath: string): string[] {
  const read = ts.readConfigFile(configPath.split(sep).join("/"), (path) => readLimited(path, "extract").toString("utf-8"));
  if (read.error) {
    fail("extract", ts.flattenDiagnosticMessageText(read.error.messageText, "\n"), "tsconfig.json");
  }
  const realRoot = realpathSync(root);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root.split(sep).join("/"), undefined, configPath.split(sep).join("/"));
  return parsed.fileNames.map(normalize).filter((path) => isSource(path) && realpathSync(path) === join(realRoot, relative(root, path)));
}

function isSource(name: string): boolean {
  return EXTENSIONS.some((extension) => name.endsWith(extension)) && !name.endsWith(".d.ts");
}

export class Extractor {
  private readonly sources = new Map<string, Source>();
  private readonly used = new Map<string, Binding>();
  private readonly conditions: JsonObject[] = [];

  constructor(
    private readonly root: string,
    private readonly catalog: Catalog,
  ) {}

  run(files: string[]): Extraction {
    for (const path of files) {
      const source = this.source(path);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const target = this.reference(node.expression, source);
          const declaration = target?.binding.declarations.find((item) => item.function === target.name);
          if (target && declaration) {
            this.conditions.push(this.condition(node, declaration, target.binding, source));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source.file);
    }
    return { conditions: this.conditions, used: [...this.used.values()] };
  }

  private where(node: ts.Node, source: Source): string {
    const { line, character } = source.file.getLineAndCharacterOfPosition(node.getStart(source.file));
    return `${relative(this.root, source.path).split(sep).join("/")}:${line + 1}:${character + 1}`;
  }

  private source(path: string): Source {
    let source = this.sources.get(path);
    if (!source) {
      const file = ts.createSourceFile(path, readLimited(path, "extract").toString("utf-8"), ts.ScriptTarget.ES2022, true);
      const imports = new Map<string, Imported>();
      for (const statement of file.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause) {
          const module = statement.moduleSpecifier.text;
          const clause = statement.importClause;
          if (clause.name) {
            imports.set(clause.name.text, { module, name: "default" });
          }
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) {
            imports.set(bindings.name.text, { module, name: "*" });
          } else if (bindings) {
            for (const element of bindings.elements) {
              imports.set(element.name.text, { module, name: (element.propertyName ?? element.name).text });
            }
          }
        }
      }
      source = { path, file, imports };
      this.sources.set(path, source);
    }
    return source;
  }

  discover(files: string[]): Binding[] {
    const found = new Map<string, Binding>();
    for (const path of files) {
      const source = this.source(path);
      for (const imported of source.imports.values()) {
        const binding = this.bindingOf(imported.module, source);
        if (binding) {
          found.set(binding.directory, binding);
        }
      }
    }
    return [...found.values()];
  }

  private bindingOf(module: string, source: Source): Binding | undefined {
    if (module.startsWith(".")) {
      return undefined;
    }
    const directory = findPackage(dirname(source.path), packageName(module));
    return directory && isBinding(directory) ? this.catalog.load(directory) : undefined;
  }

  private reference(expression: ts.Expression, source: Source): { binding: Binding; name: string } | undefined {
    if (ts.isIdentifier(expression)) {
      const imported = source.imports.get(expression.text);
      const binding = imported && imported.name !== "*" ? this.bindingOf(imported.module, source) : undefined;
      return binding && imported ? { binding, name: imported.name } : undefined;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const imported = source.imports.get(expression.expression.text);
      const binding = imported?.name === "*" ? this.bindingOf(imported.module, source) : undefined;
      return binding ? { binding, name: expression.name.text } : undefined;
    }
    return undefined;
  }

  private condition(call: ts.CallExpression, declaration: { sourceName: string }, owner: Binding, source: Source): JsonObject {
    const where = this.where(call, source);
    this.used.set(owner.directory, owner);
    let iface: JsonObject | undefined;
    const fields: JsonObject = {};
    const placed: { root: RootBinding; at: string }[] = [];
    for (const argument of call.arguments) {
      const at = this.where(argument, source);
      if (ts.isSpreadElement(argument)) {
        fail("extract", "a spread argument cannot be read statically", at);
      }
      const instance = this.argument(argument, source, new Set());
      const root = instance.binding.rootBindings.find(
        (item) => item.value.type === instance.entry.nativeName && item.scope.kind === declaration.sourceName,
      );
      if (!root) {
        fail("extract", `${instance.entry.nativeName} is not a field of the ${declaration.sourceName} declaration`, at);
      }
      this.used.set(instance.binding.directory, instance.binding);
      placed.push({ root, at });
      if (root.role === "interface") {
        if (iface) {
          fail("extract", `the ${declaration.sourceName} declaration has more than one interface`, at);
        }
        iface = { type: root.fixedInterfaceType ?? root.sourceName, ...(instance.value as JsonObject) };
      } else {
        const key = root.path[0]!.name;
        if (key in fields) {
          fail("extract", `the field ${key} is declared twice`, at);
        }
        fields[key] = instance.value;
      }
    }
    if (!iface) {
      fail("extract", `the ${declaration.sourceName} declaration has no interface`, where);
    }
    for (const { root, at } of placed) {
      if (root.scope.interfaceType && root.scope.interfaceType !== iface.type) {
        fail("extract", `${root.sourceName} belongs to the ${root.scope.interfaceType} interface, not ${String(iface.type)}`, at);
      }
    }
    const sorted = Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));
    return { kind: declaration.sourceName, interface: iface, ...sorted };
  }

  private argument(node: ts.Expression, source: Source, seen: Set<ts.Node>): Instance {
    const inner = this.unwrap(node);
    if (ts.isNewExpression(inner)) {
      return this.instantiate(inner, source);
    }
    if (ts.isIdentifier(inner)) {
      const constant = this.constant(inner.text, source);
      if (constant && !seen.has(constant.node)) {
        return this.argument(constant.node, constant.source, new Set(seen).add(constant.node));
      }
    }
    return fail("extract", "a declaration argument must be a new expression of a generated type", this.where(node, source));
  }

  private unwrap(node: ts.Expression): ts.Expression {
    let current = node;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  }

  private instantiate(node: ts.NewExpression, source: Source): Instance {
    const target = this.reference(node.expression, source);
    const entry = target?.binding.types.get(target.name);
    if (!target || !entry || (entry.construct !== "object" && entry.construct !== "wrapper")) {
      fail("extract", "only classes generated by an installed binding package can be constructed", this.where(node, source));
    }
    const argument = node.arguments?.[0];
    const value = this.fields(argument, entry, target.binding, source, this.where(node, source));
    return { binding: target.binding, entry, value };
  }

  private fields(node: ts.Expression | undefined, entry: TypeEntry, binding: Binding, source: Source, where: string): Json {
    let literal = node && this.unwrap(node);
    let current = source;
    for (const seen = new Set<ts.Node>(); literal && ts.isIdentifier(literal); ) {
      const constant = this.constant(literal.text, current);
      if (!constant || seen.has(constant.node)) {
        break;
      }
      seen.add(constant.node);
      literal = this.unwrap(constant.node);
      current = constant.source;
    }
    if (literal && !ts.isObjectLiteralExpression(literal)) {
      fail("extract", "the fields of a generated class must be an object literal", this.where(literal, current));
    }
    const out: JsonObject = {};
    for (const property of literal?.properties ?? []) {
      const at = this.where(property, current);
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        fail("extract", "only plain properties can be read statically", at);
      }
      const name = this.propertyName(property.name, at);
      const field = entry.fields?.find((item) => item.nativeName === name);
      if (!field) {
        fail("extract", `${entry.nativeName} has no field ${name}`, at);
      }
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      out[field.sourceName] = this.evaluate(initializer, current, { binding, ref: field.value }, new Set());
    }
    for (const field of entry.fields ?? []) {
      if (field.required && !(field.sourceName in out)) {
        fail("extract", `${entry.nativeName} is missing the required field ${field.nativeName}`, where);
      }
    }
    if (entry.construct === "wrapper") {
      return out[entry.fields![0]!.sourceName] ?? null;
    }
    return out;
  }

  private propertyName(name: ts.PropertyName, at: string): string {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
      return name.text;
    }
    return fail("extract", "a computed property name cannot be read statically", at);
  }

  private constant(name: string, source: Source): { node: ts.Expression; source: Source } | undefined {
    for (const statement of source.file.statements) {
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
            return { node: declaration.initializer, source };
          }
        }
      }
    }
    const imported = source.imports.get(name);
    if (imported?.module.startsWith(".") && imported.name !== "*" && imported.name !== "default") {
      const path = this.module(imported.module, source);
      return path ? this.constant(imported.name, this.source(path)) : undefined;
    }
    return undefined;
  }

  private module(specifier: string, source: Source): string | undefined {
    const base = resolve(dirname(source.path), specifier);
    const stem = base.replace(/\.(m|c)?js$/, "");
    const candidates = [base, ...EXTENSIONS.map((extension) => stem + extension), ...EXTENSIONS.map((extension) => join(base, `index${extension}`))];
    return candidates.find((candidate) => existsSync(candidate) && /\.(m|c)?tsx?$/.test(candidate) && this.inside(candidate));
  }

  private inside(path: string): boolean {
    const offset = relative(realpathSync(this.root), realpathSync(path));
    return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
  }

  private entry(expected: Expected | undefined): TypeEntry | undefined {
    return expected?.ref.type ? expected.binding.types.get(expected.ref.type) : undefined;
  }

  private evaluate(node: ts.Expression, source: Source, expected: Expected | undefined, seen: Set<ts.Node>): Json {
    const inner = this.unwrap(node);
    const at = this.where(inner, source);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
      return inner.text;
    }
    if (ts.isNumericLiteral(inner)) {
      return Number(inner.text);
    }
    if (inner.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }
    if (inner.kind === ts.SyntaxKind.FalseKeyword) {
      return false;
    }
    if (inner.kind === ts.SyntaxKind.NullKeyword) {
      return null;
    }
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(inner.operand)) {
      return -Number(inner.operand.text);
    }
    if (ts.isNewExpression(inner)) {
      return this.instantiate(inner, source).value;
    }
    if (ts.isTemplateExpression(inner)) {
      let text = inner.head.text;
      for (const span of inner.templateSpans) {
        text += `${this.scalar(this.evaluate(span.expression, source, undefined, seen), span.expression, source)}${span.literal.text}`;
      }
      return text;
    }
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.scalar(this.evaluate(inner.left, source, undefined, seen), inner.left, source);
      const right = this.scalar(this.evaluate(inner.right, source, undefined, seen), inner.right, source);
      return typeof left === "number" && typeof right === "number" ? left + right : `${left}${right}`;
    }
    const entry = this.variant(this.entry(expected), expected, inner);
    if (ts.isArrayLiteralExpression(inner)) {
      const element = entry?.element ? { binding: expected!.binding, ref: entry.element.value } : undefined;
      return inner.elements.map((item) => {
        if (ts.isSpreadElement(item) || ts.isOmittedExpression(item)) {
          fail("extract", "only plain array elements can be read statically", this.where(item, source));
        }
        return this.evaluate(item, source, element, seen);
      });
    }
    if (ts.isObjectLiteralExpression(inner)) {
      if (entry && (entry.construct === "object" || entry.construct === "wrapper")) {
        return this.fields(inner, entry, expected!.binding, source, at);
      }
      const element = entry?.element ? { binding: expected!.binding, ref: entry.element.value } : undefined;
      const out: JsonObject = {};
      for (const property of inner.properties) {
        const place = this.where(property, source);
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
          fail("extract", "only plain properties can be read statically", place);
        }
        const initializer = ts.isPropertyAssignment(property) ? property.initializer : property.name;
        out[this.propertyName(property.name, place)] = this.evaluate(initializer, source, element, seen);
      }
      return out;
    }
    if (ts.isPropertyAccessExpression(inner)) {
      const enumeration = ts.isIdentifier(inner.expression) ? this.reference(inner.expression, source) : undefined;
      const type = enumeration?.binding.types.get(enumeration.name);
      if (enumeration && type?.construct === "scalar") {
        const member = type.members?.find((item) => item.nativeName === inner.name.text);
        if (!member) {
          fail("extract", `${enumeration.name} has no member ${inner.name.text}`, at);
        }
        return member.value;
      }
      const base = this.evaluate(inner.expression, source, undefined, seen);
      if (base && typeof base === "object" && !Array.isArray(base) && inner.name.text in base) {
        return base[inner.name.text] as Json;
      }
    }
    if (ts.isIdentifier(inner)) {
      const constant = this.constant(inner.text, source);
      if (constant && !seen.has(constant.node)) {
        return this.evaluate(constant.node, constant.source, expected, new Set(seen).add(constant.node));
      }
    }
    return fail("extract", "this value cannot be determined statically", at);
  }

  private scalar(value: Json, node: ts.Node, source: Source): string | number | boolean {
    if (value === null || typeof value === "object") {
      fail("extract", "only strings, numbers, and booleans can be joined statically", this.where(node, source));
    }
    return value;
  }

  private variant(entry: TypeEntry | undefined, expected: Expected | undefined, node: ts.Expression): TypeEntry | undefined {
    if (entry?.construct !== "union" || !expected) {
      return entry;
    }
    const keys = ts.isObjectLiteralExpression(node)
      ? node.properties.flatMap((item) => (item.name && ts.isIdentifier(item.name) ? [item.name.text] : []))
      : [];
    for (const item of entry.variants ?? []) {
      const candidate = item.value.type ? expected.binding.types.get(item.value.type) : undefined;
      if (!candidate) {
        continue;
      }
      if (ts.isArrayLiteralExpression(node) && candidate.construct === "collection") {
        return candidate;
      }
      if (ts.isObjectLiteralExpression(node) && candidate.construct === "object") {
        const names = new Set(candidate.fields?.map((field) => field.nativeName));
        const required = (candidate.fields ?? []).filter((field) => field.required).map((field) => field.nativeName);
        if (keys.every((key) => names.has(key)) && required.every((key) => keys.includes(key))) {
          return candidate;
        }
      }
      if (ts.isObjectLiteralExpression(node) && candidate.construct === "map") {
        return candidate;
      }
    }
    return undefined;
  }
}

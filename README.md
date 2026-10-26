# Runtime Conditions TypeScript profiler

The profiler turns declarations in a TypeScript codebase into a validated
[Runtime Conditions](https://runtimeconditions.github.io/) Profile. Your code
calls the declaration functions of **generated binding packages installed in
`node_modules`**. The profiler finds those packages, verifies their resources, and
reads your source **without importing or running it**. Node.js 20.19 or newer is
required.

It does for TypeScript what the
[Python profiler](https://github.com/runtimeconditions/python-rc-profiler) does for Python.

## Install

```sh
npm install --save-dev @runtimeconditions/typescript-profiler \
  @runtimeconditions/common-integrations @runtimeconditions/env-configuration
```

The binding packages come from the generated TypeScript bindings in
[`runtimeconditions/extensions`](https://github.com/runtimeconditions/extensions). The
example names above are illustrative; install the bindings your code declares against.

## Declare conditions in your workload

Use the API of the installed binding:

```ts
import { cache, KeyValue, KeyValueEngine } from "@runtimeconditions/common-integrations";
import {
  KeyValueConfiguration,
  KeyValueConfigurationEnvItem,
  KeyValueConfigurationEnvItemProperty,
} from "@runtimeconditions/env-configuration";

export const sessions = cache(
  new KeyValue({ engine: KeyValueEngine.Redis }),
  new KeyValueConfiguration({
    env: [new KeyValueConfigurationEnvItem({ name: "REDIS_URL", property: KeyValueConfigurationEnvItemProperty.Scheme })],
  }),
);
```

The declaration function, classes, enum members, and fields come from the binding
publisher. Values may be string, number, boolean, and null literals, enum members,
arrays, objects, template literals and `+` over strings and numbers, `new` expressions
of generated classes, plain object literals where a generated class is expected, and
`const` declarations in the same file or in a relative module. Anything else that a
recognized declaration depends on, such as a function call or `process.env`, fails with
its source location.

Every file the profiler reads (workload sources, binding resources, `package.json`) is
limited to 64 MiB and fails with a clear error beyond that.

## Verify bindings and generate a profile

```sh
npx runtimeconditions-typescript-profiler profile verify-bindings --project .

npx runtimeconditions-typescript-profiler profile generate \
  --project . \
  --name orders \
  --workload-uri https://services.example.com/orders \
  --workload-version 1.0.0 \
  --out runtimeconditions.profile.yaml
```

`verify-bindings` lists the binding packages your sources import and the packages they
depend on; add `--json` for machine-readable output. `profile generate` prints the profile
to standard output when `--out` is omitted, and writes the file atomically, only after the
whole profile validates. An error exits with status 1 and leaves any existing output
untouched.

## What is verified

For every binding package the profiler reads, it checks:

- the three resources `runtimeconditions.bindings.yaml`, `runtimeconditions.binding-model.yaml`,
  and `runtimeconditions.extension.yaml` exist and match the digests in
  `runtimeconditions.file-manifest.yaml`;
- the manifest and the binding model match the bundled schemas, and the manifest, the
  model, the extension definition, and `package.json` agree on identity, version, model
  digest, and root extension;
- the model was generated against the core profile schema this profiler bundles, by
  identity and semantic digest;
- every extension the model depends on is provided by an installed binding package with
  the same semantic digest.

The finished profile is validated against the bundled core profile schema and against every
applicable extension schema in the verified closure. The profile lists the extensions that
directly contribute declarations.

## Limits

- Only core profile schema 0.4.0 is bundled. Packages generated against another version are
  rejected with the versions named.
- Vocabulary ownership rules are not checked beyond what the extension schemas express.
- Extraction is syntactic. It does not use the type checker, so type aliases, generics, and
  re-exported bindings are not followed.
- `name` and `optional` condition properties cannot be set, because bindings do not expose them.

## Releases

Merging a `feat`, `fix`, `perf`, `revert`, or breaking change to `main` publishes to npm and
tags the release; see [CONTRIBUTING.md](CONTRIBUTING.md).

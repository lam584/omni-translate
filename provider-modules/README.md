# Provider modules

Each directory in this folder owns one vendor's product contract. Its
`manifest.json` is the source of truth consumed by both the renderer and the
Rust runtime.

The shared Core may resolve references, validate manifests, migrate legacy
configuration, and provide transport/audio primitives. Vendor endpoints,
authentication rules, event dialects, model bindings, and lifecycle decisions
belong in the provider module.

Runtime protocol selection is exact: provider id + model id + operation must
resolve to one versioned protocol profile. Model-name inference is reserved for
legacy configuration migration and never grants connection authority.

Adapter verification is explicit:

- `live-verified`: exercised against the real provider with retained evidence;
- `fixture-only`: implemented or described from official wire fixtures only;
- `not-implemented`: manifest metadata is available, but connection attempts
  must fail before network I/O.

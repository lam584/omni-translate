# Provider modules

Each directory in this folder owns one vendor's product contract. Its
`manifest.json` is the source of truth consumed by both the renderer and the
Rust runtime. Bailian is the explicit generated-manifest exception: see
`bailian/README.md` for its disjoint lossless realtime registry and text catalog
sources, projection tool, and generated-file checks.

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

## Optional advisory capability metadata

A model may carry `capabilityMetadata` with the optional fields `capabilities`,
`interactionCapabilities`, `realtimeAudioMode`, `apiModes`, and `releasedAt`.
These are advisory UI/legacy seed values, not executable protocol authority.
Consumers must preserve field absence versus explicit empty arrays and must not
infer adapter enablement, endpoints or operation authorization from this object.
The strict manifest schema rejects unknown fields and validates date/enum values;
the manifest loader also validates this object before bundle generation.

The initial non-Bailian migration copies matching exact IDs from the frozen
`apps/desktop/src/schema/model-registry-v1-seed.json` snapshot into each owning
module, including model IDs shared by multiple vendors. That snapshot is only a
migration/compatibility fixture, not a second editable source for owned models.
Unowned seed entries remain static compatibility data. Tests compare every copied
value and pin the unchanged non-advisory manifest contents.

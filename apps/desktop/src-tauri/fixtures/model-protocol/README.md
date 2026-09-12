# Bailian model protocol wire fixtures

These fixtures are sanitized, zero-credential protocol examples derived from the
official Alibaba Cloud Model Studio documentation listed in each file. They are
contract evidence only: a fixture or manifest entry does not enable a production
adapter.

Every sequence preserves only fields needed to distinguish endpoint, framing,
readiness, preview semantics, response trigger, and terminal lifecycle. IDs and
media payloads are synthetic. Every `sources[]` entry pins both the official URL
and `checkedAt=2026-08-30`; changing an event meaning requires a new
dialect/profile version rather than editing the old meaning in place.

Task-protocol fixtures contain two successful tasks on one connection. The first
`task-finished` must precede the second `run-task`, every task uses a fresh
`header.task_id`, binary frames carry their active task identity, and the fixture
explicitly asserts that `task-failed` invalidates the connection. This separates
the connection owner from each task owner and prevents cross-task result reuse.

The multimodal-dialog fixture preserves both layers of the wire message:
`header.action/event` is the outer task envelope, while
`payload.input.directive/output.event` is the application event. Binary input is
not legal after `Started`; it is gated by a later `DialogStateChanged` whose state
is exactly `Listening`.

The sealed allowlists are independently cross-checked against the official page
heading catalog in `contracts/model-protocol-official-event-catalog.v1.json`.
`binary.audio` is an explicit framing pseudo-event; all other allowlisted event
types must have an official event-page or protocol-message catalog entry.

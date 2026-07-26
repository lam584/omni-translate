/**
 * Runtime aggregate contract. The type shapes are GENERATED from the Rust
 * contract structs (see ./generated/runtime-core.ts and the contract_export
 * cargo test); this module re-exports them, derives the union aliases the
 * rest of the app imports, and keeps the pinned cross-process event names.
 */
import type {
  BridgeRuntimeSnapshot,
  RuntimeNotification,
  RuntimeSnapshot,
  RuntimeWindowSnapshot,
} from './generated/runtime-core';

export type {
  BridgeRuntimeSnapshot,
  DiagnosticLogCategoryRuntime,
  DiagnosticLogEntryRuntime,
  DiagnosticSupportSignalRuntime,
  DiagnosticsExportArtifact,
  DiagnosticsRuntimeSnapshot,
  DriverOperationResult,
  ModelTraceCallRuntime,
  ModelTraceSummaryRuntime,
  RuntimeNotification,
  RuntimeSnapshot,
  RuntimeWindowSnapshot,
  StorageRuntimeSnapshot,
} from './generated/runtime-core';

// Union aliases derived from the generated fields, so the literal members
// have exactly one source of truth (the Rust contract).
export type RuntimeCoreState = RuntimeSnapshot['coreState'];
export type RuntimeBridgeStatus = RuntimeSnapshot['bridgeStatus'];
export type BridgeProcessStatus = BridgeRuntimeSnapshot['processStatus'];
export type RuntimeWindowKind = RuntimeWindowSnapshot['kind'];
export type RuntimeNotificationLevel = RuntimeNotification['level'];

export const RUNTIME_SNAPSHOT_EVENT = 'runtime://snapshot';
export const RUNTIME_NOTIFICATION_EVENT = 'runtime://notification';

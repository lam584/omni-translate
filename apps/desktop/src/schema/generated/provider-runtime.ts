// GENERATED FILE - do not edit by hand.
// Source of truth: apps/desktop/src-tauri/src/{provider,storage}/contracts.rs + main.rs
// Regenerate: OMNI_UPDATE_CONTRACTS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_export

import type { ProviderCapability } from '../provider-contract';
import type { ProviderProbeCheckStatus, ProviderProbeVerdict } from '../provider-probe';

export type ProviderRuntimeError = { code: string, message: string, retriable: boolean, httpStatus: number | null, providerCode: string | null, suggestion: string | null, };

export type ProviderRoutingDecision = { subtitlePriority: 'balanced' | 'subtitle-first', speechDisposition: 'ready' | 'deferred' | 'queued', rationale: string, };

export type ProviderProbeCheckRuntime = { id: string, key: 'streaming' | 'latency' | 'error-shape' | 'response-shape', label: string, status: ProviderProbeCheckStatus, summary: string, };

export type ProviderProbeProfileRuntime = { id: string, templateId: string, providerId: string, verdict: ProviderProbeVerdict, checkedAt: string, measuredLatencyMs: number, latencyBudgetMs: number, streamSupported: boolean, errorShapeStable: boolean, responseShapeStable: boolean, transportRequested: string, transportEffective: string, fallbackApplied: boolean, inputTokens: number | null, outputTokens: number | null, audioSeconds: number | null, checks: Array<ProviderProbeCheckRuntime>, guidance: Array<string>, routingDecision: ProviderRoutingDecision, error: ProviderRuntimeError | null, };

export type ProviderStreamEventRecord = { eventType: string, summary: string, segmentId: string | null, textDelta: string | null, text: string | null, audioChunkRef: string | null, };

export type ProviderSmokeResult = { requestId: string, providerId: string, status: 'completed' | 'failed', transportRequested: string, transportEffective: string, fallbackApplied: boolean, streamObserved: boolean, durationMs: number, firstEventLatencyMs: number | null, transcript: string, sourceLanguage: string, targetLanguage: string, eventLog: Array<ProviderStreamEventRecord>, inputTokens: number | null, outputTokens: number | null, audioSeconds: number | null, routingDecision: ProviderRoutingDecision, error: ProviderRuntimeError | null, };

export type ProviderModelRuntime = { id: string, displayName: string, ownedBy: string | null, createdAt: number | null, capabilities: Array<ProviderCapability>, };

export type ProviderModelCatalogRuntime = { providerId: string, endpoint: string, fetchedAt: string, models: Array<ProviderModelRuntime>, error: ProviderRuntimeError | null, };

export type CredentialRefStatus = { reference: string, backend: string, hasSecret: boolean, };

export type CredentialSecretPayload = { reference: string, backend: string, secret: string | null, };

export type CredentialDirectResultEvent = { jobId: string, reference: string, success: boolean, detail: string | null, error: string | null, elapsedMs: number, };


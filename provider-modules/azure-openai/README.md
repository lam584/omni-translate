# Azure OpenAI provider module

This module records Azure OpenAI contracts checked against Microsoft Learn on
2026-08-31. Every fixture is documentation-derived, sanitized, and explicitly
marked `capturedFromLive: false`; no Azure resource was contacted.

## Catalog identity and deployment addressing

`models[].id` is the Microsoft catalog identity, such as
`gpt-realtime-2.1`. A runtime configuration must separately retain an opaque
user deployment id. Conversation profiles additionally need an independent
input-transcription deployment id:

```text
catalogModelId                 = gpt-realtime-2.1
deploymentId                   = watch-realtime-prod
inputTranscriptionDeploymentId = watch-stt-prod
```

Neither deployment id is a model alias, and neither may select a protocol by
substring. The profile id and version grant connection authority; deployment
ids are injected only into the profile-defined URL or session body locations.

## Authentication

The manifest declares the three documented Azure OpenAI choices separately:

- `azure-openai.auth.api-key-header` (`api-key` handshake header);
- `azure-openai.auth.api-key-query` (`api-key` WebSocket query parameter);
- `azure-openai.auth.entra-bearer` (OAuth2 token for
  `https://ai.azure.com/.default`).

The current runtime only implements header authentication. Query-key and Entra
token acquisition/refresh are contract metadata until provider-owned adapters
implement them.

## API family boundaries

- GA Realtime uses `/openai/v1` and no date-based `api-version`.
- The deprecated preview URL
  `/openai/realtime?api-version=2025-04-01-preview&deployment=...` is retained
  only as a disabled migration profile. Combining its parameters with the GA
  path is an error.
- Realtime transcription explicitly uses
  `/openai/v1/realtime?intent=transcription`; its session transcription model
  is an Azure deployment id.
- The v1 Audio REST reference is preview. The older deployment-path Whisper
  endpoint with `api-version=2024-02-01` remains a distinct API family.

Conversation and translation profiles are disabled until the shared runtime
stops hard-coding an OpenAI transcription model, accepts separate deployment
roles, sends the restricted translation session shape, and implements the
documented readiness lifecycle. The header-authenticated realtime
transcription profiles are fixture-verified only. Nothing is live-verified.

Azure AI Speech is a separate service with separate resources, keys, regions,
and protocol contracts; it must be represented by a different provider module.

## Official sources

- https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio
- https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets
- https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc
- https://learn.microsoft.com/en-us/azure/foundry/openai/realtime-audio-reference
- https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/audio
- https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability
- https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest
- https://learn.microsoft.com/en-us/azure/foundry/openai/whisper-quickstart

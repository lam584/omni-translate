# Watch Mode speech benchmark fixtures

These fixtures are original synthetic speech created for Omni Translate. They
do not contain recordings copied from videos, broadcasts, films, or human
speakers.

## Bundled audio

The repository contains one complete speech fixture:
`watch-mode-en-original.wav`. It is the original 24 kHz, 16-bit mono PCM
canonical source (5.76 MiB, 125.815 seconds). Its exact bytes remain stable for
strict Watch Mode evidence, integration tests, and the desktop benchmark UI.
The adjacent checksum and the `general` entry in
`watch-mode-audio-fixtures.json` bind those bytes.

The conversation, technical, and 19 localized variants are recipes rather
than checked-in binaries. Their source/reference text and generation metadata
remain in Git, while their WAV and checksum outputs are generated only when a
developer explicitly needs those diagnostic variants. This keeps a clean
checkout small without requiring Git LFS or an external download host.

The direct runner's 180-second Watch capture budget can consume each fixture
in full. The matrix runner may intentionally impose a shorter per-model budget;
use it only when a sampled run is desired or pass limits compatible with the
current matrix policy.

For `npm run test:audio-model-integration`, set both `audioTestFile` and
`audio.testFile` in the local `scripts/testing/llm-integration.config.json` to
the chosen path. The file is local test configuration and its credential must
never be committed or printed.

`watch-mode-audio-fixtures.json` marks the canonical fixture as `bundled` and
the two optional English choices as `generated-on-demand`.

## Project-language set

The `multilingual/` directory keeps one translated General-template text for
each of the other 19 languages declared in
`apps/desktop/src/i18n/languages.ts`. Together with the English General text,
the set covers all 20 project languages. The generator uses the same Alibaba
Cloud Model Studio model and voice, then deterministically resamples returned
PCM to the repository's 16 kHz mono fixture format.

Choose any language by passing its path, for example:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/run-watch-mode-live.ps1 -MediaPath scripts/testing/fixtures/multilingual/watch-mode-general.zh-CN.wav
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/run-watch-mode-live.ps1 -MediaPath scripts/testing/fixtures/multilingual/watch-mode-general.ja.wav
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/run-watch-mode-live.ps1 -MediaPath scripts/testing/fixtures/multilingual/watch-mode-general.hi.wav
```

See `multilingual/manifest.json` for the complete language-to-file mapping and
the metadata from the last generated set. Its `audioDistribution` field makes
clear that those outputs are not bundled.

## Regeneration

The generators read `DASHSCOPE_API_KEY` or the private key referenced by the
local integration config. They never write the key into generated metadata.

Generate one English choice (use `conversation` or `technical` for optional
variants, and `general` only when intentionally replacing the canonical
fixture):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/fixtures/generate-watch-mode-audio.ps1 -Fixture conversation
```

Regenerate all localized texts and audio, or audio only:

```powershell
node scripts/testing/fixtures/generate-watch-mode-multilingual.mjs --languages all
node scripts/testing/fixtures/generate-watch-mode-multilingual.mjs --audio-only --languages all
```

Use a comma-separated subset such as `--languages zh-CN,ja,hi` when only a few
fixtures are needed. The generators write an adjacent checksum and update the
manifest after successful generation. Optional WAV/checksum outputs are local
diagnostic artifacts: do not commit them. Pass an output through the runner's
`-MediaPath` or the desktop benchmark's custom-path option, then remove it when
the diagnostic run is complete. Normal development and CI use the bundled
canonical fixture and require no provider call.

## Automatic benchmark scoring

Every `run-watch-mode-live.ps1` run writes `benchmark-score.json` beside
`report.json`. Its schema and version are `benchmark-score/v1`; do not compare
it with an older score file. The four independently reported dimensions are
semantic quality (40%), latency (30%), completeness (20%), and stability
(10%). Rules are read from
[`contracts/benchmark-score-v1-rules.json`](../../../contracts/benchmark-score-v1-rules.json),
which is also used by the desktop benchmark UI.

There is a formal total only when the benchmark completed and every dimension
has evidence. In particular, semantic quality needs both a reference
translation and successful LLM judgment for every completed run. A failed,
interrupted, incomplete, or insufficiently evidenced benchmark records its
per-dimension evidence but has `total: null`; it is never turned into a fake
zero or a capped passing/failing score. `status` is one of `official`,
`benchmark-running`, `judging`, `evidence-insufficient`, `judge-failed`, or
`benchmark-failed`.

The score file is intended to answer “why”: it stores the weights and
thresholds used, chrF2 per-order precision/recall/matches, every run's latency
signal and threshold zone, incomplete runs, individual extra-response
deductions, and per-run LLM-judge rationale/errors. chrF2 uses Unicode NFKC,
removes whitespace, and preserves case and punctuation. It scores character
1–6 grams with beta=2.

The pre-v1 Watch queue fields named `firstVisibleTranslationLatencySeconds` and
`firstFinalTranslationLatencySeconds` measure from `cue_started`, not from
`responseCreated`. They remain in the raw run contribution for diagnosis, but
do not satisfy v1's formal response-relative latency evidence.

Score or re-score an existing run directory:

```powershell
node ./scripts/testing/watch-mode-score.mjs --input artifacts/testing/watch-mode-live/<run>
node ./scripts/testing/watch-mode-score.mjs --input artifacts/testing/watch-mode-live/<run> --source scripts/testing/fixtures/watch-mode-en-original.txt --reference scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt
```

Known fixture media paths are automatically matched to adjacent source and
reference text. For custom audio, pass both `--source` and `--reference`; the
run still has a history/report if they are unavailable, but cannot have a
formal semantic or total score.

After a completed run with source/reference evidence, the script automatically
uses the selected judge model when `DASHSCOPE_API_KEY` is available. It defaults
to `qwen3.5-plus`; override the model, endpoint, credential environment name,
or target language with `--judge-model`, `--endpoint`, `--api-key-env`, and
`--target-language`. `--llm-judge` remains accepted for explicit invocations,
and `--no-llm-judge` deliberately leaves the record without a formal semantic
score. No API key, authorization header, or judge HTTP response body is written
to `benchmark-score.json`.

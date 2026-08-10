# Watch Mode speech benchmark fixtures

These fixtures are original synthetic speech created for Omni Translate. They
do not contain recordings copied from videos, broadcasts, films, or human
speakers.

## English choices

All three English fixtures use Alibaba Cloud Model Studio
`qwen-audio-3.0-tts-plus`, 24 kHz 16-bit mono WAV, and a near-normal `0.95`
speech rate. They intentionally cover dates, times, money, measurements,
proper names, spelling, acronyms, quoted speech, questions, and sentence-length
variation.

| Choice | Audio | Focus | Duration |
| --- | --- | --- | --- |
| General (default) | `watch-mode-en-original.wav` | News and project briefing | 125.815 s |
| Conversation | `watch-mode-en-conversation.wav` | Everyday dialogue and instructions | 144.393 s |
| Technical | `watch-mode-en-technical.wav` | Technical and public-information speech | 149.075 s |

The existing test path remains `watch-mode-en-original.wav`, so tests written
before this upgrade continue to work. Select another fixture through the
existing media-path option, for example:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/run-watch-mode-live.ps1 -MediaPath scripts/testing/fixtures/watch-mode-en-conversation.wav
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/run-watch-mode-live.ps1 -MediaPath scripts/testing/fixtures/watch-mode-en-technical.wav
```

The direct runner's 180-second Watch capture budget can consume each fixture
in full. The matrix runner may intentionally impose a shorter per-model budget;
use it only when a sampled run is desired or pass limits compatible with the
current matrix policy.

For `npm run test:audio-model-integration`, set both `audioTestFile` and
`audio.testFile` in the local `scripts/testing/llm-integration.config.json` to
the chosen path. The file is local test configuration and its credential must
never be committed or printed.

`watch-mode-audio-fixtures.json` records the exact model, voice, seed, duration,
format, and SHA-256 digest for the three English choices.

## Project-language set

The `multilingual/` directory contains one General-template fixture for each of
the other 19 languages declared in `apps/desktop/src/i18n/languages.ts`.
Together with the English General fixture, the set covers all 20 project
languages. Every audio file uses the same Alibaba Cloud Model Studio
`qwen-audio-3.0-tts-plus` model, `longanlingxin` voice, and 24 kHz mono WAV
format. Per-language rates were calibrated from a first pass so the final
recordings stay close to two minutes without changing the benchmark concepts.

Choose any language by passing its path, for example:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/run-watch-mode-live.ps1 -MediaPath scripts/testing/fixtures/multilingual/watch-mode-general.zh-CN.wav
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/run-watch-mode-live.ps1 -MediaPath scripts/testing/fixtures/multilingual/watch-mode-general.ja.wav
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/run-watch-mode-live.ps1 -MediaPath scripts/testing/fixtures/multilingual/watch-mode-general.hi.wav
```

See `multilingual/manifest.json` for the complete language-to-file mapping,
source text, actual rate, duration, sample format, and checksum.

## Regeneration

The generators read `DASHSCOPE_API_KEY` or the private key referenced by the
local integration config. They never write the key into generated metadata.

Regenerate the three English choices:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/fixtures/generate-watch-mode-audio.ps1
```

Regenerate all localized texts and audio, or audio only:

```powershell
node scripts/testing/fixtures/generate-watch-mode-multilingual.mjs --languages all
node scripts/testing/fixtures/generate-watch-mode-multilingual.mjs --audio-only --languages all
```

Use a comma-separated subset such as `--languages zh-CN,ja,hi` when only a few
fixtures need refreshing. Generated audio must match its adjacent `.sha256`
file; normal development and CI consume the committed files directly and do
not require an API call.

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

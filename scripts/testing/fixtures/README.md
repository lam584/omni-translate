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

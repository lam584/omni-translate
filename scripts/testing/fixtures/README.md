# Original watch-mode audio fixture

`watch-mode-en-original.wav` is an original synthetic speech fixture for Omni Translate tests. It does not contain audio from YouTube, films, broadcasts, or a recorded human speaker.

The English source text, Chinese reference translation, generation script, and generated WAV are released under the repository's Apache-2.0 license. The WAV was generated offline with Windows SAPI token `TTS_MS_EN-US_ZIRA_11.0` (`Microsoft Zira Desktop - English (United States)`), rate `0`, volume `100`, and 22.05 kHz 16-bit mono PCM output.

Regenerate it on Windows with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/testing/fixtures/generate-watch-mode-audio.ps1
```

The generated file must match `watch-mode-en-original.sha256`. The committed WAV is consumed directly by tests; regenerating it is not required during normal development or CI.

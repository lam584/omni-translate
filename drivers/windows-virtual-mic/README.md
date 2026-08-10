# Windows Virtual Audio Driver

The production path uses the SYSVAD-derived `Omni Translate Virtual Speaker`
render endpoint and `Omni Translate Virtual Microphone` capture endpoint under
`sysvad/`. The render ring carries application audio into Bridge; the separate
generation-scoped microphone ring carries Bridge outbound PCM into applications
that select the virtual microphone.

The install/runtime minimum is Windows 10 build `19041`. The WDK build audits
the produced SYS import table so this declaration cannot drift below the actual
kernel API requirement.

Directory responsibilities:

1. `sysvad/`: vendored Microsoft SYSVAD sample plus both Omni endpoints and
   isolated render/microphone PCM rings.
2. `include/`: shared driver-to-Bridge IOCTL ABI, including session ownership,
   canonical format, and driver status counters.
3. `package/`: staged signed INF, SYS, CAT, and development public certificate.
4. `src/`: retired placeholder kept only for migration history.

See `BUILDING.md` for build, signing, and test-machine deployment.

`npm run driver:test` validates both the raw driver ABI and the installed v6
Bridge route. The Bridge-route stage uses a separate WASAPI target-capture
process and produces the three receipt-ready virtual-microphone artifacts. It
hard-fails when the endpoint or backend is unavailable; it never reports an
unsupported machine as a passing skip.

<!-- CI trigger trace: drivers/** change to exercise the Driver Build gate. -->

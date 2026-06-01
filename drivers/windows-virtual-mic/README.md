# Windows Virtual Audio Driver

The production path uses the SYSVAD-derived `Omni Translate Virtual Speaker`
WaveRT endpoint under `sysvad/`.

Directory responsibilities:

1. `sysvad/`: vendored Microsoft SYSVAD sample plus Omni endpoint and PCM ring.
2. `include/`: shared driver-to-Bridge IOCTL ABI.
3. `package/`: staged signed INF, SYS, CAT, and development public certificate.
4. `src/`: retired placeholder kept only for migration history.

See `BUILDING.md` for build, signing, and test-machine deployment.

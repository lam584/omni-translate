/*
 * Development scaffold for the Omni Translate virtual render endpoint.
 *
 * The production driver should be derived from Microsoft SYSVAD and expose a
 * render endpoint named "Omni Translate Virtual Speaker". The bridge service
 * currently writes PCM frames to the runtime sink file recorded in
 * driver-install-state.json so the app can validate routing without shipping
 * an unsigned kernel driver in this repository.
 */

int OmniVirtualAudioDriverScaffoldVersion(void) {
    return 900;
}

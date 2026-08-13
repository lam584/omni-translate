fn main() {
    println!("cargo:rerun-if-env-changed=OMNI_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=OMNI_PROVIDER_PREFLIGHT_COORDINATOR_KEY_ID");
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);

    tauri_build::try_build(attributes).expect("failed to run Tauri build script");
}

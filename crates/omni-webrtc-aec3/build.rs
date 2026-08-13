use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const VCPKG_TRIPLET: &str = "x64-windows-static-md";

fn main() {
    println!("cargo:rerun-if-changed=ffi/CMakeLists.txt");
    println!("cargo:rerun-if-changed=ffi/omni_webrtc_aec3.h");
    println!("cargo:rerun-if-changed=ffi/omni_webrtc_aec3.cc");
    println!("cargo:rerun-if-changed=ffi/omni_webrtc_aec3_fixture.cc");
    println!("cargo:rerun-if-env-changed=VCPKG_ROOT");
    println!("cargo:rerun-if-env-changed=VCPKG_INSTALLED_ROOT");
    println!("cargo:rerun-if-env-changed=CMAKE");
    println!("cargo:rerun-if-env-changed=CMAKE_GENERATOR");
    println!("cargo:rerun-if-env-changed=CMAKE_GENERATOR_PLATFORM");
    println!("cargo:rerun-if-env-changed=CMAKE_MAKE_PROGRAM");
    // The release gate supplies a fresh nonce for every invocation so Cargo
    // cannot reuse an earlier build-script result without executing the
    // native 15 dB CTest again. Ordinary release builds still execute CTest
    // whenever Cargo creates a new linked wrapper artifact.
    println!("cargo:rerun-if-env-changed=OMNI_AEC3_LINKED_GATE_RUN");

    if env::var_os("CARGO_FEATURE_LINKED").is_none() {
        return;
    }
    require_windows_msvc_x64();

    let manifest_dir = required_path("CARGO_MANIFEST_DIR");
    let out_dir = required_path("OUT_DIR");
    let workspace_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| panic!("failed to resolve workspace root from {}", manifest_dir.display()));
    let vcpkg_root = env::var_os("VCPKG_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.join("target").join("aec3-msvc-vcpkg"));
    let installed_root = env::var_os("VCPKG_INSTALLED_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.join("target").join("aec3-msvc-vcpkg-installed"));
    let triplet_root = installed_root.join(VCPKG_TRIPLET);
    let webrtc_header = triplet_root
        .join("include")
        .join("api")
        .join("audio")
        .join("audio_processing.h");
    let webrtc_library = triplet_root.join("lib").join("webrtc.lib");
    if !webrtc_header.is_file() || !webrtc_library.is_file() {
        panic!(
            "verified WebRTC AEC3 dependency is missing for {VCPKG_TRIPLET}; expected {} and {}. Install crates/omni-webrtc-aec3/vcpkg.json at builtin baseline ea1a7396b05637a53bf23c078647ecc0edee4b80",
            webrtc_header.display(),
            webrtc_library.display(),
        );
    }

    // Rust's MSVC debug profile still links the release CRT (`msvcrt`). The
    // vcpkg Debug archives use `/MDd` and therefore require `_CrtDbgReport`,
    // which cannot be mixed into a normal Rust executable. AEC3 is a bundled
    // production dependency, so use the optimized `/MD` archives for both
    // Rust profiles and keep one ABI across tests and release binaries.
    let cmake_config = "Release";
    let source_dir = manifest_dir.join("ffi");
    let build_dir = out_dir.join("cmake-build");
    let install_dir = out_dir.join("cmake-install");
    let toolchain = vcpkg_root
        .join("scripts")
        .join("buildsystems")
        .join("vcpkg.cmake");
    let cmake = env::var_os("CMAKE").unwrap_or_else(|| "cmake".into());
    let cmake_generator = env::var_os("CMAKE_GENERATOR");
    let cmake_generator_platform = env::var_os("CMAKE_GENERATOR_PLATFORM");
    let cmake_make_program = env::var_os("CMAKE_MAKE_PROGRAM");

    let mut configure = Command::new(&cmake);
    configure.arg("-S")
            .arg(&source_dir)
            .arg("-B")
            .arg(&build_dir)
            .arg(format!("-DCMAKE_TOOLCHAIN_FILE={}", toolchain.display()))
            .arg(format!("-DVCPKG_INSTALLED_DIR={}", installed_root.display()))
            .arg(format!("-DVCPKG_TARGET_TRIPLET={VCPKG_TRIPLET}"))
            .arg("-DVCPKG_MANIFEST_MODE=OFF")
            .arg("-DBUILD_TESTING=ON")
            .arg(format!("-DCMAKE_INSTALL_PREFIX={}", install_dir.display()));
    if let Some(generator) = cmake_generator {
        configure.arg("-G").arg(generator);
    }
    if let Some(platform) = cmake_generator_platform {
        configure.arg("-A").arg(platform);
    }
    if let Some(make_program) = cmake_make_program {
        configure.arg(format!("-DCMAKE_MAKE_PROGRAM={}", PathBuf::from(make_program).display()));
    }
    run(&mut configure, "configure the WebRTC AEC3 C ABI wrapper");
    run(
        Command::new(&cmake)
            .arg("--build")
            .arg(&build_dir)
            .arg("--config")
            .arg(cmake_config)
            .arg("--target")
            .arg("install"),
        "build the WebRTC AEC3 C ABI wrapper",
    );
    run(
        Command::new(&cmake)
            .arg("--build")
            .arg(&build_dir)
            .arg("--config")
            .arg(cmake_config)
            .arg("--target")
            .arg("omni_webrtc_aec3_fixture"),
        "build the deterministic WebRTC AEC3 fixture",
    );
    let ctest = cmake_sibling_tool(&cmake, "ctest");
    run(
        Command::new(ctest)
            .arg("--test-dir")
            .arg(&build_dir)
            .arg("--build-config")
            .arg(cmake_config)
            .arg("--output-on-failure")
            .arg("-R")
            .arg("^omni_webrtc_aec3_pure_echo_fixture$"),
        "run the deterministic 48 kHz/10 ms WebRTC AEC3 fixture",
    );

    println!("cargo:rustc-link-search=native={}", install_dir.join("lib").display());
    println!("cargo:rustc-link-lib=static=omni_webrtc_aec3_ffi");

    let dependency_lib_dir = triplet_root.join("lib");
    emit_vcpkg_static_libraries(&dependency_lib_dir);
    for system_library in [
        "ws2_32",
        "winmm",
        "iphlpapi",
        "msdmo",
        "dmoguids",
        "wmcodecdspuuid",
        "secur32",
        "crypt32",
        "bcrypt",
        "ncrypt",
        "user32",
        "advapi32",
    ] {
        println!("cargo:rustc-link-lib={system_library}");
    }
}

fn cmake_sibling_tool(cmake: &OsStr, tool: &str) -> PathBuf {
    let cmake_path = PathBuf::from(cmake);
    if let Some(parent) = cmake_path.parent().filter(|_| cmake_path.components().count() > 1) {
        let executable = if cfg!(windows) {
            format!("{tool}.exe")
        } else {
            tool.to_string()
        };
        parent.join(executable)
    } else {
        PathBuf::from(tool)
    }
}

fn require_windows_msvc_x64() {
    let target = env::var("TARGET").unwrap_or_default();
    if target != "x86_64-pc-windows-msvc" {
        panic!(
            "the linked WebRTC AEC3 backend is release-gated to x86_64-pc-windows-msvc; target={target}"
        );
    }
}

fn required_path(name: &str) -> PathBuf {
    env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("required environment variable {name} is missing"))
}

fn run(command: &mut Command, action: &str) {
    let status = command
        .status()
        .unwrap_or_else(|error| panic!("failed to {action}: {error}"));
    if !status.success() {
        panic!("failed to {action}: command exited with {status}");
    }
}

fn emit_vcpkg_static_libraries(directory: &Path) {
    let mut libraries = fs::read_dir(directory)
        .unwrap_or_else(|error| {
            panic!(
                "failed to enumerate vcpkg static libraries in {}: {error}",
                directory.display()
            )
        })
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension() == Some(OsStr::new("lib")))
        .collect::<Vec<_>>();
    libraries.sort();
    if libraries.is_empty() {
        panic!("vcpkg static library directory is empty: {}", directory.display());
    }
    println!("cargo:rustc-link-search=native={}", directory.display());
    for library in libraries {
        let name = library
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap_or_else(|| panic!("invalid vcpkg library name: {}", library.display()));
        println!("cargo:rustc-link-lib=static={name}");
    }
}

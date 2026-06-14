fn main() {
    println!("cargo:rerun-if-changed=migrations");
    #[cfg(target_os = "macos")]
    prepare_ios_plugin_api();
    #[cfg(target_os = "macos")]
    link_ios_plugin();
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "mobile-files",
            tauri_build::InlinedPlugin::new()
                .commands(&["persist_picked_file"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("tauri build");
}

#[cfg(target_os = "macos")]
fn link_ios_plugin() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        tauri_utils::build::link_apple_library("mobile-files", "ios");
    }
}

#[cfg(target_os = "macos")]
fn prepare_ios_plugin_api() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("ios") {
        return;
    }
    let Ok(source) = std::env::var("DEP_TAURI_IOS_LIBRARY_PATH") else {
        return;
    };
    let target = std::path::Path::new("ios").join(".tauri").join("tauri-api");
    let _ = std::fs::remove_dir_all(&target);
    copy_dir_filtered(
        std::path::Path::new(&source),
        &target,
        &[".build", "Package.resolved", "Tests"],
    )
    .expect("copy Tauri iOS API");
}

#[cfg(target_os = "macos")]
fn copy_dir_filtered(
    source: &std::path::Path,
    target: &std::path::Path,
    ignore: &[&str],
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let rel = path.strip_prefix(source).unwrap();
        let rel_str = rel.to_string_lossy();
        if ignore.iter().any(|item| rel_str.starts_with(item)) {
            continue;
        }
        let dest = target.join(rel);
        if path.is_dir() {
            std::fs::create_dir_all(&dest)?;
            copy_dir_filtered(&path, &dest, ignore)?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&path, &dest)?;
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
    Ok(())
}

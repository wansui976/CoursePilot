fn main() {
    println!("cargo:rerun-if-changed=migrations");
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

//! 钥匙串冒烟测试：对真实系统钥匙串做 写 → 读 → 删，验证 keyring 依赖在
//! 本机可用。单测走的 settings 回退路径不碰真钥匙串，发行前在真机跑这个：
//!   cargo run --example keyring_smoke
fn main() -> Result<(), keyring::Error> {
    let entry = keyring::Entry::new("dev.courseai.app", "smoke-test")?;
    entry.set_password("sk-smoke-1234")?;
    let got = entry.get_password()?;
    assert_eq!(got, "sk-smoke-1234");
    entry.delete_credential()?;
    match entry.get_password() {
        Err(keyring::Error::NoEntry) => println!("keyring smoke OK: set/get/delete all pass"),
        other => panic!("expected NoEntry after delete, got {other:?}"),
    }
    Ok(())
}

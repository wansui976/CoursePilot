"""按 release 里已经上传的更新包和签名，生成 / 覆盖 latest.json（应用内自动更新读它）。

macOS（两个架构）和 Windows 各自在不同的工作流里构建、上传，谁先跑完不一定。所以不在某一个
工作流里拼，而是每个工作流收尾时都跑一遍：从 release 现有的 *.sig 重新生成完整的 latest.json。
最后跑完的那一个看到的资产最全，覆盖之后就是全平台的清单。哪个平台还没传上来就先不写它，
客户端查不到自己平台的条目时不会更新，也不会出错。

用法：python3 updater-manifest.py <tag>（需要 gh 已登录或 GH_TOKEN，GITHUB_REPOSITORY 指仓库）
"""
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

tag = sys.argv[1]
repo = os.environ["GITHUB_REPOSITORY"]
version = tag.lstrip("vV")

# 平台键（Tauri updater 的写法）→ 更新包文件名的模式。签名文件是「更新包名 + .sig」。
PLATFORMS = {
    "darwin-aarch64": re.compile(r"_aarch64\.app\.tar\.gz$"),
    "darwin-x86_64": re.compile(r"_x64\.app\.tar\.gz$"),
    "windows-x86_64": re.compile(r"_windows_x64-setup\.exe$"),
}


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args, "--repo", repo], check=True, capture_output=True, text=True).stdout


assets = [a["name"] for a in json.loads(gh("release", "view", tag, "--json", "assets"))["assets"]]
platforms = {}
with tempfile.TemporaryDirectory() as tmp:
    for key, pattern in PLATFORMS.items():
        bundle = next((name for name in assets if pattern.search(name)), None)
        if not bundle or f"{bundle}.sig" not in assets:
            print(f"{key}: no signed update bundle in {tag} yet, skipped")
            continue
        gh("release", "download", tag, "--pattern", f"{bundle}.sig", "--dir", tmp, "--clobber")
        signature = pathlib.Path(tmp, f"{bundle}.sig").read_text(encoding="utf-8").strip()
        platforms[key] = {
            "signature": signature,
            "url": f"https://github.com/{repo}/releases/download/{tag}/{bundle}",
        }
        print(f"{key}: {bundle}")

    if not platforms:
        print("no signed update bundles at all; latest.json not written")
        sys.exit(0)
    manifest = {
        "version": version,
        "notes": f"https://github.com/{repo}/releases/tag/{tag}",
        "pub_date": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "platforms": platforms,
    }
    path = pathlib.Path(tmp, "latest.json")
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    gh("release", "upload", tag, str(path), "--clobber")
    print(f"latest.json uploaded with {sorted(platforms)}")

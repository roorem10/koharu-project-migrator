"""Package the prebuilt Windows launcher, browser edition, and their source."""

import hashlib
from pathlib import Path
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    tag = (ROOT / "release/VERSION").read_text(encoding="utf-8").strip()
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    output = dist / f"Koharu-Project-Migrator-{tag}-windows-x64.zip"
    launcher = ROOT / "release/Start Koharu Migrator.exe"
    page = ROOT / "release/Koharu-Project-Migrator.html"
    files = {
        launcher.name: launcher,
        "Read Me.txt": ROOT / "packaging/Read Me.txt",
        f"Extras/{page.name}": page,
        "Extras/Third-party notices.txt": ROOT / "THIRD-PARTY-NOTICES.txt",
    }
    # Include tracked build inputs only. The build generates a second HTML
    # file in desktop/ for Go to embed.
    sources = subprocess.check_output(
        ["git", "ls-files", "-z", "--", "Build.txt", "build.mjs", "src", "desktop", "vendor"],
        cwd=ROOT,
    )
    for name in sources.decode("utf-8").split("\0"):
        if name:
            files[f"Extras/Source/{name}"] = ROOT / name

    with ZipFile(output, "w") as package:
        for name, path in files.items():
            # Fix ZIP metadata so a rerun of this version produces the same archive.
            info = ZipInfo(name)
            info.create_system = 0
            info.external_attr = 0x20
            package.writestr(info, path.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)

    checksums = [
        (output.name, output),
        (launcher.name, launcher),
        (f"Extras/{page.name}", page),
    ]
    with (dist / "SHA256SUMS.txt").open("w", encoding="utf-8", newline="\n") as out:
        for name, path in checksums:
            out.write(f"{sha256(path)}  {name}\n")
    print(output.name)


if __name__ == "__main__":
    main()

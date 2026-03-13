#!/usr/bin/env python3
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def prompt(msg: str, default: str | None = None) -> str:
    if default is not None and default != "":
        full = f"{msg} [{default}]: "
    else:
        full = f"{msg}: "
    val = input(full).strip()
    return val or (default or "")


def run_cmd(cmd: list[str], cwd: Path) -> None:
    print(f"\n>> Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=str(cwd), shell=False)
    if result.returncode != 0:
        print(f"Command failed with exit code {result.returncode}")
        sys.exit(result.returncode)


def detect_arch() -> str:
    mach = platform.machine().lower()
    if mach in ("amd64", "x86_64", "x64"):
        return "x86_64"
    if mach in ("arm64", "aarch64"):
        return "aarch64"
    return mach


def main() -> None:
    project_root = Path(__file__).resolve().parent
    tauri_conf_path = project_root / "src-tauri" / "tauri.conf.json"
    if not tauri_conf_path.is_file():
        print(f"Could not find tauri.conf.json at {tauri_conf_path}")
        sys.exit(1)

    with tauri_conf_path.open("r", encoding="utf-8") as f:
        conf = json.load(f)

    current_version = str(conf.get("version", "1.0.0"))
    print(f"Current version in tauri.conf.json: {current_version}")

    new_version = prompt("New Echo version (semver)", current_version).strip()
    if not new_version:
        print("Version cannot be empty.")
        sys.exit(1)

    bundle = conf.setdefault("bundle", {})
    bundle["createUpdaterArtifacts"] = True

    plugins = conf.setdefault("plugins", {})
    updater = plugins.setdefault("updater", {})
    existing_pubkey = updater.get("pubkey", "")
    if not existing_pubkey or existing_pubkey == "REPLACE_WITH_PUBLIC_KEY":
        pubkey = prompt("Updater public key (from `tauri signer generate`)", "")
        if not pubkey:
            print("Public key is required for the updater.")
            sys.exit(1)
    else:
        pubkey = prompt("Updater public key", existing_pubkey) or existing_pubkey
    updater["pubkey"] = pubkey

    existing_endpoints = updater.get("endpoints") or []
    default_base_url = ""
    if existing_endpoints:
        first = existing_endpoints[0]
        marker = "/{{target}}/{{arch}}/{{current_version}}"
        if marker in first:
            default_base_url = first.split(marker)[0]

    base_url = prompt(
        "Base updates URL (without /{{target}}/{{arch}}/{{current_version}})",
        default_base_url or "https://updates.example.com/echo",
    ).rstrip("/")

    endpoint_template = base_url + "/{{target}}/{{arch}}/{{current_version}}"
    updater["endpoints"] = [endpoint_template]

    conf["version"] = new_version

    with tauri_conf_path.open("w", encoding="utf-8") as f:
        json.dump(conf, f, indent=2)
        f.write("\n")

    print(f"\nUpdated {tauri_conf_path} with version={new_version} and updater config.")

    default_pm = "bun"
    pkg_manager = prompt(
        "Package manager to use (bun/npm/pnpm/yarn)", default_pm
    ).lower() or "bun"

    if pkg_manager == "npm":
        run_cmd(["npm", "install"], cwd=project_root)
        run_cmd(["npm", "run", "build"], cwd=project_root)
        run_cmd(["npm", "run", "tauri", "build"], cwd=project_root)
    elif pkg_manager == "bun":
        run_cmd(["bun", "install"], cwd=project_root)
        run_cmd(["bun", "run", "build"], cwd=project_root)
        run_cmd(["bun", "run", "tauri", "build"], cwd=project_root)
    elif pkg_manager == "pnpm":
        run_cmd(["pnpm", "install"], cwd=project_root)
        run_cmd(["pnpm", "build"], cwd=project_root)
        run_cmd(["pnpm", "tauri", "build"], cwd=project_root)
    elif pkg_manager == "yarn":
        run_cmd(["yarn", "install"], cwd=project_root)
        run_cmd(["yarn", "build"], cwd=project_root)
        run_cmd(["yarn", "tauri", "build"], cwd=project_root)
    else:
        print(f"Unsupported package manager: {pkg_manager}")
        sys.exit(1)

    default_updates_root = str(Path.home() / "echo-updates")
    updates_root_input = prompt(
        "Local updates root folder (will contain <target>-<arch>/<version>/...)",
        default_updates_root,
    )
    updates_root = Path(updates_root_input).expanduser().resolve()
    updates_root.mkdir(parents=True, exist_ok=True)

    arch = detect_arch()
    copied_any = False

    # Windows artifacts (.msi)
    print("\nLooking for Windows MSI artifacts...")
    msi_dir = project_root / "src-tauri" / "target" / "release" / "bundle" / "msi"
    if msi_dir.is_dir():
        msi_files = sorted(msi_dir.glob("*.msi"))
        sig_files = sorted(msi_dir.glob("*.msi.sig"))

        if msi_files:
            msi_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            selected_msi = msi_files[0]
            print(f"Selected MSI: {selected_msi.name}")

            selected_sig = None
            expected_sig_name = selected_msi.name + ".sig"
            for s in sig_files:
                if s.name == expected_sig_name:
                    selected_sig = s
                    break

            if selected_sig is None and sig_files:
                sig_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                selected_sig = sig_files[0]

            target_dir = updates_root / f"windows-{arch}" / new_version
            target_dir.mkdir(parents=True, exist_ok=True)

            print(f"\nCopying Windows artifacts to {target_dir}")
            shutil.copy2(selected_msi, target_dir / selected_msi.name)
            if selected_sig is not None:
                shutil.copy2(selected_sig, target_dir / selected_sig.name)
                print(f"Copied {selected_msi.name} and {selected_sig.name}")
            else:
                print(f"Copied {selected_msi.name} (no .sig file found)")

            copied_any = True
        else:
            print(f"No .msi files found in {msi_dir}")
    else:
        print(f"MSI bundle directory not found at {msi_dir}")

    # macOS artifacts
    print("\nLooking for macOS artifacts...")
    macos_dir = project_root / "src-tauri" / "target" / "release" / "bundle" / "macos"
    if macos_dir.is_dir():
        # Prefer updater-friendly archives, then fall back to other common formats.
        artifacts = sorted(macos_dir.glob("*.app.tar.gz"))
        if not artifacts:
            artifacts = sorted(macos_dir.glob("*.dmg"))
        if not artifacts:
            artifacts = sorted(macos_dir.glob("*.app"))

        if artifacts:
            artifacts.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            selected_artifact = artifacts[0]
            print(f"Selected macOS artifact: {selected_artifact.name}")

            sig_files = sorted(macos_dir.glob(selected_artifact.name + ".sig"))
            if not sig_files:
                sig_files = sorted(macos_dir.glob("*.sig"))

            selected_sig = None
            if sig_files:
                sig_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                selected_sig = sig_files[0]

            target_dir = updates_root / f"darwin-{arch}" / new_version
            target_dir.mkdir(parents=True, exist_ok=True)

            print(f"\nCopying macOS artifacts to {target_dir}")
            shutil.copy2(selected_artifact, target_dir / selected_artifact.name)
            if selected_sig is not None:
                shutil.copy2(selected_sig, target_dir / selected_sig.name)
                print(f"Copied {selected_artifact.name} and {selected_sig.name}")
            else:
                print(f"Copied {selected_artifact.name} (no .sig file found)")

            copied_any = True
        else:
            print(f"No macOS artifacts found in {macos_dir}")
    else:
        print(f"macOS bundle directory not found at {macos_dir}")

    if not copied_any:
        print("No release artifacts found for any supported platform.")
        sys.exit(1)

    print("\nDone.")
    print(f"- Local updates root: {updates_root}")
    print(f"- Clients will check:   {endpoint_template}")
    print("Make sure this folder is served over HTTP at the base URL you provided.")


if __name__ == "__main__":
    main()


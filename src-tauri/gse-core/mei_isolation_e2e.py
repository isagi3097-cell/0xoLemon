"""End-to-end proof that a frozen parent's _MEI directory cannot reach the
official onedir generator (Cryptodome.Hash._MD5 native module load).

Simulates the real failure: the sidecar is a PyInstaller onefile build, so it
exports its own _MEI extraction dir on PATH. The child generator must still
resolve Cryptodome from its own _internal tree.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

VENDOR = Path(__file__).resolve().parents[2] / "src" / "vendor" / "gse-uc-setup"
sys.path.insert(0, str(VENDOR))

from gse_autosetup.core.official_generator import clean_subprocess_env  # noqa: E402

GEN_ROOT = Path(__file__).resolve().parents[1] / "resources" / "gse-uc" / "embedded" / "gse_tools" / "generate_emu_config"
EXE = GEN_ROOT / "generate_emu_config.exe"


def main() -> int:
    if not EXE.is_file():
        print(f"SKIP: generator not found at {EXE}")
        return 0

    # Simulate the frozen sidecar: its private extraction dir is on PATH and
    # _MEIPASS is set, exactly like a PyInstaller onefile parent.
    fake_mei = Path(tempfile.gettempdir()) / "_MEIfrozenparent"
    fake_mei.mkdir(exist_ok=True)

    internal = GEN_ROOT / "_internal"
    # run_official_generator builds extra_env['PATH'] from os.environ['PATH'].
    raw_parent_path = os.environ.get("PATH", "")
    poisoned_parent_path = os.pathsep.join([str(fake_mei), raw_parent_path])

    os.environ["PATH"] = poisoned_parent_path
    os.environ["_MEIPASS"] = str(fake_mei)

    extra = {"PATH": f"{internal}{os.pathsep}{GEN_ROOT}{os.pathsep}{poisoned_parent_path}"}
    env = clean_subprocess_env(extra)

    entries = env["PATH"].split(os.pathsep)
    assert str(fake_mei) not in entries, "poisoned _MEI dir leaked into child PATH"
    assert not any("_mei" in e.lower() for e in entries), "some _MEI entry survived"
    assert str(internal) in entries, "generator _internal missing from PATH"
    assert "_MEIPASS" not in env, "_MEIPASS leaked into child env"

    work = Path(tempfile.mkdtemp(prefix="gse-mei-e2e-"))
    # The generator writes to a fixed _OUTPUT/<appid> folder beside its own exe.
    # Snapshot and restore it so this check never leaves a dirty resource tree.
    output_dir = GEN_ROOT / "_OUTPUT" / "480"
    existed_before = output_dir.exists()
    try:
        proc = subprocess.run(
            [str(EXE), "-def1", "-anon", "-skip_ach", "480"],
            cwd=work, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace", timeout=180,
        )
        output = proc.stdout or ""
        fatal = "cannot load native module 'cryptodome.hash." in output.lower()
        if fatal:
            print("FAIL: generator reproduced the PyCryptodome loader error")
            print(output[-2000:])
            return 1
        print("PASS: generator ran without the PyCryptodome native module error")
        print(f"  exit={proc.returncode}")
        return 0
    finally:
        import shutil
        if not existed_before and output_dir.exists():
            shutil.rmtree(output_dir, ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

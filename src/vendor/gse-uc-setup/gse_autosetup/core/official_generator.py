from __future__ import annotations

import os
import shutil
import subprocess
import queue
import threading
import time
import sys
import tempfile
import hashlib
import json
from contextlib import contextmanager
from pathlib import Path

from .package import extract_archive

GSE_TOOLS_REPO = "alex47exe/gse_fork_tools"


def find_generator_executable(root: Path) -> Path:
    root = Path(root)
    preferred = [
        root / "generate_emu_config.exe",
        root / "generate_emu_config_old" / "generate_emu_config.exe",
    ]
    for path in preferred:
        if path.is_file():
            return path
    matches = sorted(root.rglob("generate_emu_config.exe"), key=lambda p: (len(p.parts), str(p).lower()))
    if not matches:
        raise RuntimeError("Official gse_fork_tools package does not contain generate_emu_config.exe.")
    return matches[0]


def find_generated_settings(generator_dir: Path, appid: int) -> Path:
    generator_dir = Path(generator_dir)
    direct = generator_dir / "_OUTPUT" / str(int(appid)) / "steam_settings"
    if direct.is_dir():
        return direct
    candidates = [p for p in generator_dir.rglob("steam_settings") if p.is_dir() and str(int(appid)) in p.parts]
    if not candidates:
        raise RuntimeError("Official generator completed but no steam_settings output was found.")
    candidates.sort(key=lambda p: (len(p.parts), str(p).lower()))
    return candidates[0]


def extract_tools_package(archive: Path, destination: Path) -> Path:
    destination = Path(destination)
    marker = destination / ".tools-complete"
    if marker.is_file():
        try:
            return find_generator_executable(destination).parent
        except Exception:
            shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True, exist_ok=True)
    extract_archive(archive, destination)
    exe = find_generator_executable(destination)
    marker.write_text("ok", encoding="ascii")
    return exe.parent


def build_generator_command(
    exe: Path,
    appid: int,
    *,
    skip_achievements: bool = False,
) -> list[str]:
    """Build the maintainer-compatible anonymous command.

    ``-def1`` keeps the official complete GSE preset.  The normal Setup path
    keeps ``skip_achievements=False`` because official generator output is the
    canonical source of achievement localization/artwork.  ``-skip_ach`` remains
    available only for explicit limited/fallback callers.
    """
    # Always target a fresh owned output. Do not ask the generator to delete a tree.
    cmd = [str(exe), "-def1", "-anon", "-rel_out"]
    if skip_achievements:
        cmd.append("-skip_ach")
    cmd.append(str(int(appid)))
    return cmd


def clean_subprocess_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Build an isolated environment for a nested PyInstaller generator."""
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("_PYI_") or key in {
            "_MEIPASS",
            "_MEIPASS2",
            "PYTHONPATH",
            "PYTHONHOME",
            "PYTHONEXECUTABLE",
            "PYINSTALLER_STRICT_UNPACK_MODE",
        }:
            env.pop(key, None)
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    # Package hooks can add the parent's private DLL directory to PATH too.
    # Drop every PyInstaller temp extraction dir, whether it belongs to this
    # process or to another frozen parent: those hold a foreign, incomplete
    # copy of the runtime and its native modules (e.g. Cryptodome.Hash._MD5),
    # and the standalone onedir generator must resolve them from its own
    # _internal folder instead.
    frozen_root = getattr(sys, "_MEIPASS", None)
    parent_root = Path(frozen_root).resolve() if frozen_root else None
    def _is_foreign_runtime_entry(entry: str) -> bool:
        if not entry:
            return True
        if "_mei" in entry.lower():
            return True
        if parent_root is not None:
            try:
                if Path(entry).resolve().is_relative_to(parent_root):
                    return True
            except OSError:
                pass
        return False
    kept: list[str] = []
    for entry in env.get("PATH", "").split(os.pathsep):
        if _is_foreign_runtime_entry(entry):
            continue
        kept.append(entry)
    env["PATH"] = os.pathsep.join(kept)
    if extra:
        # Callers build their PATH additions from the raw parent environment,
        # which still carries the frozen parent's _MEI directory. Sanitize the
        # override too, otherwise it would silently reinstate the very entry we
        # just removed and the onedir generator would resolve Cryptodome from
        # the wrong runtime tree again.
        sanitized_extra = dict(extra)
        if "PATH" in sanitized_extra:
            override = [
                entry
                for entry in str(sanitized_extra["PATH"]).split(os.pathsep)
                if not _is_foreign_runtime_entry(entry)
            ]
            sanitized_extra["PATH"] = os.pathsep.join(override)
        env.update(sanitized_extra)
    return env


@contextmanager
def external_dll_search():
    """Do not let a frozen parent's private DLL directory leak to the generator.

    Windows inherits SetDllDirectory state independently of environment variables.
    Restore the exact parent state even if CreateProcess fails. The headless core
    runs one setup command; the lock serializes generator launches in this module.
    """
    if sys.platform != "win32":
        yield
        return
    import ctypes
    from ctypes import wintypes
    with _SPAWN_LOCK:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        get_dir = kernel.GetDllDirectoryW
        get_dir.argtypes = [wintypes.DWORD, wintypes.LPWSTR]
        get_dir.restype = wintypes.DWORD
        set_dir = kernel.SetDllDirectoryW
        set_dir.argtypes = [wintypes.LPCWSTR]
        set_dir.restype = wintypes.BOOL
        length = get_dir(0, None)
        buffer = ctypes.create_unicode_buffer(length + 1)
        get_dir(len(buffer), buffer)
        previous = buffer.value or None
        if not set_dir(None):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            yield
        finally:
            if not set_dir(previous):
                raise ctypes.WinError(ctypes.get_last_error())


_SPAWN_LOCK = threading.Lock()


def validate_generator_runtime(exe: Path) -> None:
    """Fail before spawn for an incomplete onedir package, not 120 seconds later."""
    internal = exe.parent / "_internal"
    if not internal.is_dir():
        return  # A genuine onefile distribution resolves its own runtime.
    crypto = internal / "Cryptodome" / "Hash"
    if not any(crypto.glob("_MD5*.pyd")):
        raise RuntimeError(
            f"GSE_GENERATOR_RESOURCE_MISSING: {crypto / '_MD5.pyd'}. "
            "Install the complete generator package, including _internal; copying only the EXE is insufficient."
        )


def validate_generated_schema(settings: Path, schema: dict) -> None:
    """Full mode cannot quietly replace missing canonical data with Web API data."""
    available = schema.get('game', {}).get('availableGameStats', {}) or {}
    for kind in ('achievements', 'stats'):
        expected = {str(item['name']) for item in available.get(kind, []) if item.get('name')}
        if not expected:
            continue
        path = settings / f'{kind}.json'
        try:
            data = json.loads(path.read_text(encoding='utf-8-sig'))
            actual = {str(item['name']) for item in data if isinstance(item, dict) and item.get('name')}
        except (OSError, ValueError, TypeError) as exc:
            raise RuntimeError(f'GSE_GENERATOR_METADATA_INCOMPLETE: {kind}.json; full setup aborted.') from exc
        if not isinstance(data, list) or not expected.issubset(actual):
            raise RuntimeError(f'GSE_GENERATOR_METADATA_INCOMPLETE: missing {kind} IDs; full setup aborted.')


def _terminate_process(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            return
        except Exception:
            pass
    try:
        proc.kill()
    except Exception:
        pass


def run_official_generator(
    generator_root: Path,
    appid: int,
    log=None,
    progress=None,
    timeout: int = 600,
    idle_timeout: int = 120,
    *,
    skip_achievements: bool = False,
    output_root: Path | None = None,
) -> Path:
    """Run ``generate_emu_config`` without allowing the UI to hang forever.

    stdout is consumed by a reader thread so the main loop can emit heartbeats
    and enforce both an overall timeout and an output-idle timeout. Stdin is
    closed to prevent an unexpected prompt from blocking a windowed build.
    """
    log = log or (lambda _m: None)
    progress = progress or (lambda _pct, _msg: None)

    exe = find_generator_executable(generator_root)
    validate_generator_runtime(exe)
    # Separate output per invocation prevents stale/cross-AppID reuse. No folder
    # deletion is needed, including on failure; retained output is audit evidence.
    base = Path(output_root) if output_root is not None else Path(os.environ.get(
        "GSE_GENERATOR_WORK_ROOT", str(exe.parent / "downloading" / "gse-generator")
    ))
    base.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix=f"{int(appid)}-", dir=base))
    cmd = build_generator_command(exe, appid, skip_achievements=skip_achievements)
    mode = "fast complete config; achievements via Steam Web API" if skip_achievements else "full official schema"
    log(f"Running official GSE config generator ({mode})...")
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

    milestones: list[tuple[str, int]] = [
        ("connecting", 2), ("authenticating", 4), ("getting app info", 6),
        ("app info", 8), ("achievement", 20), ("stat", 35), ("dlc", 45),
        ("depot", 55), ("branch", 62), ("controller", 70), ("inventory", 76),
        ("language", 82), ("tag", 86), ("writing", 91), ("generating", 91),
        ("done", 97), ("finish", 97), ("complete", 97),
    ]

    extra_env: dict[str, str] = {}
    generator_internal = exe.parent / "_internal"
    if generator_internal.is_dir():
        # Prepend the generator's own native-module directories. Do NOT re-append
        # os.environ["PATH"] here: clean_subprocess_env already keeps the valid
        # inherited entries and strips any frozen parent's _MEI directory, so
        # appending the raw parent PATH would reinstate exactly the foreign
        # runtime tree that must not be visible to the child.
        extra_env["PATH"] = f"{generator_internal}{os.pathsep}{exe.parent}"

    with external_dll_search():
        proc = subprocess.Popen(
            cmd,
            cwd=work_dir,
            env=clean_subprocess_env(extra_env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            creationflags=creationflags,
            bufsize=1,
        )
    assert proc.stdout is not None

    lines: queue.Queue[str | None] = queue.Queue()

    def reader() -> None:
        try:
            for raw in proc.stdout:
                lines.put(raw)
        finally:
            lines.put(None)

    reader_thread = threading.Thread(target=reader, name="gse-generator-output", daemon=True)
    reader_thread.start()

    started = time.monotonic()
    last_output = started
    last_heartbeat = started
    current_pct = 0
    reader_done = False

    try:
        while True:
            now = time.monotonic()
            elapsed = int(now - started)
            if timeout and now - started > timeout:
                raise TimeoutError(f"Official generator exceeded {timeout}s total runtime.")
            if idle_timeout and now - last_output > idle_timeout:
                raise TimeoutError(f"Official generator produced no output for {idle_timeout}s.")

            try:
                raw = lines.get(timeout=0.5)
            except queue.Empty:
                raw = ""

            if raw is None:
                reader_done = True
            elif raw:
                line = raw.rstrip()
                if line:
                    last_output = time.monotonic()
                    log("generator: " + line)
                    low = line.lower()
                    # Some distributed PyInstaller builds of generate_emu_config
                    # are missing PyCryptodome native hash modules. Do not sit on
                    # the 120 s idle timeout after the child has already printed
                    # its fatal loader error; stop before any settings deployment.
                    if (
                        "cannot load native module 'cryptodome.hash." in low
                        or ("failed to execute script" in low and "generate_emu_config" in low)
                    ):
                        raise RuntimeError(
                            "Official generator runtime is missing a PyCryptodome native module: " + line
                        )
                    milestone = next((pct for kw, pct in milestones if kw in low), None)
                    if milestone is not None:
                        current_pct = max(current_pct, milestone)
                    progress(current_pct, f"Official generator… {elapsed}s — {line[:60]}")

            now = time.monotonic()
            if now - last_heartbeat >= 10 and proc.poll() is None:
                last_heartbeat = now
                time_pct = min(90, max(current_pct, int((now - started) / 6)))
                current_pct = time_pct
                progress(current_pct, f"Official generator still working… {int(now-started)}s")
                log(f"Official generator still working… {int(now-started)}s")

            if proc.poll() is not None and reader_done:
                break
    except Exception:
        _terminate_process(proc)
        proc.wait(timeout=10)
        raise
    finally:
        reader_thread.join(timeout=5)
        if not reader_thread.is_alive():
            proc.stdout.close()

    elapsed = int(time.monotonic() - started)
    if proc.returncode != 0:
        raise RuntimeError(f"Official config generator failed with exit code {proc.returncode}.")

    progress(99, f"Generator finished in {elapsed}s — locating output…")
    log(f"Official generator completed in {elapsed}s.")
    return find_generated_settings(work_dir, appid)


_DOC_NAMES = {"readme", "changelog", "credits", "license", "copying"}


def _is_deployable_settings_file(path: Path) -> bool:
    low = path.name.lower()
    stem = path.stem.lower()
    if path.suffix.lower() in {".md", ".markdown"}:
        return False
    if any(stem.startswith(prefix) for prefix in _DOC_NAMES) or "license" in stem:
        return False
    return True


def merge_settings_tree(source: Path, destination: Path) -> None:
    """Merge generated runtime settings while excluding documentation-only files."""
    source = Path(source)
    destination = Path(destination)
    if not source.is_dir():
        raise ValueError(f"Generated steam_settings folder does not exist: {source}")
    destination.mkdir(parents=True, exist_ok=True)
    for path in source.rglob("*"):
        if path.is_dir():
            continue
        rel = path.relative_to(source)
        if not _is_deployable_settings_file(path):
            continue
        target = destination / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def _deployable_relative_files(root: Path) -> set[Path]:
    root = Path(root)
    result: set[Path] = set()
    if not root.is_dir():
        return result
    for path in root.rglob("*"):
        if path.is_file() and _is_deployable_settings_file(path):
            result.add(path.relative_to(root))
    return result


def validate_settings_mirror(source: Path, destination: Path) -> None:
    """Ensure every runtime file produced by gse_fork_tools reached the game.

    Documentation files are intentionally excluded, but generated runtime data
    such as branches.json, depots.txt, controllers, images, inventory files and
    supported_languages.txt must never disappear during deployment.
    """
    source = Path(source)
    destination = Path(destination)
    expected = _deployable_relative_files(source)
    missing = sorted(rel for rel in expected if not (destination / rel).is_file())
    if missing:
        preview = ", ".join(str(p) for p in missing[:12])
        more = "" if len(missing) <= 12 else f" (+{len(missing) - 12} more)"
        raise RuntimeError(f"GSE generated settings mirror is incomplete: {preview}{more}")
    # Presence alone does not catch the English-only achievement overwrite.
    # User-facing INI preferences may change, canonical metadata/artwork may not.
    for rel in sorted(expected):
        if rel.suffix.lower() == '.json' or rel.parts[0] in {'img', 'controller'} or rel.name in {
            'depots.txt', 'supported_languages.txt'
        }:
            original_hash = hashlib.sha256((source / rel).read_bytes()).digest()
            deployed_hash = hashlib.sha256((destination / rel).read_bytes()).digest()
            if original_hash != deployed_hash:
                raise RuntimeError(f"GSE canonical metadata changed during deployment: {rel}")


def cleanup_official_generator_output(tools_root: Path, appid: int | None = None) -> None:
    """Clean up generated _OUTPUT directory or specific AppID output in generator tools folder."""
    try:
        tools_root = Path(tools_root)
        output_dirs: list[Path] = []
        direct = tools_root / "_OUTPUT"
        if direct.is_dir():
            output_dirs.append(direct)
        for cand in tools_root.rglob("_OUTPUT"):
            if cand.is_dir() and cand not in output_dirs:
                output_dirs.append(cand)

        for out_dir in output_dirs:
            if appid is not None:
                target = out_dir / str(int(appid))
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                # If _OUTPUT is now empty, remove _OUTPUT as well
                try:
                    if not any(out_dir.iterdir()):
                        shutil.rmtree(out_dir, ignore_errors=True)
                except Exception:
                    pass
            else:
                shutil.rmtree(out_dir, ignore_errors=True)
    except Exception:
        pass

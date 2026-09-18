"""Offline, non-executing audit of the three explicitly approved testne samples.

Only the caller-requested lab output is written. Sample files are never loaded as
modules, run, patched or recursively enumerated. Extracted content is untrusted.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import struct
import sys
import uuid
import zlib
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


SAMPLES = {
    "squeegee": ("SqueegeeManifestApp.exe", "e78e78452d70ab9fc98d51c5cb3f283fecd0174de2e51cec88dec191add51bb2"),
    "dwmapi": ("dwmapi.dll", "98e9620e9d6c317dd94e076e7c71c9d1189e0f87ccbf3304530dc54a1b5121a0"),
    "hubcap": ("HubcapTools_Setup_2026-08-28_cabd63b.exe", "94118388dd4a0b9c90c05640863b3092aa10b17c5b880675108a65798588cff5"),
}
LAB_ROOT = Path(r"C:\Users\conte\CodexLabs\testne-audit")
BUNDLE_MARKER = bytes.fromhex("8b1202b96a612038727b930214d7a03213f5b9e6efae3318ee3b2dce24b36aae")
MAX_INPUT = 128 * 1024 * 1024
MAX_ENTRY = 128 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024
MAX_ENTRIES = 4096
MAX_RESOURCES = 4096
LAB_BUDGET = 5 * 1024**3
FREE_FLOOR = 10 * 1024**3
DEFAULT_MEMBERS = (
    "SqueegeeManifestApp.dll", "SteamKit2.dll",
    "SqueegeeManifestApp.runtimeconfig.json", "SqueegeeManifestApp.deps.json",
)


class AuditError(ValueError):
    """Invalid input, unsupported format or breached audit safety boundary."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def bounded_slice(data: bytes, offset: int, size: int) -> bytes:
    if offset < 0 or size < 0 or offset > len(data) or size > len(data) - offset:
        raise AuditError("range outside input")
    return data[offset:offset + size]


def safe_relative(name: str) -> str:
    # Windows device names, alternate streams and normalized aliases are invalid
    # even when this parser is tested on another operating system.
    if not name or "\\" in name or "\x00" in name:
        raise AuditError("invalid archive path")
    parts = name.split("/")
    reserved = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(10)), *(f"lpt{i}" for i in range(10))}
    for part in parts:
        if (not part or part in (".", "..") or part[-1:] in (".", " ")
                or any(ord(c) < 32 or c in '<>:"|?*' for c in part)
                or part.split(".")[0].casefold() in reserved):
            raise AuditError("unsafe archive path")
    if PurePosixPath(name).is_absolute():
        raise AuditError("absolute archive path")
    return name


def check_no_reparse(path: Path) -> None:
    for current in (path, *path.parents):
        if current.exists() or current.is_symlink():
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise AuditError("reparse point or symlink rejected")


def read_sample(root: Path, key: str) -> bytes:
    name, expected = SAMPLES[key]
    path = root / name
    check_no_reparse(path)
    with path.open("rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_INPUT:
            raise AuditError("sample exceeds limit or is not a regular file")
        data = handle.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT or sha256(data) != expected:
        raise AuditError(f"hash mismatch for approved sample {key}; no extraction permitted")
    return data


class Reader:
    def __init__(self, data: bytes, offset: int = 0):
        self.data, self.offset = data, offset

    def read(self, size: int) -> bytes:
        result = bounded_slice(self.data, self.offset, size)
        self.offset += size
        return result

    def unpack(self, fmt: str) -> tuple:
        return struct.unpack(fmt, self.read(struct.calcsize(fmt)))

    def string(self) -> str:
        length = 0
        for index in range(5):
            byte = self.read(1)[0]
            if index == 4 and byte > 0x07:
                raise AuditError("invalid seven-bit length")
            length |= (byte & 0x7F) << (index * 7)
            if byte < 0x80:
                if length > 4096:
                    raise AuditError("bundle string exceeds limit")
                try:
                    return self.read(length).decode("utf-8", errors="strict")
                except UnicodeDecodeError as error:
                    raise AuditError("invalid UTF-8 name") from error
        raise AuditError("unterminated seven-bit length")


@dataclass(frozen=True)
class BundleEntry:
    path: str
    offset: int
    size: int
    compressed_size: int
    kind: int

    def decode(self, data: bytes) -> bytes:
        if not 0 <= self.size <= MAX_ENTRY or not 0 <= self.compressed_size <= MAX_INPUT:
            raise AuditError("bundle member exceeds decoding bounds")
        packed = bounded_slice(data, self.offset, self.compressed_size or self.size)
        if not self.compressed_size:
            return packed
        decoder = zlib.decompressobj(-15)
        try:
            # max_length is a hard expansion bound, not a post-allocation check.
            output = decoder.decompress(packed, self.size + 1)
        except zlib.error as error:
            raise AuditError("invalid bundle deflate stream") from error
        if (len(output) != self.size or not decoder.eof
                or decoder.unconsumed_tail or decoder.unused_data):
            raise AuditError("truncated, over-expanding or trailing bundle stream")
        return output


@dataclass(frozen=True)
class Bundle:
    version: str
    header_offset: int
    entries: tuple[BundleEntry, ...]


def parse_bundle(data: bytes) -> Bundle:
    positions = [m.start() for m in re.finditer(re.escape(BUNDLE_MARKER), data)]
    if len(positions) != 1 or positions[0] < 8:
        raise AuditError("missing or ambiguous .NET bundle marker")
    marker = positions[0]
    header = struct.unpack("<Q", bounded_slice(data, marker - 8, 8))[0]
    if header <= marker + len(BUNDLE_MARKER):
        raise AuditError("bundle header precedes host marker")
    reader = Reader(data, header)
    major, minor, count = reader.unpack("<III")
    if (major, minor) != (6, 0):
        raise AuditError(f"unsupported bundle version {major}.{minor}; only 6.0 is audited")
    if not 0 < count <= MAX_ENTRIES:
        raise AuditError("bundle entry count outside bounds")
    reader.string()  # Opaque bundle identifier; not used as a path or trust proof.
    deps_offset, deps_size, config_offset, config_size, _flags = reader.unpack("<QQQQQ")
    for offset, size in ((deps_offset, deps_size), (config_offset, config_size)):
        bounded_slice(data, offset, size)
    entries: list[BundleEntry] = []
    names: set[str] = set()
    total = 0
    intervals = []
    for _ in range(count):
        offset, size, compressed = reader.unpack("<QQQ")
        kind = reader.read(1)[0]
        name = safe_relative(reader.string())
        if kind > 5 or name.casefold() in names:
            raise AuditError("invalid entry kind or duplicate bundle path")
        names.add(name.casefold())
        total += size
        if size > MAX_ENTRY or total > MAX_TOTAL or compressed > MAX_INPUT:
            raise AuditError("bundle expansion budget exceeded")
        if compressed and (size == 0 or size > compressed * 1000):
            raise AuditError("suspicious compression ratio")
        stored_size = compressed or size
        bounded_slice(data, offset, stored_size)
        if offset + stored_size > header:
            raise AuditError("entry overlaps bundle metadata")
        if stored_size:
            intervals.append((offset, offset + stored_size))
        entries.append(BundleEntry(name, offset, size, compressed, kind))
    intervals.sort()
    if any(left[1] > right[0] for left, right in zip(intervals, intervals[1:])):
        raise AuditError("overlapping bundle entries")
    return Bundle("6.0", header, tuple(entries))


def pe_summary(data: bytes) -> dict[str, Any]:
    if bounded_slice(data, 0, 2) != b"MZ":
        raise AuditError("not a PE image")
    pe_offset = struct.unpack("<I", bounded_slice(data, 0x3C, 4))[0]
    if bounded_slice(data, pe_offset, 4) != b"PE\0\0":
        raise AuditError("invalid PE signature")
    machine, sections, _time, _symbols, _count, optional_size, flags = struct.unpack(
        "<HHIIIHH", bounded_slice(data, pe_offset + 4, 20))
    if not 0 < sections <= 96:
        raise AuditError("invalid PE section count")
    optional = bounded_slice(data, pe_offset + 24, optional_size)
    magic = struct.unpack("<H", bounded_slice(optional, 0, 2))[0]
    if magic not in (0x10B, 0x20B):
        raise AuditError("unsupported PE optional header")
    directory_offset = 112 if magic == 0x20B else 96
    directory_count = struct.unpack("<I", bounded_slice(optional, directory_offset - 4, 4))[0]
    clr = (0, 0)
    if directory_count > 14:
        clr = struct.unpack("<II", bounded_slice(optional, directory_offset + 14 * 8, 8))
    section_rows = []
    raw_end = 0
    for index in range(sections):
        row = bounded_slice(data, pe_offset + 24 + optional_size + index * 40, 40)
        virtual_size, rva, raw_size, raw_offset = struct.unpack_from("<IIII", row, 8)
        bounded_slice(data, raw_offset, raw_size)
        raw_end = max(raw_end, raw_offset + raw_size)
        section_rows.append({"name": row[:8].rstrip(b"\0").decode("ascii", errors="replace"),
                             "rva": rva, "virtualSize": virtual_size,
                             "rawOffset": raw_offset, "rawSize": raw_size})
    return {"machine": {0x14C: "x86", 0x8664: "x64", 0xAA64: "arm64"}.get(machine, hex(machine)),
            "isDll": bool(flags & 0x2000), "clrDirectory": {"rva": clr[0], "size": clr[1]},
            "hasClr": bool(clr[0] and clr[1]), "sections": section_rows,
            "overlayOffset": raw_end, "overlaySize": len(data) - raw_end}


def pe_details(data: bytes, depth: int = 0, budget: dict[str, int] | None = None) -> dict[str, Any]:
    """Resource payloads are hashed, never interpreted as executable modules."""
    if budget is None:
        budget = {"bytes": 0, "resources": 0}
    try:
        import pefile
    except ImportError as error:
        raise AuditError("--pe-details requires pefile; use the existing approved venv") from error
    try:
        pe = pefile.PE(data=data, fast_load=True)
        pe.parse_data_directories(directories=[0, 1, 2])
        imports = []
        for library in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []):
            imports.append({"library": library.dll.decode("ascii", errors="replace"), "symbols": [
                item.name.decode("ascii", errors="replace") if item.name else f"ordinal:{item.ordinal}"
                for item in library.imports[:8192]]})
        exports = [{"name": item.name.decode("ascii", errors="replace") if item.name else None,
                    "ordinal": item.ordinal, "rva": item.address}
                   for item in getattr(getattr(pe, "DIRECTORY_ENTRY_EXPORT", None), "symbols", [])[:8192]]
        resources = []
        root = getattr(pe, "DIRECTORY_ENTRY_RESOURCE", None)
        # The standard resource tree is exactly type/name/language; recursive
        # links or extra levels are rejected rather than traversed indefinitely.
        if root:
            for type_node in root.entries:
                for name_node in type_node.directory.entries:
                    for language in name_node.directory.entries:
                        budget["resources"] += 1
                        if budget["resources"] > MAX_RESOURCES or not hasattr(language, "data"):
                            raise AuditError("resource tree outside audited bounds")
                        record = language.data.struct
                        if record.Size > MAX_ENTRY:
                            raise AuditError("resource expansion budget exceeded")
                        budget["bytes"] += record.Size
                        if budget["bytes"] > MAX_TOTAL:
                            raise AuditError("aggregate resource budget exceeded")
                        offset = pe.get_offset_from_rva(record.OffsetToData)
                        payload = bounded_slice(data, offset, record.Size)
                        row = {"type": str(type_node.name or type_node.id),
                               "name": str(name_node.name or name_node.id),
                               "language": language.id, "offset": offset,
                               "size": len(payload), "sha256": sha256(payload)}
                        if payload.startswith(b"MZ"):
                            try:
                                row["nestedPe"] = pe_summary(payload)
                                if depth < 1:
                                    row["nestedDetails"] = pe_details(payload, depth + 1, budget)
                            except AuditError as error:
                                row["nestedPeError"] = str(error)
                        resources.append(row)
        return {"imports": imports, "exports": exports, "resources": resources,
                "nestedInspectionMaxDepth": 2}
    except AuditError:
        raise
    except (pefile.PEFormatError, AttributeError, IndexError, struct.error) as error:
        raise AuditError("invalid or unsupported PE directory structure") from error
    finally:
        if "pe" in locals():
            pe.close()


def sample_inventory(key: str, data: bytes, detailed: bool) -> dict[str, Any]:
    row: dict[str, Any] = {"sample": key, "file": SAMPLES[key][0], "bytes": len(data),
                           "sha256": sha256(data), "matchesPinnedHash": True,
                           "executionEvidence": "notExecuted", "signatureTrust": "notAssessed",
                           "provenanceVerified": False, "pe": pe_summary(data)}
    if detailed:
        row["peDetails"] = pe_details(data)
    if key == "squeegee":
        bundle = parse_bundle(data)
        row["bundle"] = {"version": bundle.version, "headerOffset": bundle.header_offset,
                         "entryCount": len(bundle.entries), "entries": []}
        for entry in bundle.entries:
            payload = entry.decode(data)
            detail = {**asdict(entry), "sha256": sha256(payload)}
            if payload.startswith(b"MZ"):
                detail["pe"] = pe_summary(payload)
            row["bundle"]["entries"].append(detail)
        main = next((item for item in row["bundle"]["entries"] if item["path"] == "SqueegeeManifestApp.dll"), None)
        row["mainAssemblyHasClr"] = bool(main and main.get("pe", {}).get("hasClr"))
    if key == "hubcap":
        row["innoMarkers"] = [{"offset": match.start(), "value": match.group().decode("ascii")}
                              for match in re.finditer(rb"Inno Setup (?:Setup Data|Messages) \([0-9.]+\)(?: \(u\))?", data)]
        row["installerPayload"] = "unassessed: installer script and inner payload are not decoded"
    return row


def compare_claims(inventory: dict[str, Any]) -> list[dict[str, Any]]:
    rows = {row["sample"]: row for row in inventory["samples"]}
    output = []
    if "squeegee" in rows:
        row = rows["squeegee"]
        output.append({"claim": "Squeegee main application is NativeAOT and cannot be IL-decompiled",
                       "status": "contradicted" if row.get("mainAssemblyHasClr") else "unassessed",
                       "evidence": "bundled SqueegeeManifestApp.dll CLR directory"})
        output.append({"claim": "A matching hash establishes runtime or redistribution trust",
                       "status": "notEstablished", "evidence": "hash binds bytes only; no source/license/signature approval"})
    if "hubcap" in rows:
        output.append({"claim": "Hubcap installer bootstrap proves the installed app capabilities",
                       "status": "unassessed", "evidence": rows["hubcap"]["installerPayload"]})
    if "dwmapi" in rows:
        output.append({"claim": "dwmapi import/export names prove safe runtime or ABI semantics",
                       "status": "notEstablished", "evidence": "static PE surfaces are not runtime/ABI acceptance"})
    return output


class LabWriter:
    """Exclusive files with a write-ahead ownership receipt; never cleans folders."""

    def __init__(self, root: Path):
        if os.name != "nt" or root.absolute() != LAB_ROOT:
            raise AuditError(f"output must be the explicitly approved Windows lab: {LAB_ROOT}")
        check_no_reparse(root)
        self.root = root
        self.existing_size = 0
        if root.exists():
            for directory, dirs, files in os.walk(root, followlinks=False):
                for name in [*dirs, *files]:
                    check_no_reparse(Path(directory) / name)
                for name in files:
                    self.existing_size += (Path(directory) / name).stat().st_size
        self.check_budget(0)
        self.run = root / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12])

    def check_budget(self, additional: int) -> None:
        if self.existing_size + additional > LAB_BUDGET:
            raise AuditError("lab exceeds 5 GiB budget")
        parent = self.root
        while not parent.exists():
            parent = parent.parent
        if shutil.disk_usage(parent).free - additional < FREE_FLOOR:
            raise AuditError("lab requires at least 10 GiB remaining free space")

    def write(self, files: dict[str, bytes], source_hashes: dict[str, str]) -> dict[str, Any]:
        if any(safe_relative(name) != name for name in files) or "receipt.json" in files:
            raise AuditError("invalid artifact path")
        if len({name.casefold() for name in files}) != len(files):
            raise AuditError("duplicate artifact path")
        receipt = {"schemaVersion": 1, "state": "plannedExactOwnedSet", "sourceHashes": source_hashes,
                   "executionEvidence": "notExecuted", "cleanupPolicy": "exactOwnedFilesOnly",
                   "files": [{"path": name, "bytes": len(payload), "sha256": sha256(payload)}
                             for name, payload in sorted(files.items())]}
        receipt_bytes = json_bytes(receipt)
        additional = len(receipt_bytes) + sum(map(len, files.values()))
        self.check_budget(additional)
        self.root.mkdir(parents=True, exist_ok=True)
        check_no_reparse(self.root)
        self.run.mkdir(exist_ok=False)
        # The receipt precedes payloads; a failed extraction still identifies all
        # exact planned files. Success is returned only after every file verifies.
        all_files = {"receipt.json": receipt_bytes, **files}
        for name, payload in all_files.items():
            path = self.run.joinpath(*PurePosixPath(name).parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            check_no_reparse(path)
            self.check_budget(additional)
            with path.open("xb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            if sha256(path.read_bytes()) != sha256(payload):
                raise AuditError("artifact verification failed; retain receipt for inspection")
        return {"runDirectory": str(self.run), "receipt": str(self.run / "receipt.json"),
                "verifiedArtifactCount": len(files), "receiptSha256": sha256(receipt_bytes)}


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=True) + "\n").encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inventory", "bundle", "compare-claims", "extract-static"))
    parser.add_argument("--input-root", type=Path, default=Path(r"E:\testne"))
    parser.add_argument("--sample", choices=tuple(SAMPLES), action="append")
    parser.add_argument("--pe-details", action="store_true", help="require existing pefile for resource/import/export inventory")
    parser.add_argument("--lab-dir", type=Path, help="explicitly enable output to the single approved lab root")
    parser.add_argument("--member", action="append", help="exact .NET bundle member to extract; may repeat")
    args = parser.parse_args(argv)
    try:
        keys = list(dict.fromkeys(args.sample or (["squeegee"] if args.command == "bundle" else list(SAMPLES))))
        if args.command == "extract-static" and args.lab_dir is None:
            raise AuditError("extract-static requires explicit --lab-dir")
        if args.member and args.command != "extract-static":
            raise AuditError("--member is only valid for extract-static")
        if args.command == "bundle" and keys != ["squeegee"]:
            raise AuditError("bundle command supports only the approved Squeegee sample")
        writer = LabWriter(args.lab_dir) if args.lab_dir else None
        data_by_key = {key: read_sample(args.input_root, key) for key in keys}
        inventory = {"schemaVersion": 1, "auditKind": "offlineStatic", "originalsExecuted": False,
                     "pefileAvailable": importlib.util.find_spec("pefile") is not None,
                     "samples": [sample_inventory(key, data, args.pe_details) for key, data in data_by_key.items()]}
        if args.command == "bundle":
            result: Any = inventory["samples"][0]["bundle"]
        elif args.command == "compare-claims":
            result = {"sourceHashes": {key: sha256(data) for key, data in data_by_key.items()},
                      "claimChecks": compare_claims(inventory)}
        else:
            result = inventory
        if writer:
            artifacts = {"inventory.json": json_bytes(inventory), "claims.json": json_bytes(compare_claims(inventory))}
            if args.command == "extract-static":
                if "squeegee" in data_by_key:
                    bundle = parse_bundle(data_by_key["squeegee"])
                    by_name = {entry.path: entry for entry in bundle.entries}
                    for name in args.member or DEFAULT_MEMBERS:
                        safe_relative(name)
                        if name not in by_name:
                            raise AuditError("requested member absent from approved bundle")
                        artifacts["raw/squeegee/" + name] = by_name[name].decode(data_by_key["squeegee"])
                elif args.member:
                    raise AuditError("--member requires selected Squeegee sample")
            result = {"output": writer.write(artifacts, {key: sha256(data) for key, data in data_by_key.items()}),
                      "summary": [{"sample": row["sample"], "sha256": row["sha256"]} for row in inventory["samples"]]}
        sys.stdout.write(json.dumps(result, indent=2, ensure_ascii=True) + "\n")
        return 0
    except (AuditError, OSError) as error:
        print(f"audit failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

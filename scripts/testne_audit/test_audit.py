"""Offline synthetic fixtures; never reads a user sample or executes PE content."""

import struct
import unittest
import zlib
import json
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import mock_open, patch

import audit


def string(value):
    raw = value.encode()
    length = len(raw)
    prefix = bytearray()
    while length >= 128:
        prefix.append((length & 127) | 128)
        length >>= 7
    return bytes(prefix) + bytes([length]) + raw


def fixture(name="app.dll", content=b"test assembly", compressed=True):
    encoder = zlib.compressobj(wbits=-15)
    packed = encoder.compress(content) + encoder.flush() if compressed else content
    payload_offset = 64
    header = payload_offset + len(packed)
    host = struct.pack("<Q", header) + audit.BUNDLE_MARKER
    host += bytes(payload_offset - len(host))
    metadata = struct.pack("<III", 6, 0, 1) + string("fixture") + bytes(40)
    metadata += struct.pack("<QQQB", payload_offset, len(content), len(packed) if compressed else 0, 1) + string(name)
    return host + packed + metadata


class BundleTests(unittest.TestCase):
    def test_raw_and_compressed(self):
        for compressed in (True, False):
            source = fixture(compressed=compressed)
            bundle = audit.parse_bundle(source)
            self.assertEqual(bundle.version, "6.0")
            self.assertEqual(bundle.entries[0].decode(source), b"test assembly")

    def test_unicode_name(self):
        data = fixture("fr/ressource-é.dll")
        self.assertEqual(audit.parse_bundle(data).entries[0].path, "fr/ressource-é.dll")

    def test_every_truncation_rejected(self):
        data = fixture()
        for length in range(len(data)):
            with self.subTest(length=length), self.assertRaises(audit.AuditError):
                audit.parse_bundle(data[:length])

    def test_out_of_range_header(self):
        data = bytearray(fixture())
        struct.pack_into("<Q", data, 0, len(data) + 1)
        with self.assertRaises(audit.AuditError):
            audit.parse_bundle(bytes(data))

    def test_ambiguous_marker(self):
        with self.assertRaises(audit.AuditError):
            audit.parse_bundle(fixture() + audit.BUNDLE_MARKER)

    def test_unsupported_version(self):
        data = bytearray(fixture())
        header = struct.unpack_from("<Q", data)[0]
        struct.pack_into("<I", data, header, 7)
        with self.assertRaisesRegex(audit.AuditError, "unsupported"):
            audit.parse_bundle(bytes(data))

    def test_count_bomb(self):
        data = bytearray(fixture())
        struct.pack_into("<I", data, struct.unpack_from("<Q", data)[0] + 8, 0xFFFFFFFF)
        with self.assertRaisesRegex(audit.AuditError, "count"):
            audit.parse_bundle(bytes(data))

    def test_declared_size_bomb(self):
        data = bytearray(fixture())
        entry = struct.unpack_from("<Q", data)[0] + 12 + len(string("fixture")) + 40
        struct.pack_into("<Q", data, entry + 8, audit.MAX_ENTRY + 1)
        with self.assertRaisesRegex(audit.AuditError, "budget"):
            audit.parse_bundle(bytes(data))

    def test_actual_expansion_exceeds_declared_size(self):
        data = fixture(content=b"a" * 5000)
        entry = audit.parse_bundle(data).entries[0]
        bad = audit.BundleEntry(entry.path, entry.offset, 1, entry.compressed_size, entry.kind)
        with self.assertRaisesRegex(audit.AuditError, "expanding"):
            bad.decode(data)

    def test_ratio_bomb(self):
        with self.assertRaisesRegex(audit.AuditError, "ratio"):
            audit.parse_bundle(fixture(content=b"a" * 2000000))

    def test_trailing_compressed_data(self):
        data = fixture()
        entry = audit.parse_bundle(data).entries[0]
        bad = audit.BundleEntry(entry.path, entry.offset, entry.size, entry.compressed_size + 1, entry.kind)
        with self.assertRaisesRegex(audit.AuditError, "trailing"):
            bad.decode(data)

    def test_entry_overlaps_metadata(self):
        data = bytearray(fixture())
        header = struct.unpack_from("<Q", data)[0]
        entry = header + 12 + len(string("fixture")) + 40
        struct.pack_into("<Q", data, entry, header)
        with self.assertRaisesRegex(audit.AuditError, "overlaps"):
            audit.parse_bundle(bytes(data))

    def test_duplicate_case_insensitive_member(self):
        data = bytearray(fixture("App.dll"))
        header = struct.unpack_from("<Q", data)[0]
        entry = header + 12 + len(string("fixture")) + 40
        struct.pack_into("<I", data, header + 8, 2)
        data.extend(data[entry:entry + 25] + string("app.dll"))
        with self.assertRaisesRegex(audit.AuditError, "duplicate"):
            audit.parse_bundle(bytes(data))

    def test_overlapping_member_ranges(self):
        data = bytearray(fixture("one.dll"))
        header = struct.unpack_from("<Q", data)[0]
        entry = header + 12 + len(string("fixture")) + 40
        struct.pack_into("<I", data, header + 8, 2)
        data.extend(data[entry:entry + 25] + string("two.dll"))
        with self.assertRaisesRegex(audit.AuditError, "overlapping"):
            audit.parse_bundle(bytes(data))

    def test_path_traversal(self):
        for name in ("../evil.dll", "/evil.dll", "C:/evil.dll", "a//b", "a/./b", "CON.dll", "AUX", "a\\b", "a:b", "a.", "a "):
            with self.subTest(name=name), self.assertRaises(audit.AuditError):
                audit.parse_bundle(fixture(name))

    def test_malformed_length(self):
        for data in (b"\x80" * 5, b"\xff" * 5, b"\x02x", b"\x01\xff"):
            with self.subTest(data=data), self.assertRaises(audit.AuditError):
                audit.Reader(data).string()


class SafetyTests(unittest.TestCase):
    def test_allowlist_exactly_three_samples(self):
        self.assertEqual(set(audit.SAMPLES), {"squeegee", "dwmapi", "hubcap"})

    def test_hash_mismatch(self):
        fake = mock_open(read_data=b"wrong binary")
        with patch("audit.check_no_reparse"), patch("pathlib.Path.open", fake), patch("audit.os.fstat") as fstat:
            fstat.return_value.st_mode = 0o100644
            fstat.return_value.st_size = 12
            with self.assertRaisesRegex(audit.AuditError, "hash mismatch"):
                audit.read_sample(Path("approved"), "squeegee")
        fake.assert_called_once_with("rb")

    def test_wrong_lab_rejected_before_io(self):
        with self.assertRaises(audit.AuditError):
            audit.LabWriter(Path("not-the-approved-lab"))

    def test_extract_requires_explicit_lab(self):
        with patch("audit.read_sample") as read:
            self.assertEqual(audit.main(["extract-static"]), 2)
            read.assert_not_called()

    def test_claim_does_not_infer_runtime(self):
        inventory = {"samples": [{"sample": "squeegee", "mainAssemblyHasClr": True}]}
        claims = audit.compare_claims(inventory)
        self.assertEqual(claims[0]["status"], "contradicted")
        self.assertEqual(claims[1]["status"], "notEstablished")

    def test_invalid_pe_is_bounded(self):
        for data in (b"", b"MZ", b"MZ" + bytes(128)):
            with self.subTest(length=len(data)), self.assertRaises(audit.AuditError):
                audit.pe_summary(data)

    def test_range_negative_and_overflow(self):
        for offset, size in ((-1, 1), (1, -1), (2**64, 1), (1, 2**64)):
            with self.subTest(offset=offset), self.assertRaises(audit.AuditError):
                audit.bounded_slice(b"test", offset, size)

    def test_budget_limit_before_output(self):
        writer = object.__new__(audit.LabWriter)
        writer.root = Path.cwd()
        writer.existing_size = audit.LAB_BUDGET - 1
        with self.assertRaisesRegex(audit.AuditError, "5 GiB"):
            writer.check_budget(2)

    def test_free_space_floor(self):
        writer = object.__new__(audit.LabWriter)
        writer.root = Path.cwd()
        writer.existing_size = 0
        with patch("audit.shutil.disk_usage", return_value=SimpleNamespace(free=audit.FREE_FLOOR)):
            with self.assertRaisesRegex(audit.AuditError, "10 GiB"):
                writer.check_budget(1)

    def test_output_alias_rejected(self):
        writer = object.__new__(audit.LabWriter)
        with self.assertRaisesRegex(audit.AuditError, "duplicate"):
            writer.write({"A.json": b"a", "a.json": b"b"}, {})

    def test_write_ahead_receipt_and_exclusive_output(self):
        writer = object.__new__(audit.LabWriter)
        writer.root, writer.run = Path("lab"), Path("lab/run")
        writer.check_budget = lambda additional: None
        fake_files = {}
        order = []

        class FakeFile:
            def __init__(self, path):
                self.path = path

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def write(self, payload):
                fake_files[self.path] = payload

            def flush(self):
                pass

            def fileno(self):
                return 123

        def opened(path, mode):
            self.assertEqual(mode, "xb")
            order.append(str(path))
            return FakeFile(path)

        with patch("pathlib.Path.mkdir"), patch("audit.check_no_reparse"), patch("audit.os.fsync"), \
                patch("pathlib.Path.open", autospec=True, side_effect=opened), \
                patch("pathlib.Path.read_bytes", autospec=True, side_effect=lambda path: fake_files[path]):
            result = writer.write({"raw/assembly.dll": b"fake, never executed"}, {"fixture": "hash"})
        self.assertEqual(order[0], str(Path("lab/run/receipt.json")))
        receipt = json.loads(fake_files[Path("lab/run/receipt.json")])
        self.assertEqual(receipt["state"], "plannedExactOwnedSet")
        self.assertEqual(receipt["files"][0]["path"], "raw/assembly.dll")
        self.assertEqual(result["verifiedArtifactCount"], 1)

    def test_oversized_input_not_read(self):
        fake = mock_open()
        with patch("audit.check_no_reparse"), patch("pathlib.Path.open", fake), patch("audit.os.fstat") as fstat:
            fstat.return_value.st_mode = 0o100644
            fstat.return_value.st_size = audit.MAX_INPUT + 1
            with self.assertRaisesRegex(audit.AuditError, "exceeds"):
                audit.read_sample(Path("approved"), "squeegee")
        fake.return_value.read.assert_not_called()

    def test_symlink_rejected(self):
        with patch("pathlib.Path.exists", return_value=True), \
                patch("pathlib.Path.lstat", return_value=SimpleNamespace(st_mode=0o120777, st_file_attributes=0)):
            with self.assertRaisesRegex(audit.AuditError, "symlink"):
                audit.check_no_reparse(Path("linked"))


if __name__ == "__main__":
    unittest.main()

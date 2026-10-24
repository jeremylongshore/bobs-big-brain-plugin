"""Private deterministic namespace barriers; no operator HOME or provisioning."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HELPER = Path(__file__).resolve().parents[1] / "bin" / "installer-cleanup.py"
spec = importlib.util.spec_from_file_location("installer_cleanup", HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def identity(path):
    st = path.stat()
    return {"path": str(path), "device": st.st_dev, "inode": st.st_ino}


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bbb-cleanup-fixture-")
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.input = self.home / "input"
        self.parent = self.home / "nested"
        self.base = self.parent / "brain"
        self.outside = self.root / "outside"
        for directory in [self.input, self.base, self.outside]:
            directory.mkdir(parents=True)
        (self.home / "keep.txt").write_text("HOME sentinel")
        (self.input / "source.md").write_text("input sentinel")
        (self.outside / "keep.txt").write_text("outside sentinel")
        (self.base / "old.txt").write_text("old brain")
        self.plan = {"request": {"home": str(self.home), "base": str(self.base),
                                 "inputFolder": str(self.input), "clean": True},
                     "basePath": str(self.base), "inputFolder": str(self.input),
                     "identities": [identity(self.home), identity(self.input), identity(self.base)],
                     "missing": []}

    def tearDown(self):
        # TemporaryDirectory owns this exact freshly created fixture only.
        self.temporary.cleanup()

    def sentinels(self):
        self.assertEqual((self.home / "keep.txt").read_text(), "HOME sentinel")
        self.assertEqual((self.input / "source.md").read_text(), "input sentinel")
        self.assertEqual((self.outside / "keep.txt").read_text(), "outside sentinel")
        self.assertFalse((self.outside / "brain").exists())

    def test_stable_target_retained_with_fresh_identity_and_durable_record(self):
        before = set(os.listdir("/proc/self/fd"))
        result = helper.cleanup(self.plan)
        self.assertEqual(result["status"], "retained", result)
        self.assertEqual(result["recovery"], "retained-backup")
        self.assertEqual(result["originalIdentity"], self.plan["identities"][2])
        self.assertEqual(result["freshIdentity"], identity(self.base))
        self.assertNotEqual(result["originalIdentity"]["inode"], result["freshIdentity"]["inode"])
        self.assertEqual(list(self.base.iterdir()), [])
        backup = Path(result["backupPath"])
        holder = Path(result["quarantinePath"])
        self.assertEqual(backup, holder / "original")
        self.assertEqual(holder.parent, self.parent)
        self.assertTrue(holder.name.startswith(".bbb-clean-"))
        self.assertEqual(stat.S_IMODE(holder.stat().st_mode), 0o700)
        self.assertEqual((backup / "old.txt").read_text(), "old brain")
        self.assertEqual(identity(backup)["inode"], self.plan["identities"][2]["inode"])
        record = holder / "recovery.json"
        self.assertEqual(stat.S_IMODE(record.stat().st_mode), 0o600)
        self.assertEqual(json.loads(record.read_text())["state"], "retained")
        self.sentinels()
        self.assertEqual(set(os.listdir("/proc/self/fd")), before)

    def test_missing_target_does_not_create_tail_or_quarantine(self):
        missing = self.parent / "new" / "brain"
        self.plan.update(basePath=str(missing), missing=["new", "brain"])
        self.plan["request"]["base"] = str(missing)
        self.plan["identities"][2] = identity(self.parent)
        result = helper.cleanup(self.plan)
        self.assertEqual(result["status"], "absent", result)
        self.assertIsNone(result["backupPath"])
        self.assertFalse((self.parent / "new").exists())
        self.assertEqual(list(self.parent.glob(".bbb-clean-*")), [])
        self.sentinels()

    def test_aliases_canonicalized_in_plan_remain_supported(self):
        alias = self.home / "home-alias"
        alias.symlink_to(self.home, target_is_directory=True)
        self.plan["request"]["home"] = str(alias)
        self.plan["request"]["base"] = str(alias / "nested" / "brain")
        result = helper.cleanup(self.plan)
        self.assertEqual(result["status"], "retained", result)
        self.sentinels()

    def test_capability_failure_precedes_any_creation(self):
        with mock.patch.object(helper, "_capability", side_effect=helper.Refusal("capability absent")):
            result = helper.cleanup(self.plan)
        self.assertEqual(result["status"], "refused")
        self.assertIn("capability absent", result["reason"])
        self.assertEqual(list(self.parent.glob(".bbb-clean-*")), [])
        self.assertEqual((self.base / "old.txt").read_text(), "old brain")
        self.sentinels()

    def test_changed_identity_or_nonclean_plan_refuses_before_effects(self):
        for mutation in ["identity", "clean", "missing"]:
            plan = json.loads(json.dumps(self.plan))
            if mutation == "identity":
                plan["identities"][2]["inode"] += 1
            elif mutation == "clean":
                plan["request"]["clean"] = False
            else:
                plan["missing"] = ["invented"]
            result = helper.cleanup(plan)
            self.assertEqual(result["status"], "refused", result)
        self.assertEqual(list(self.parent.glob(".bbb-clean-*")), [])
        self.sentinels()

    def test_input_overlap_refuses_and_preserves_source(self):
        self.plan["basePath"] = str(self.input)
        self.plan["request"]["base"] = str(self.input)
        self.plan["identities"][2] = identity(self.input)
        result = helper.cleanup(self.plan)
        self.assertEqual(result["status"], "refused", result)
        self.sentinels()

    def test_parent_symlink_swap_after_handle_check_restores_trusted_original(self):
        moved = self.home / "moved-parent"
        def barrier(phase, _context):
            if phase == "before_move":
                self.parent.rename(moved)
                self.parent.symlink_to(self.outside, target_is_directory=True)
        result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual(result["recovery"], "restored-without-overwrite", result)
        self.assertEqual((moved / "brain" / "old.txt").read_text(), "old brain")
        self.assertTrue(self.parent.is_symlink())
        self.sentinels()

    def test_parent_replacement_after_move_refuses_without_fresh_substituted_root(self):
        moved = self.home / "moved-parent"
        def barrier(phase, _context):
            if phase == "after_move":
                self.parent.rename(moved)
                self.parent.mkdir()
                (self.parent / "changed.txt").write_text("replacement parent")
        result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual(result["recovery"], "restored-without-overwrite", result)
        self.assertEqual((moved / "brain" / "old.txt").read_text(), "old brain")
        self.assertFalse((self.parent / "brain").exists())
        self.assertEqual((self.parent / "changed.txt").read_text(), "replacement parent")
        self.sentinels()

    def test_leaf_swap_before_rename_is_recoverable_and_never_deleted(self):
        original = self.parent / "original-brain"
        def barrier(phase, _context):
            if phase == "before_move":
                self.base.rename(original)
                self.base.mkdir()
                (self.base / "replacement.txt").write_text("changed leaf")
        result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual(result["recovery"], "restored-without-overwrite", result)
        self.assertEqual((self.base / "replacement.txt").read_text(), "changed leaf")
        self.assertEqual((original / "old.txt").read_text(), "old brain")
        self.sentinels()

    def test_symlink_or_file_leaf_swap_restores_entry_without_following_it(self):
        for kind in ["symlink", "file"]:
            with self.subTest(kind=kind):
                original = self.parent / ("original-" + kind)
                def barrier(phase, _context):
                    if phase == "before_move":
                        self.base.rename(original)
                        if kind == "symlink":
                            self.base.symlink_to(self.outside, target_is_directory=True)
                        else:
                            self.base.write_text("changed non-directory leaf")
                before = set(os.listdir("/proc/self/fd"))
                result = helper.cleanup(self.plan, _checkpoint=barrier)
                self.assertEqual(result["status"], "refused", result)
                self.assertEqual(result["recovery"], "restored-without-overwrite", result)
                self.assertIsNone(result["backupPath"])
                self.assertEqual(result["originalCurrentPath"], str(original))
                if kind == "symlink":
                    self.assertTrue(self.base.is_symlink())
                    self.assertEqual(os.readlink(self.base), str(self.outside))
                else:
                    self.assertEqual(self.base.read_text(), "changed non-directory leaf")
                self.assertEqual((original / "old.txt").read_text(), "old brain")
                self.assertEqual(set(os.listdir("/proc/self/fd")), before)
                self.sentinels()
                self.base.unlink()
                original.rename(self.base)

    def test_changed_symlink_leaf_with_occupied_rollback_is_retained_and_reported(self):
        original = self.parent / "original-brain"
        def barrier(phase, _context):
            if phase == "before_move":
                self.base.rename(original)
                self.base.symlink_to(self.outside, target_is_directory=True)
            if phase == "before_rollback":
                self.base.mkdir()
                (self.base / "keep.txt").write_text("concurrent occupant")
        result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual(result["recovery"], "original-occupied; quarantine-retained", result)
        backup = Path(result["backupPath"])
        self.assertTrue(backup.is_symlink())
        self.assertEqual(os.readlink(backup), str(self.outside))
        self.assertEqual((self.base / "keep.txt").read_text(), "concurrent occupant")
        self.assertEqual((original / "old.txt").read_text(), "old brain")
        record = json.loads((Path(result["quarantinePath"]) / "recovery.json").read_text())
        self.assertEqual(record["result"]["backupPath"], str(backup))
        self.assertEqual(record["result"]["originalCurrentPath"], str(original))
        self.sentinels()

    def test_changed_quarantine_leaf_is_retained_without_rollback_overwrite(self):
        def barrier(phase, context):
            if phase == "after_move":
                fd = context["quarantine_fd"]
                os.rename("original", "moved-original", src_dir_fd=fd, dst_dir_fd=fd)
                os.mkdir("original", dir_fd=fd)
                marker = os.open("original/replacement.txt", os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                                 0o600, dir_fd=fd)
                os.write(marker, b"changed quarantine leaf")
                os.close(marker)
        result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertIn("quarantine-entry-changed", result["recovery"])
        holder = Path(result["quarantinePath"])
        self.assertEqual((holder / "moved-original" / "old.txt").read_text(), "old brain")
        self.assertEqual((holder / "original" / "replacement.txt").read_text(), "changed quarantine leaf")
        self.assertFalse(self.base.exists())
        self.sentinels()

    def test_occupied_original_name_blocks_rollback_without_overwrite(self):
        original = self.parent / "original-brain"
        def barrier(phase, _context):
            if phase == "before_move":
                self.base.rename(original)
                self.base.mkdir()
                (self.base / "replacement.txt").write_text("changed leaf")
            if phase == "before_rollback":
                self.base.mkdir()
                (self.base / "occupant.txt").write_text("concurrent occupant")
        result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual(result["recovery"], "original-occupied; quarantine-retained", result)
        self.assertEqual((self.base / "occupant.txt").read_text(), "concurrent occupant")
        self.assertEqual((Path(result["backupPath"]) / "replacement.txt").read_text(), "changed leaf")
        self.assertEqual((original / "old.txt").read_text(), "old brain")
        self.sentinels()

    def test_destination_collision_never_overwrites_even_an_empty_directory(self):
        occupant = {}
        def barrier(phase, context):
            if phase == "before_move":
                os.mkdir("original", dir_fd=context["quarantine_fd"])
                path = Path(helper._entry_path(context["quarantine_fd"], "original"))
                occupant.update(identity(path))
        result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual((self.base / "old.txt").read_text(), "old brain")
        self.assertEqual(identity(Path(result["backupPath"])), occupant)
        self.assertEqual(list(Path(result["backupPath"]).iterdir()), [])
        self.sentinels()

    def test_empty_original_occupant_blocks_rollback_without_inode_replacement(self):
        original = self.parent / "original-brain"
        occupant = {}
        def barrier(phase, _context):
            if phase == "before_move":
                self.base.rename(original)
                self.base.mkdir()
                (self.base / "replacement.txt").write_text("changed leaf")
            if phase == "before_rollback":
                self.base.mkdir()
                occupant.update(identity(self.base))
        result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual(result["recovery"], "original-occupied; quarantine-retained", result)
        self.assertEqual(identity(self.base), occupant)
        self.assertEqual(list(self.base.iterdir()), [])
        self.assertEqual((Path(result["backupPath"]) / "replacement.txt").read_text(), "changed leaf")
        self.assertEqual((original / "old.txt").read_text(), "old brain")
        self.sentinels()

    def test_quarantine_holder_swap_refuses_and_restores_original(self):
        occupant = {}
        def barrier(phase, context):
            if phase == "after_move":
                holder = Path(helper._fd_path(context["quarantine_fd"]))
                holder.rename(self.outside / "moved-quarantine")
                holder.mkdir()
                occupant.update(identity(holder))
                (holder / "keep.txt").write_text("replacement quarantine")
        result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual(result["recovery"], "restored-without-overwrite", result)
        self.assertEqual((self.base / "old.txt").read_text(), "old brain")
        holder = next(self.parent.glob(".bbb-clean-*"))
        self.assertEqual(identity(holder), occupant)
        self.assertEqual((holder / "keep.txt").read_text(), "replacement quarantine")
        self.sentinels()

    def test_fresh_name_collision_preserves_old_backup_and_new_occupant(self):
        def barrier(phase, _context):
            if phase == "before_fresh":
                self.base.mkdir()
                (self.base / "occupant.txt").write_text("concurrent fresh occupant")
        result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual((self.base / "occupant.txt").read_text(), "concurrent fresh occupant")
        self.assertEqual((Path(result["backupPath"]) / "old.txt").read_text(), "old brain")
        self.sentinels()

    def test_recovery_record_exists_before_any_target_move(self):
        class SimulatedStop(BaseException):
            pass
        def barrier(phase, context):
            if phase == "after_recovery_written":
                path = Path(helper._entry_path(context["quarantine_fd"], "recovery.json"))
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                record = json.loads(path.read_text())
                self.assertEqual(record["expectedOriginalIdentity"], self.plan["identities"][2])
                raise SimulatedStop()
        with self.assertRaises(SimulatedStop):
            helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual((self.base / "old.txt").read_text(), "old brain")
        holder = next(self.parent.glob(".bbb-clean-*"))
        self.assertTrue((holder / "recovery.json").is_file())
        self.sentinels()

    def test_missing_fd_path_witness_refuses_before_target_move(self):
        before = identity(self.base)
        with mock.patch.object(helper, "_fd_path", return_value=None):
            result = helper.cleanup(self.plan)
        self.assertEqual(result["status"], "refused", result)
        self.assertIn("witness", result["reason"])
        self.assertEqual(identity(self.base), before)
        self.assertEqual((self.base / "old.txt").read_text(), "old brain")
        self.sentinels()

    def test_mismatched_fd_path_witness_refuses_before_target_move(self):
        before = identity(self.base)
        with mock.patch.object(helper, "_fd_path", return_value=str(self.outside)):
            result = helper.cleanup(self.plan)
        self.assertEqual(result["status"], "refused", result)
        self.assertIn("witness", result["reason"])
        self.assertEqual(identity(self.base), before)
        self.sentinels()

    def test_lost_postmove_witness_retains_last_verified_recovery_paths(self):
        original_lookup = helper._fd_path
        lost = False
        def lookup(fd):
            return None if lost else original_lookup(fd)
        def barrier(phase, _context):
            nonlocal lost
            if phase == "after_move":
                lost = True
        with mock.patch.object(helper, "_fd_path", side_effect=lookup):
            result = helper.cleanup(self.plan, _checkpoint=barrier)
        self.assertEqual(result["status"], "refused", result)
        self.assertIn("unavailable-or-stale", result["pathWitnessStatus"])
        self.assertEqual(result["backupPath"], str(Path(result["quarantinePath"]) / "original"))
        self.assertEqual((Path(result["backupPath"]) / "old.txt").read_text(), "old brain")
        self.assertEqual(list(self.base.iterdir()), [])
        self.assertEqual(result["recovery"], "fresh-base-and-backup-retained")
        self.sentinels()

    def assert_late_failure_preserves_backup(self, result):
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual(result["recovery"], "fresh-base-and-backup-retained", result)
        self.assertEqual((Path(result["backupPath"]) / "old.txt").read_text(), "old brain")
        self.assertEqual(list(self.base.iterdir()), [])
        self.sentinels()

    def test_before_move_fsync_failure_preserves_original_identity(self):
        before = identity(self.base)
        with mock.patch.object(helper.os, "fsync", side_effect=OSError("controlled pre-move fsync failure")):
            result = helper.cleanup(self.plan)
        self.assertEqual(result["status"], "refused", result)
        self.assertIn("controlled pre-move fsync", result["reason"])
        self.assertEqual(identity(self.base), before)
        self.assertEqual((self.base / "old.txt").read_text(), "old brain")
        self.assertIsNone(result["freshIdentity"])
        self.assertFalse(Path(result["backupPath"]).exists())
        self.sentinels()

    def test_final_recovery_write_failure_never_reports_retained(self):
        write = helper._recovery_write
        calls = 0
        def failing_write(fd, payload):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("controlled final recovery write failure")
            return write(fd, payload)
        with mock.patch.object(helper, "_recovery_write", side_effect=failing_write):
            result = helper.cleanup(self.plan)
        self.assert_late_failure_preserves_backup(result)
        self.assertIn("controlled final recovery write", result["reason"])
        record = json.loads((Path(result["quarantinePath"]) / "recovery.json").read_text())
        self.assertEqual(record["state"], "refused")
        self.assertEqual(record["result"]["status"], "refused")

    def test_final_parent_fsync_failure_never_reports_retained(self):
        fsync = helper.os.fsync
        calls = 0
        def failing_fsync(fd):
            nonlocal calls
            if helper._fd_path(fd) == str(self.parent):
                calls += 1
                if calls == 2:
                    raise OSError("controlled final parent fsync failure")
            return fsync(fd)
        with mock.patch.object(helper.os, "fsync", side_effect=failing_fsync):
            result = helper.cleanup(self.plan)
        self.assert_late_failure_preserves_backup(result)
        self.assertIn("controlled final parent fsync", result["reason"])

    def test_cli_uses_only_json_stdin_and_has_no_callback_switch(self):
        plan = {**self.plan, "_checkpoint": "not callable; ignored JSON data"}
        result = subprocess.run(["/usr/bin/python3", "-I", "-S", "-B", str(HELPER)],
                                input=json.dumps(plan), text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        self.assertEqual(observed["status"], "retained", observed)
        self.assertEqual((Path(observed["backupPath"]) / "old.txt").read_text(), "old brain")
        self.sentinels()


if __name__ == "__main__":
    unittest.main()

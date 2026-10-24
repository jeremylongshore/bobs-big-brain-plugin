#!/usr/bin/env python3
"""Linux retained-quarantine cleanup, never recursive deletion.

The helper binds operations to directory handles and uses no-replace renames.
A source-name swap can still cause a recoverable namespace move before identity
comparison. This is not an atomic tree snapshot, same-UID confinement, or a
safety guarantee for later installer operations. Importing performs no cleanup.
"""
import contextlib
import ctypes
import errno
import json
import os
import secrets
import stat
import sys


class Refusal(Exception):
    """Cleanup cannot proceed without preserving recoverable data."""


def _identity(st):
    return {"device": st.st_dev, "inode": st.st_ino}


def _same(left, right):
    return (left["device"], left["inode"]) == (right["device"], right["inode"])


def _canonical(path):
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path:
        raise Refusal("Plan paths must be normalized absolute paths")
    return path


def _within(parent, child):
    return child != parent and os.path.commonpath([parent, child]) == parent


def _overlap(left, right):
    return left == right or _within(left, right) or _within(right, left)


def _existing_or_missing(path):
    missing = []
    anchor = path
    while True:
        try:
            os.lstat(anchor)
            break
        except FileNotFoundError:
            parent, name = os.path.split(anchor)
            if parent == anchor:
                raise Refusal("No existing target ancestor")
            missing.insert(0, name)
            anchor = parent
    actual = os.path.realpath(anchor, strict=True)
    st = os.stat(actual)
    if not stat.S_ISDIR(st.st_mode):
        raise Refusal("Target anchor is not a directory")
    return os.path.join(actual, *missing), actual, missing


def _validated(plan):
    if not isinstance(plan, dict) or not isinstance(plan.get("request"), dict):
        raise Refusal("A validated installer plan is required")
    request = plan["request"]
    if request.get("clean") is not True:
        raise Refusal("Cleanup requires request.clean true")
    identities = plan.get("identities")
    if not isinstance(identities, list) or len(identities) != 3:
        raise Refusal("Plan requires home, input and anchor identities")
    for item in identities:
        if not isinstance(item, dict):
            raise Refusal("Invalid directory identity")
        _canonical(item.get("path"))
        if any(type(item.get(key)) is not int or item[key] < 0 for key in ["device", "inode"]):
            raise Refusal("Directory identities require integer device and inode")
    home, source, anchor = identities
    base = _canonical(plan.get("basePath"))
    input_path = _canonical(plan.get("inputFolder"))
    if os.path.realpath(_canonical(request.get("home")), strict=True) != home["path"]:
        raise Refusal("Requested HOME no longer matches the validated home")
    if os.path.realpath(_canonical(request.get("inputFolder")), strict=True) != input_path:
        raise Refusal("Requested input no longer matches the validated input")
    if input_path != source["path"]:
        raise Refusal("Input identity path differs from the validated input")
    actual, ancestor, missing = _existing_or_missing(_canonical(request.get("base")))
    if (actual, ancestor, missing) != (base, anchor["path"], plan.get("missing")):
        raise Refusal("Target or missing tail changed after validation")
    if not _within(home["path"], base) or _overlap(base, input_path):
        raise Refusal("Cleanup target must be below HOME and disjoint from input")
    return home, source, anchor, base, missing


def _capability():
    if sys.platform != "linux":
        raise Refusal("Retained cleanup requires Linux renameat2 support")
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        rename = libc.renameat2
    except AttributeError as error:
        raise Refusal("libc renameat2 is unavailable; no fallback is used") from error
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    return rename


def _rename(rename, source_fd, source, target_fd, target):
    # RENAME_NOREPLACE is the Linux ABI flag; never a guessed syscall number.
    if rename(source_fd, os.fsencode(source), target_fd, os.fsencode(target), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def _directory(path, *, dir_fd=None):
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)


def _keep(stack, fd):
    stack.callback(os.close, fd)
    return fd


def _walk(stack, root_fd, components):
    current = root_fd
    bindings = []
    for component in components:
        if not component or component in [".", ".."] or "/" in component:
            raise Refusal("Invalid directory component")
        current = _keep(stack, _directory(component, dir_fd=current))
        bindings.append(_identity(os.fstat(current)))
    return current, bindings


def _absolute(stack, path):
    root = _keep(stack, _directory("/"))
    return _walk(stack, root, path.split("/")[1:] if path != "/" else [])[0]


def _fd_path(fd):
    try:
        return os.readlink("/proc/self/fd/" + str(fd))
    except OSError:
        return None


def _verified_fd_path(fd, expected=None):
    path = _fd_path(fd)
    if path is None or not os.path.isabs(path) or os.path.normpath(path) != path:
        raise Refusal("Directory FD path witness is unavailable")
    if expected is not None and path != expected:
        raise Refusal("Directory FD path witness differs from the validated path")
    st = os.stat(path, follow_symlinks=False)
    if (not stat.S_ISDIR(st.st_mode) or os.path.realpath(path, strict=True) != path
        or not _same(_identity(st), _identity(os.fstat(fd)))):
        raise Refusal("Directory FD path witness identity differs")
    return path


def _entry_path(fd, name):
    parent = _fd_path(fd)
    return os.path.join(parent, name) if parent is not None else None


def _entry_identity(fd, name):
    # Recovery may need to restore a changed symlink or non-directory leaf.
    return _identity(os.stat(name, dir_fd=fd, follow_symlinks=False))


def _named_identity(fd, name):
    st = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISDIR(st.st_mode):
        raise Refusal("Named cleanup entry is not a no-follow directory")
    return _identity(st)


def _has_ancestor(fd, identity):
    # Directory handles remain anchored even when their pathname is renamed.
    current = os.dup(fd)
    try:
        for _ in range(512):
            here = _identity(os.fstat(current))
            if _same(here, identity):
                return True
            parent = _directory("..", dir_fd=current)
            if _same(here, _identity(os.fstat(parent))):
                os.close(parent)
                return False
            os.close(current)
            current = parent
        raise Refusal("Directory ancestry exceeds the bounded traversal")
    finally:
        os.close(current)


def _recovery_write(fd, payload):
    data = (json.dumps(payload, sort_keys=True) + "\n").encode()
    os.lseek(fd, 0, os.SEEK_SET)
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        if count <= 0:
            raise Refusal("Could not write recovery metadata")
        view = view[count:]
    os.ftruncate(fd, len(data))
    os.fsync(fd)


def cleanup(plan, *, _checkpoint=None):
    """Return retained/absent/refused; callbacks exist only for imported tests.

    No CLI/env field selects a callback. No old data is recursively deleted.
    Refusal may retain a recoverable namespace move, never overwrite recovery.
    """
    result = {"status": "refused", "basePath": None, "backupPath": None,
              "quarantinePath": None, "originalIdentity": None, "freshIdentity": None,
              "recovery": "not-needed"}
    moved = False
    moved_identity = None
    parent_fd = quarantine_fd = original_fd = recovery_fd = None
    base_name = holder = None
    record = None
    def checkpoint(phase, **context):
        if _checkpoint is not None:
            _checkpoint(phase, context)
    with contextlib.ExitStack() as stack:
        try:
            home, source, anchor, base, missing = _validated(plan)
            result["basePath"] = base
            rename = _capability()  # Before any directory creation or rename.
            home_fd = _absolute(stack, home["path"])
            input_fd = _absolute(stack, source["path"])
            if not _same(_identity(os.fstat(home_fd)), home) or not _same(_identity(os.fstat(input_fd)), source):
                raise Refusal("HOME or input identity changed")
            relative = os.path.relpath(base, home["path"]).split(os.sep)
            anchor_relative = os.path.relpath(anchor["path"], home["path"])
            anchor_parts = [] if anchor_relative == "." else anchor_relative.split(os.sep)
            anchor_fd, _ = _walk(stack, home_fd, anchor_parts)
            if not _same(_identity(os.fstat(anchor_fd)), anchor):
                raise Refusal("Validated target anchor identity changed")
            if missing:
                # Validate every known identity and the still-missing tail; create nothing.
                _validated(plan)
                result.update(status="absent", reason="Validated target remains absent")
                return result
            parent_parts = relative[:-1]
            base_name = relative[-1]
            parent_fd, parent_bindings = _walk(stack, home_fd, parent_parts)
            original_fd = anchor_fd
            result["originalIdentity"] = {"path": base, **_identity(os.fstat(original_fd))}
            if not _same(_named_identity(parent_fd, base_name), anchor):
                raise Refusal("Named target differs from the validated directory")

            def binding_check():
                with contextlib.ExitStack() as check:
                    named_home = _absolute(check, home["path"])
                    named_input = _absolute(check, source["path"])
                    named_parent, current = _walk(check, home_fd, parent_parts)
                    if (not _same(_identity(os.fstat(named_home)), home)
                        or not _same(_identity(os.fstat(named_input)), source)
                        or current != parent_bindings
                        or not _same(_identity(os.fstat(named_parent)), _identity(os.fstat(parent_fd)))):
                        raise Refusal("Named ancestry or input changed during cleanup")
                if quarantine_fd is not None:
                    if not _same(_named_identity(parent_fd, holder), _identity(os.fstat(quarantine_fd))):
                        raise Refusal("Named quarantine differs from its held directory")
                if (not _has_ancestor(parent_fd, home)
                    or _has_ancestor(input_fd, anchor)
                    or _has_ancestor(original_fd, source)):
                    raise Refusal("Cleanup ancestry or input overlap changed")

            checkpoint("after_handles", parent_fd=parent_fd, target_fd=original_fd)
            binding_check()
            for _ in range(8):
                holder = ".bbb-clean-" + secrets.token_hex(12)
                try:
                    os.mkdir(holder, 0o700, dir_fd=parent_fd)
                    break
                except FileExistsError:
                    continue
            else:
                raise Refusal("Could not reserve a fresh quarantine directory")
            quarantine_fd = _keep(stack, _directory(holder, dir_fd=parent_fd))
            holder_stat = os.fstat(quarantine_fd)
            if holder_stat.st_uid != os.geteuid() or stat.S_IMODE(holder_stat.st_mode) != 0o700:
                raise Refusal("Quarantine ownership or mode differs")
            binding_check()
            parent_path = _verified_fd_path(parent_fd, os.path.dirname(base))
            result["quarantinePath"] = _verified_fd_path(quarantine_fd, os.path.join(parent_path, holder))
            result["backupPath"] = os.path.join(result["quarantinePath"], "original")
            result["pathWitnessStatus"] = "verified"

            def refresh_recovery_paths():
                try:
                    current_path = _verified_fd_path(quarantine_fd)
                except (OSError, Refusal):
                    result["pathWitnessStatus"] = "unavailable-or-stale; last verified paths retained"
                    raise
                result["quarantinePath"] = current_path
                result["backupPath"] = os.path.join(current_path, "original")
                result["pathWitnessStatus"] = "verified"

            recovery_fd = _keep(stack, os.open("recovery.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                               0o600, dir_fd=quarantine_fd))
            record = {"state": "prepared; move may or may not have occurred", "basePath": base,
                      "backupPath": result["backupPath"], "expectedOriginalIdentity": result["originalIdentity"],
                      "meaning": "Retain data; never recursively purge or overwrite a conflicting original name"}
            _recovery_write(recovery_fd, record)
            os.fsync(quarantine_fd)
            os.fsync(parent_fd)
            checkpoint("after_recovery_written", quarantine_fd=quarantine_fd, parent_fd=parent_fd)
            binding_check()
            _verified_fd_path(parent_fd, os.path.dirname(base))
            refresh_recovery_paths()
            # A source entry can change in this last gap; post-move comparison detects it.
            checkpoint("before_move", quarantine_fd=quarantine_fd, parent_fd=parent_fd)
            _rename(rename, parent_fd, base_name, quarantine_fd, "original")
            moved = True
            moved_identity = _entry_identity(quarantine_fd, "original")
            checkpoint("after_move", quarantine_fd=quarantine_fd, parent_fd=parent_fd)
            if not _same(moved_identity, anchor) or not _same(_named_identity(quarantine_fd, "original"), anchor):
                raise Refusal("Quarantined entry differs from the validated target")
            binding_check()
            checkpoint("before_fresh", quarantine_fd=quarantine_fd, parent_fd=parent_fd)
            # mkdir is exclusive: a concurrent occupant is never replaced.
            os.mkdir(base_name, 0o700, dir_fd=parent_fd)
            fresh_fd = _keep(stack, _directory(base_name, dir_fd=parent_fd))
            fresh = _identity(os.fstat(fresh_fd))
            result["freshIdentity"] = {"path": base, **fresh}
            binding_check()
            if not _same(_named_identity(parent_fd, base_name), fresh):
                raise Refusal("Fresh directory changed before cleanup completed")
            if not _same(_named_identity(quarantine_fd, "original"), anchor):
                raise Refusal("Backup changed before cleanup completed")
            if os.listdir(fresh_fd):
                raise Refusal("Fresh directory is no longer empty")
            refresh_recovery_paths()
            result.update(status="retained", reason="Verified old tree retained; fresh empty base created",
                          recovery="retained-backup")
            record.update(state="retained", freshIdentity=result["freshIdentity"], backupPath=result["backupPath"])
            _recovery_write(recovery_fd, record)
            os.fsync(parent_fd)
            return result
        except Exception as error:
            result["status"] = "refused"
            result["reason"] = str(error)
            if moved and quarantine_fd is not None:
                try:
                    refresh_recovery_paths()
                except (OSError, Refusal) as path_error:
                    result["pathWitnessReason"] = str(path_error)
                try:
                    current = _entry_identity(quarantine_fd, "original")
                    if moved_identity is None or not _same(current, moved_identity):
                        result["recovery"] = "quarantine-entry-changed; retained for manual recovery"
                    elif result["freshIdentity"] is not None:
                        result["recovery"] = "fresh-base-and-backup-retained"
                    else:
                        checkpoint("before_rollback", quarantine_fd=quarantine_fd, parent_fd=parent_fd)
                        _rename(rename, quarantine_fd, "original", parent_fd, base_name)
                        result["recovery"] = "restored-without-overwrite"
                        result["backupPath"] = None
                except OSError as recovery_error:
                    result["recovery"] = ("original-occupied; quarantine-retained" if recovery_error.errno == errno.EEXIST
                                          else "rollback-refused; quarantine-retained")
                    result["recoveryReason"] = str(recovery_error)
                except Exception as recovery_error:
                    result["recovery"] = "rollback-refused; quarantine-retained"
                    result["recoveryReason"] = str(recovery_error)
            if original_fd is not None:
                result["originalCurrentPath"] = _fd_path(original_fd)
            if recovery_fd is not None and record is not None:
                try:
                    record.update(state="refused", result=result)
                    _recovery_write(recovery_fd, record)
                except OSError as recovery_error:
                    result["recoveryRecordError"] = str(recovery_error)
            return result


def main():
    try:
        raw = sys.stdin.buffer.read(65_537)
        if len(raw) > 65_536:
            raise Refusal("Cleanup plan exceeds the bounded input size")
        result = cleanup(json.loads(raw))
    except Exception as error:
        result = {"status": "refused", "reason": str(error), "recovery": "not-needed"}
    sys.stdout.write(json.dumps(result) + "\n")
    return 0 if result["status"] in ["retained", "absent"] else 1


if __name__ == "__main__":
    sys.exit(main())

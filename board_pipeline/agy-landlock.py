"""Launch Agy with an explicit filesystem and TCP boundary (Linux ABI 4+)."""
import ctypes as c
import json
import os
import platform
import stat
import sys

# Same syscall numbers on the supported Linux x86_64/aarch64 hosts.
CREATE, ADD, RESTRICT = 444, 445, 446
VERSION = 1
EXEC, READ_FILE, READ_DIR = 1, 4, 8
FS = (1 << 15) - 1  # Landlock ABI 3 includes REFER and TRUNCATE.
NET_BIND, NET_CONNECT = 1, 2


class Ruleset(c.Structure):
    _fields_ = [("fs", c.c_uint64), ("net", c.c_uint64)]


class PathRule(c.Structure):
    _pack_ = 1
    _fields_ = [("access", c.c_uint64), ("parent_fd", c.c_int32)]


class PortRule(c.Structure):
    _fields_ = [("access", c.c_uint64), ("port", c.c_uint64)]


def run(config, args):
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "aarch64"):
        raise RuntimeError("unsupported platform")
    libc = c.CDLL(None, use_errno=True)

    def syscall(number, *args):
        result = libc.syscall(number, *args)
        if result < 0:
            raise OSError(c.get_errno(), "landlock syscall failed")
        return result

    if syscall(CREATE, None, 0, VERSION) < 4:
        raise RuntimeError("Landlock ABI 4 is required")
    rule = Ruleset(FS, NET_BIND | NET_CONNECT)
    fd = syscall(CREATE, c.byref(rule), c.sizeof(rule), 0)

    def allow(path, bits):
        child = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            if not stat.S_ISDIR(os.fstat(child).st_mode):
                bits &= EXEC | READ_FILE | 2 | (1 << 14)
            rule = PathRule(bits, child)
            syscall(ADD, fd, 1, c.byref(rule), 0)
        finally:
            os.close(child)

    try:
        for path in ["/lib", "/lib64", "/usr/lib", "/usr/lib64", "/usr/share/zoneinfo", "/etc/ssl",
                     "/etc/ld.so.cache", "/etc/localtime", "/etc/passwd", "/etc/group", "/etc/hosts",
                     "/etc/nsswitch.conf", "/etc/resolv.conf", "/dev/urandom", "/dev/random"]:
            if os.path.exists(path):
                allow(path, READ_FILE | READ_DIR)
        allow("/dev/null", READ_FILE | 2)
        for path in ["/bin/sh", "/bin/bash", "/usr/bin/rg", "/usr/bin/grep", "/usr/bin/find",
                     "/lib64/ld-linux-x86-64.so.2", "/lib/ld-linux-aarch64.so.1"]:
            if os.path.exists(path):
                allow(path, EXEC | READ_FILE)
        for path in (config["binary"], config["node"]):
            allow(path, EXEC | READ_FILE)
        for path in (config["snapshot"], config["control"]):
            allow(path, READ_FILE | READ_DIR)
        for path in (config["home"], config["runtime"], config["tmp"], config["events"]):
            allow(path, FS & ~EXEC)
        port = config["proxyPort"]
        if not isinstance(port, int) or not 0 < port <= 65535 or port == 44100:
            raise RuntimeError("invalid proxy port")
        net_rule = PortRule(NET_CONNECT, port)
        syscall(ADD, fd, 2, c.byref(net_rule), 0)
        if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
            raise OSError(c.get_errno(), "no_new_privs failed")
        syscall(RESTRICT, fd, 0)
    finally:
        os.close(fd)
    os.execv(config["binary"], [config["binary"], *args])


if __name__ == "__main__":
    try:
        run(json.loads(sys.argv[1]), sys.argv[2:])
    except (OSError, ValueError, KeyError, RuntimeError):
        sys.stderr.write("agy_snapshot_sandbox_unavailable\n")
        sys.exit(126)

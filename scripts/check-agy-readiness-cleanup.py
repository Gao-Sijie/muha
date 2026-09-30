"""Exercise the native qualifier CLI against malformed output and a detached child."""

import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
    raise SystemExit("This check requires Python 3.9+ with Linux pidfd support")
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "test-only PR_SET_CHILD_SUBREAPER")
root = Path(tempfile.mkdtemp(prefix="muha-agy-probe-cleanup-test-"))
fake = root / "agy"
fake.write_text('''#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time
from pathlib import Path
if "--version" in sys.argv:
    print("fixture")
    raise SystemExit(0)
signal.signal(signal.SIGINT, signal.SIG_IGN)
worker = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
Path(os.environ["MUHA_PROBE_TEST_WORKER"]).write_text(str(worker.pid))
print(json.dumps({"event":"init", "conversation_id":"fixture", "init":{}}), flush=True)
sys.stdin.readline()
print("{malformed", flush=True)
time.sleep(0.3)
print("{malformed-again", flush=True)
time.sleep(10)
''')
fake.chmod(0o700)
worker_file = root / "worker"
env = {**os.environ, "PATH": os.pathsep.join([str(root), str(Path(sys.executable).parent), os.environ["PATH"]]),
       "MUHA_PROBE_TEST_WORKER": str(worker_file)}
try:
    result = subprocess.run([sys.executable, "scripts/qualify-agy-readiness.py", "--short-only"],
                            env=env, capture_output=True, text=True, timeout=25)
    probe_root = Path(json.loads(result.stdout.splitlines()[0])["root"])
    worker_alive = worker_file.exists() and Path("/proc/" + worker_file.read_text()).exists()
    summary_exists = (probe_root / "summary.json").exists()
    observation = {"exit_code": result.returncode, "summary_exists": summary_exists, "owned_worker_alive": worker_alive}
    print(json.dumps(observation))
    assert summary_exists and not worker_alive, observation
    summary = json.loads((probe_root / "summary.json").read_text())
    assert not summary["passed"] and summary["final_no_owned_children"]
    assert summary["failure_cleanup"]["cleanup_errors"]
finally:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            break
        for child in Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children").read_text().split():
            try:
                fd = os.pidfd_open(int(child))
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                os.close(fd)
            except ProcessLookupError:
                pass
        time.sleep(0.025)

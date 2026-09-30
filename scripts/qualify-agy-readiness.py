#!/usr/bin/env python3
"""Native D01 qualification, not an SDK adapter or production supervisor.

Uses the caller's PATH/login/config and an independent temporary workspace.
The standalone probe becomes a subreaper only to clean up its own experiments.
Its finite guards are test deadlines; the native timeout under test is separate.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import selectors
import shlex
import signal
import subprocess
import tempfile
import time
import uuid

cleanup_signals = []


def reap_owned():
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                return True
        children = Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children").read_text().split()
        for child in children:
            try:
                fd = os.pidfd_open(int(child))
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                    cleanup_signals.append(int(child))
                finally:
                    os.close(fd)
            except ProcessLookupError:
                pass
        time.sleep(0.025)
    return False


def configuration_fingerprints():
    native = Path.home() / ".gemini"
    paths = [native / "antigravity-cli/settings.json"]
    paths += list((native / "config/projects").glob("*.json"))
    return {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in paths if path.is_file()}


class NativeSession:
    def __init__(self, root, workspace, name, timeout, conversation=None, extra=()):
        self.name = name
        self.started = time.monotonic()
        self.events = []
        self.selector = selectors.DefaultSelector()
        self.buffers = {"stdout": b"", "stderr": b""}
        self.files = {channel: (root / f"{name}-{channel}.txt").open("wb")
                      for channel in self.buffers}
        self.timeline = (root / f"{name}-timeline.ndjson").open("w")
        args = ["agy", "--input-format", "stream-json", "--output-format", "stream-json",
                "--model", "claude-opus-4-6-thinking", "--print-timeout", timeout,
                "--dangerously-skip-permissions", "--log-file", str(root / f"{name}.log")]
        args += (["--conversation", conversation] if conversation else
                 ["--new-project", "--add-dir", str(workspace)])
        args += list(extra)
        self.child = subprocess.Popen(args, cwd=workspace, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      start_new_session=True)
        for channel in self.buffers:
            pipe = getattr(self.child, channel)
            os.set_blocking(pipe.fileno(), False)
            self.selector.register(pipe, selectors.EVENT_READ, channel)

    def record(self, event):
        item = {"elapsed_seconds": round(time.monotonic() - self.started, 3), **event}
        self.timeline.write(json.dumps(item) + "\n")
        self.timeline.flush()

    def pump(self, seconds=0.2):
        for key, _ in self.selector.select(seconds):
            data = os.read(key.fd, 65536)
            if not data:
                self.selector.unregister(key.fileobj)
                continue
            channel = key.data
            self.files[channel].write(data)
            self.files[channel].flush()
            self.buffers[channel] += data
            if channel == "stdout":
                while b"\n" in self.buffers[channel]:
                    line, self.buffers[channel] = self.buffers[channel].split(b"\n", 1)
                    event = json.loads(line)
                    self.events.append(event)
                    self.record({"received": event})

    def wait_for(self, predicate, seconds, description):
        deadline = time.monotonic() + seconds
        while not predicate():
            self.pump(min(0.2, max(0, deadline - time.monotonic())))
            if time.monotonic() >= deadline:
                raise TimeoutError(f"probe guard: {self.name}: {description}")
            if self.child.poll() is not None and not self.selector.get_map() and not predicate():
                raise RuntimeError(f"{self.name} exited {self.child.returncode} before {description}")

    def init(self):
        self.wait_for(lambda: any(e.get("event") == "init" for e in self.events), 60, "init before input")
        return next(e for e in self.events if e.get("event") == "init")

    def send_raw(self, line):
        self.record({"sent": line})
        self.child.stdin.write((line + "\n").encode())
        self.child.stdin.flush()

    def send(self, content):
        self.send_raw(json.dumps({"event": "user", "message": {"content": content}}))

    def results(self):
        return [e["result"] for e in self.events if e.get("event") == "result"]

    def ask(self, content, seconds):
        previous = len(self.results())
        started = time.monotonic()
        self.send(content)
        self.wait_for(lambda: len(self.results()) > previous, seconds, "terminal result")
        result = self.results()[-1]
        elapsed = time.monotonic() - started
        if result.get("status") != "SUCCESS":
            raise RuntimeError(f"native result {result}")
        return {"result": result, "elapsed_seconds": round(elapsed, 3)}

    def close(self):
        signals_before = len(cleanup_signals)
        cleanup_errors = []
        try:
            if self.child.poll() is None:
                self.child.send_signal(signal.SIGINT)
            deadline = time.monotonic() + 8
            while self.child.poll() is None and time.monotonic() < deadline:
                self.pump()
        except BaseException as error:
            cleanup_errors.append(repr(error))
        finally:
            try:
                if self.child.poll() is None:
                    self.child.kill()
                self.child.wait(timeout=5)
            finally:
                # Protocol or log failures must never bypass owned cleanup.
                cleanup = reap_owned()
        drain_deadline = time.monotonic() + 2
        try:
            while self.selector.get_map() and time.monotonic() < drain_deadline:
                self.pump()
        except BaseException as error:
            cleanup_errors.append(repr(error))
        pipes_closed = not self.selector.get_map()
        self.selector.close()
        self.child.stdin.close()
        for channel, file in self.files.items():
            file.close()
            getattr(self.child, channel).close()
        self.timeline.close()
        return {"exit_code": self.child.returncode, "no_owned_children": cleanup,
                "pipes_closed": pipes_closed, "probe_killed_pids": cleanup_signals[signals_before:],
                "cleanup_errors": cleanup_errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-timeout", default="0")
    parser.add_argument("--long-seconds", type=int, default=315)
    parser.add_argument("--short-only", action="store_true")
    options = parser.parse_args()
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        parser.error("this research supervisor requires Python 3.9+ with Linux pidfd support")
    if not options.short_only and options.long_seconds <= 300:
        parser.error("long qualification must exceed the native default of 300 seconds")
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "probe PR_SET_CHILD_SUBREAPER")
    root = Path(tempfile.mkdtemp(prefix="muha-agy-readiness-"))
    workspace = root / "workspace"
    workspace.mkdir()
    before = configuration_fingerprints()
    summary = {"root": str(root), "model": "claude-opus-4-6-thinking",
               "native_timeout": options.native_timeout, "short_only": options.short_only,
               "kernel_qualified": False, "scope": "native observations; no production admission",
               "phases": [], "passed": False}
    print(json.dumps({"root": str(root), "started": True}), flush=True)
    session = None
    try:
        version = subprocess.run(["agy", "--version"], capture_output=True, text=True, timeout=15, check=True)
        summary["version"] = version.stdout.strip()
        session = NativeSession(root, workspace, "continuous", options.native_timeout)
        init = session.init()
        summary["init"] = init
        summary["init_before_any_input"] = True
        print(json.dumps({"phase": "ready", "init": init}), flush=True)
        token = "MUHA_D01_" + uuid.uuid4().hex[:12]
        first = session.ask(f"Remember {token}. Reply with exactly that token. Use no tools.", 120)
        assert token in first["result"]["response"], first
        summary["phases"].append({"name": "first", **first})
        second = session.ask([{"type": "text", "text": "Recall the token from my first message."},
                              {"type": "text", "text": " Reply with exactly that token. Use no tools."}], 120)
        assert token in second["result"]["response"], second
        summary["phases"].append({"name": "continuous-history", **second})
        print(json.dumps({"phase": "short-turns-passed", "results": summary["phases"]}), flush=True)
        if not options.short_only:
            marker = workspace / "long-finished.txt"
            code = ("import time; from pathlib import Path; "
                    f"time.sleep({options.long_seconds}); Path({str(marker)!r}).write_text('MUHA_LONG_DONE')")
            command = "python3 -c " + shlex.quote(code)
            prompt = ("Perform this controlled long task in the temporary workspace. Use run_command to execute "
                      "exactly: " + command + ". Wait for the command to finish, using command_status if needed. "
                      "Do not interrupt, change it, run additional commands, or reply finally before it finishes. "
                      "When finished, reply MUHA_LONG_DONE. This intentionally takes more than five minutes.")
            print(json.dumps({"phase": "long-turn-started", "sleep_seconds": options.long_seconds}), flush=True)
            long_result = session.ask(prompt, options.long_seconds + 180)
            assert long_result["elapsed_seconds"] > 300, long_result
            assert marker.read_text() == "MUHA_LONG_DONE"
            assert "MUHA_LONG_DONE" in long_result["result"]["response"]
            summary["phases"].append({"name": "long-turn", **long_result})
            print(json.dumps({"phase": "long-turn-passed", **long_result}), flush=True)
        conversation = init["conversation_id"]
        assert all(r["conversation_id"] == conversation for r in session.results())
        assert len([e for e in session.events if e.get("event") == "init"]) == 1
        assert len(session.results()) == len(summary["phases"])
        session.child.stdin.close()
        session.wait_for(lambda: session.child.poll() is not None, 15, "idle EOF exit")
        summary["clean_eof"] = session.close()
        session = None
        session = NativeSession(root, workspace, "unknown-event", options.native_timeout, conversation)
        assert session.init()["conversation_id"] == conversation
        session.send_raw('{"event":"muha_unknown"}')
        ignored = session.ask(f"Reply with exactly {token}. Use no tools.", 120)
        assert token in ignored["result"]["response"]
        assert b"ignoring unsupported stream input" in session.buffers["stderr"]
        summary["phases"].append({"name": "unknown-event-skipped", **ignored, **session.close()})
        session = None
        for name, line in [("incomplete-json", '{"event":'),
                           ("malformed-json", '{"event":truX}'),
                           ("control-request", '{"event":"control_request"}'),
                           ("unsupported-block", '{"event":"user","message":{"content":[{"type":"image","url":"unused"}]}}')]:
            session = NativeSession(root, workspace, name, options.native_timeout, conversation)
            assert session.init()["conversation_id"] == conversation
            session.send_raw(line)
            guard_fired = False
            try:
                session.wait_for(lambda: session.child.poll() is not None, 15, "invalid input exit")
            except TimeoutError:
                guard_fired = True
            results_before_cleanup = session.results()
            result = {"name": name, "results_before_cleanup": results_before_cleanup,
                      "probe_guard_fired": guard_fired, **session.close()}
            session = None
            summary["phases"].append(result)
            assert result["no_owned_children"], result
            if not guard_fired:
                assert result["exit_code"] != 0, result
        session = NativeSession(root, workspace, "explicit-stop", options.native_timeout, conversation)
        assert session.init()["conversation_id"] == conversation
        started_marker = workspace / "stop-started.txt"
        finished_marker = workspace / "stop-finished.txt"
        code = ("import time; from pathlib import Path; "
                f"Path({str(started_marker)!r}).write_text('started'); time.sleep(60); "
                f"Path({str(finished_marker)!r}).write_text('should-not-finish')")
        session.send("Use run_command to execute exactly: python3 -c " + shlex.quote(code) +
                     ". Wait for it to finish. Do not change the command or use other tools except command_status.")
        session.wait_for(started_marker.exists, 120, "actual tool start before interrupt")
        stopped_at = time.monotonic()
        stopped = session.close()
        summary["phases"].append({"name": "explicit-stop", **stopped,
                                  "elapsed_seconds": round(time.monotonic() - stopped_at, 3),
                                  "results": session.results(),
                                  "finished_marker_exists": finished_marker.exists()})
        session = None
        assert stopped["no_owned_children"] and not finished_marker.exists()
        summary["passed"] = not any(p.get("probe_guard_fired") for p in summary["phases"])
    except BaseException as error:
        summary["failure"] = repr(error)
    finally:
        try:
            if session:
                summary["last_events"] = session.events[-5:]
                summary["failure_cleanup"] = session.close()
        except BaseException as error:
            summary["cleanup_failure"] = repr(error)
            summary["passed"] = False
        finally:
            summary["final_no_owned_children"] = reap_owned()
        after = configuration_fingerprints()
        summary["changed_preexisting_config"] = [path for path, digest in before.items() if after.get(path) != digest]
        summary["new_projects"] = [path for path in after if path not in before]
        if summary["changed_preexisting_config"] or not summary["final_no_owned_children"]:
            summary["passed"] = False
        cleanup_results = summary["phases"] + [summary.get("clean_eof", {}), summary.get("failure_cleanup", {})]
        if any(item.get("cleanup_errors") or item.get("pipes_closed") is False or
               item.get("no_owned_children") is False for item in cleanup_results):
            summary["passed"] = False
        (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary), flush=True)
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt("probe termination requested")

    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())

#!/usr/bin/env python3
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time


PHASES = (
    "prepare-candidate", "smoke-candidate", "stop-live", "update-live",
    "prepare-live", "start-live", "smoke-live",
)
CANDIDATE_ENV_KEYS = {
    "BB_SERVER_PORT", "BB_HOST_DAEMON_PORT", "BB_DEV_APP_PORT",
    "BB_DEV_APP_HOST", "BB_SERVER_BIND_HOST", "BB_SERVER_URL", "BB_APP_URL",
    "BB_HOST_DAEMON_URL", "BB_DESKTOP_APP_URL", "BB_DESKTOP_AUTO_UPDATE",
    "BB_DESKTOP_VERSION_CHECK", "NODE_ENV",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], stderr=subprocess.PIPE,
    )


def root(path):
    path = Path(path).resolve(strict=True)
    actual = Path(os.fsdecode(git(path, "rev-parse", "--show-toplevel")).strip()).resolve()
    require(actual == path, "Use the exact Git checkout root")
    return path


def changed_paths(repo):
    paths = git(repo, "diff", "--name-only", "-z", "HEAD").split(b"\0")
    paths += git(repo, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
    return sorted({os.fsdecode(path) for path in paths if path})


def identity(repo):
    commit = git(repo, "rev-parse", "HEAD").decode().strip()
    status = git(repo, "status", "--porcelain=v1", "-z")
    hasher = hashlib.sha256(commit.encode() + b"\0" + status)
    hasher.update(git(repo, "diff", "--no-ext-diff", "--binary", "HEAD"))
    for relative in changed_paths(repo):
        path = Path(repo) / relative
        hasher.update(os.fsencode(relative) + b"\0")
        if path.is_symlink():
            hasher.update(b"link\0" + os.fsencode(os.readlink(path)))
        elif path.is_file():
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    hasher.update(block)
    return {"commit": commit, "fingerprint": hasher.hexdigest(), "clean": not status}


def save(path, value):
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".state-")
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def backup_databases(state, phase):
    directory = Path(state["run"]) / (phase + "-databases")
    directory.mkdir(mode=0o700)
    for index, name in enumerate(state["databases"]):
        path = Path(name)
        require(path.is_file(), "A recorded database is missing")
        destination = directory / (str(index) + "-" + path.name)
        deadline = time.monotonic() + 60

        def progress(_status, _remaining, _total):
            require(time.monotonic() < deadline, "SQLite backup timed out")

        with contextlib.closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as source:
            with contextlib.closing(sqlite3.connect(destination)) as target:
                source.backup(target, pages=256, progress=progress, sleep=0.1)
                require(target.execute("PRAGMA quick_check").fetchall() == [("ok",)],
                        "SQLite backup failed integrity validation")
        destination.chmod(0o600)


def checklist(path):
    entries = json.loads(Path(path).read_text())
    require(isinstance(entries, list), "Customization checklist must be an array")
    for entry in entries:
        require(isinstance(entry, dict) and entry.get("status") == "verified"
                and isinstance(entry.get("behavior"), str) and entry["behavior"].strip()
                and isinstance(entry.get("evidence"), str) and entry["evidence"].strip(),
                "Every customization needs verified behavior and evidence")
    return digest(path)


def command_receipt(command, cwd, run, label):
    require("/" not in command[0] or Path(command[0]).is_absolute(),
            "Use an absolute path for an operator executable outside PATH")
    executable = shutil.which(command[0])
    require(executable is not None, "Operator executable was not found")
    paths = {Path(executable).resolve()}
    for argument in command[1:]:
        path = Path(argument)
        if path.suffix in {".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts"}:
            path = path if path.is_absolute() else Path(cwd) / path
            if path.is_file():
                paths.add(path.resolve())
    artifacts = run / (label + "-operator-files")
    artifacts.mkdir(mode=0o700)
    files = []
    for index, path in enumerate(sorted(paths)):
        entry = {"path": str(path), "sha256": digest(path)}
        if path != Path(executable).resolve() or path.suffix in {".sh", ".py", ".js", ".mjs", ".cjs", ".ts", ".bash", ".zsh"}:
            copy = artifacts / (str(index) + "-" + path.name)
            shutil.copyfile(path, copy)
            copy.chmod(0o600)
            entry["copy"] = str(copy)
        files.append(entry)
    return {"argv": command, "cwd": cwd, "files": files}


def initialize(args):
    live, candidate = root(args.live_repo), root(args.candidate)
    data = Path(args.live_data).resolve(strict=True)
    run = Path(args.run).resolve()
    require(data.is_dir(), "Live data must be a directory")
    require(not live.is_relative_to(candidate) and not candidate.is_relative_to(live),
            "Candidate and live checkout must be separate")
    require(not candidate.is_relative_to(data) and not data.is_relative_to(candidate),
            "Candidate checkout must be separate from live data")
    for location in (live, candidate, data):
        require(not run.is_relative_to(location) and not location.is_relative_to(run),
                "Run artifacts must be separate from checkouts and live data")
    candidate_identity = identity(candidate)
    require(candidate_identity["clean"], "Commit the integrated candidate before initializing")
    recovery = Path(args.recovery_file).resolve(strict=True)
    checks = Path(args.checklist).resolve(strict=True)
    env_file = Path(args.candidate_env).resolve(strict=True)
    env = json.loads(env_file.read_text())
    require(isinstance(env, dict) and all(
        key in CANDIDATE_ENV_KEYS and isinstance(value, str) for key, value in env.items()
    ), "Candidate environment allows only documented non-secret runtime keys")
    for artifact in (recovery, checks, env_file):
        require(not artifact.is_relative_to(live) and not artifact.is_relative_to(candidate)
                and not artifact.is_relative_to(data),
                "Operator files must live outside checkouts and live data")
    require(recovery.stat().st_size > 0, "Recovery runbook must not be empty")
    databases = {Path(name).resolve(strict=True) for name in args.database}
    if (data / "bb.db").is_file():
        databases.add((data / "bb.db").resolve())
    for database in databases:
        require(database.is_relative_to(data), "Database must belong to the live data directory")
    live_identity = identity(live)
    state = {
        "schema": 1, "run": str(run), "live_repo": str(live),
        "candidate": str(candidate), "live_data": str(data),
        "live_identity": live_identity, "candidate_identity": candidate_identity,
        "recovery": str(recovery), "recovery_hash": digest(recovery),
        "checklist": str(checks), "candidate_env": env,
        "databases": [str(path) for path in sorted(databases)],
        "completed": [], "attempts": [],
    }
    run.mkdir(mode=0o700, parents=True, exist_ok=False)
    (run / "staging-data").mkdir(mode=0o700)
    shutil.copyfile(recovery, run / "RECOVERY.md")
    state["recovery"] = str(run / "RECOVERY.md")
    (run / "tracked.patch").write_bytes(git(live, "diff", "--no-ext-diff", "--binary", "HEAD"))
    (run / "index.patch").write_bytes(git(live, "diff", "--no-ext-diff", "--binary", "--cached"))
    with tarfile.open(run / "local-files.tar.gz", "w:gz", dereference=False) as archive:
        for relative in changed_paths(live):
            path = live / relative
            if path.exists() or path.is_symlink():
                archive.add(path, arcname=relative, recursive=False)
    backup_databases(state, "preflight")
    require(identity(live) == live_identity, "Live source changed during snapshot; start a new run")
    save(run / "state.json", state)
    print("Initialized private upgrade journal: " + str(run))


def verify_sources(state, phase, after=False):
    require(identity(state["candidate"]) == state["candidate_identity"],
            "Candidate changed or became dirty; validate a new run")
    live = identity(state["live_repo"])
    target_live = PHASES.index(phase) > PHASES.index("update-live") or (
        phase == "update-live" and after
    )
    require(live == (state["candidate_identity"] if target_live else state["live_identity"]),
            "Live source differs from the recorded baseline or validated candidate")


def step(args):
    run = Path(args.run).resolve(strict=True)
    with (run / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads((run / "state.json").read_text())
        require(state["schema"] == 1 and state["run"] == str(run), "Invalid journal location/schema")
        completed = state["completed"]
        require(not state["attempts"] or state["attempts"][-1]["result"] == "passed",
                "Previous phase failed or was interrupted; recover before initializing a new run")
        require(len(completed) < len(PHASES) and args.phase == PHASES[len(completed)],
                "Phase out of order; inspect status and recovery runbook")
        require(completed == list(PHASES[:len(completed)]), "Invalid phase history")
        require(digest(state["recovery"]) == state["recovery_hash"],
                "Recovery procedure changed; initialize a new run")
        is_live = PHASES.index(args.phase) >= PHASES.index("stop-live")
        require(not (is_live and os.environ.get("BB_THREAD_ID")),
                "Live phases require an independent terminal/harness outside BB; do not unset BB_THREAD_ID")
        verify_sources(state, args.phase)
        if is_live:
            require(checklist(state["checklist"]) == state["checklist_hash"],
                    "Customization evidence changed after candidate validation")
        command = args.command
        if command and command[0] == "--":
            command = command[1:]
        require(command, "Supply the reviewed operator command after --")
        label = str(len(state["attempts"]) + 1).zfill(2) + "-" + args.phase
        log = run / (label + ".log")
        cwd = state["live_repo"] if is_live else state["candidate"]
        receipt = command_receipt(command, cwd, run, label)
        attempt = {"phase": args.phase, "result": "running", "log": str(log), "command": receipt}
        state["attempts"].append(attempt)
        save(run / "state.json", state)
        env = dict(os.environ)
        if not is_live:
            env = {key: value for key, value in env.items() if not key.startswith("BB_")}
            env.update(state["candidate_env"])
            env["BB_DATA_DIR"] = str(run / "staging-data")
        try:
            with log.open("xb") as output:
                log.chmod(0o600)
                process = subprocess.run(command, cwd=cwd,
                                         env=env, stdout=output, stderr=subprocess.STDOUT)
            require(process.returncode == 0, "Operator command failed; see the private phase log")
            require(all(digest(item["path"]) == item["sha256"] for item in receipt["files"]),
                    "Operator executable/script changed while the phase ran")
            verify_sources(state, args.phase, after=True)
            if args.phase == "smoke-candidate":
                state["checklist_hash"] = checklist(state["checklist"])
            if args.phase == "stop-live":
                backup_databases(state, "stopped")
            attempt["result"] = "passed"
            completed.append(args.phase)
        except BaseException:
            attempt["result"] = "failed"
            raise
        finally:
            save(run / "state.json", state)
        print(args.phase + " passed; " + str(log))


def main():
    parser = argparse.ArgumentParser(description="Journal an ordered BB source upgrade without a running BB")
    sub = parser.add_subparsers(dest="action", required=True)
    init = sub.add_parser("init", help="Snapshot source/data and pin a clean candidate")
    for name in ("live-repo", "candidate", "live-data", "run", "recovery-file", "checklist", "candidate-env"):
        init.add_argument("--" + name, required=True)
    init.add_argument("--database", action="append", default=[])
    execute = sub.add_parser("step", help="Run one reviewed foreground phase in order")
    execute.add_argument("--run", required=True)
    execute.add_argument("--phase", choices=PHASES, required=True)
    execute.add_argument("command", nargs=argparse.REMAINDER)
    status = sub.add_parser("status", help="Read the journal without a BB server")
    status.add_argument("--run", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "init":
        initialize(args)
    elif args.action == "step":
        step(args)
    else:
        state = json.loads((Path(args.run) / "state.json").read_text())
        print(json.dumps({"completed": state["completed"],
                          "attempts": [{key: attempt[key] for key in ("phase", "result", "log")}
                                       for attempt in state["attempts"]],
                          "recovery": state["recovery"]}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        print("Upgrade guard stopped: " + str(error), file=sys.stderr)
        sys.exit(1)

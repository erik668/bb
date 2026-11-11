import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("upgrade_guard.py")
SPEC = importlib.util.spec_from_file_location("upgrade_guard", SCRIPT)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class UpgradeGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bb-upgrade-guard-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.live = self.base / "live"
        self.live.mkdir()
        self.git(self.live, "init", "-q")
        self.git(self.live, "config", "user.name", "Upgrade fixture")
        self.git(self.live, "config", "user.email", "fixture@example.invalid")
        self.git(self.live, "config", "commit.gpgsign", "false")
        self.git(self.live, "config", "core.hooksPath", "/dev/null")
        (self.live / "app.txt").write_text("old")
        self.git(self.live, "add", ".")
        self.git(self.live, "commit", "-qm", "Initial fixture")
        self.candidate = self.base / "candidate"
        self.git(self.live, "worktree", "add", "--detach", str(self.candidate), "HEAD")
        (self.candidate / "app.txt").write_text("candidate")
        self.git(self.candidate, "commit", "-qam", "Candidate fixture")
        self.data = self.base / "data"
        self.data.mkdir()
        with sqlite3.connect(self.data / "bb.db") as db:
            db.execute("CREATE TABLE sample(value TEXT)")
            db.execute("INSERT INTO sample VALUES ('before')")
        self.recovery = self.base / "RECOVERY.md"
        self.recovery.write_text("Disposable fixture recovery instructions")
        self.checks = self.base / "customizations.json"
        self.checks.write_text(json.dumps([
            {"behavior": "Fixture preview", "status": "verified", "evidence": "fixture check"}
        ]))
        self.env = self.base / "candidate-env.json"
        self.env.write_text(json.dumps({"BB_SERVER_PORT": "45001"}))
        self.run = self.base / "run"
        self.init_args = argparse.Namespace(
            live_repo=str(self.live), candidate=str(self.candidate), live_data=str(self.data),
            run=str(self.run), recovery_file=str(self.recovery), checklist=str(self.checks),
            candidate_env=str(self.env), database=[],
        )

    def git(self, repo, *args):
        return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)

    def init(self):
        with contextlib.redirect_stdout(io.StringIO()):
            guard.initialize(self.init_args)

    def state(self):
        return json.loads((self.run / "state.json").read_text())

    def step(self, phase, code="pass", env=None):
        args = argparse.Namespace(run=str(self.run), phase=phase,
                                  command=["--", sys.executable, "-c", code])
        clean_env = {key: value for key, value in os.environ.items() if not key.startswith("BB_")}
        clean_env.update(env or {})
        with patch.dict(os.environ, clean_env, clear=True), contextlib.redirect_stdout(io.StringIO()):
            guard.step(args)

    def validated(self):
        self.init()
        self.step("prepare-candidate")
        self.step("smoke-candidate")

    def test_snapshots_dirty_files_deletions_and_consistent_sqlite(self):
        (self.live / "app.txt").unlink()
        (self.live / "local.txt").write_text("local fix")
        self.init()
        with tarfile.open(self.run / "local-files.tar.gz") as archive:
            self.assertEqual(archive.extractfile("local.txt").read(), b"local fix")
        self.assertIn("deleted file", (self.run / "tracked.patch").read_text())
        with sqlite3.connect(self.run / "preflight-databases/0-bb.db") as db:
            self.assertEqual(db.execute("SELECT value FROM sample").fetchone(), ("before",))

    def test_rejects_overlapping_candidate_and_data(self):
        self.init_args.live_data = str(self.candidate)
        with self.assertRaisesRegex(ValueError, "separate from live data"):
            self.init()
        self.assertFalse(self.run.exists())

    def test_rejects_run_inside_serving_checkout(self):
        self.init_args.run = str(self.live / "run")
        with self.assertRaisesRegex(ValueError, "Run artifacts must be separate"):
            self.init()
        self.assertFalse((self.live / "run").exists())

    def test_rejects_dirty_candidate(self):
        (self.candidate / "app.txt").write_text("uncommitted")
        with self.assertRaisesRegex(ValueError, "Commit the integrated candidate"):
            self.init()

    def test_stage_order_rejects_activation_without_validation(self):
        self.init()
        with self.assertRaisesRegex(ValueError, "Phase out of order"):
            self.step("stop-live", "raise Exception('must never execute')")
        self.assertEqual(self.state()["attempts"], [])

    def test_candidate_command_gets_isolated_data_and_no_inherited_bb_target(self):
        self.init()
        self.step("prepare-candidate", "import os; from pathlib import Path; "
                  "assert Path.cwd().name == 'candidate'; "
                  f"assert os.environ['BB_DATA_DIR'] == {str(self.run / 'staging-data')!r}; "
                  "assert os.environ['BB_SERVER_PORT'] == '45001'; "
                  "assert 'BB_SERVER_URL' not in os.environ; "
                  "assert 'BB_AUTH_SECRET' not in os.environ",
                  {"BB_DATA_DIR": str(self.data), "BB_SERVER_URL": "http://live.invalid",
                   "BB_AUTH_SECRET": "synthetic-test-only"})

    def test_drift_invalidates_candidate_receipt(self):
        self.init()
        self.step("prepare-candidate")
        (self.candidate / "app.txt").write_text("changed after build")
        with self.assertRaisesRegex(ValueError, "Candidate changed"):
            self.step("smoke-candidate")

    def test_unverified_customization_blocks_shutdown(self):
        self.init()
        self.step("prepare-candidate")
        self.checks.write_text('[{"behavior":"preview","status":"pending","evidence":""}]')
        with self.assertRaisesRegex(ValueError, "Every customization"):
            self.step("smoke-candidate")
        self.assertEqual(self.state()["completed"], ["prepare-candidate"])
        self.assertEqual(self.state()["attempts"][-1]["result"], "failed")

    def test_app_hosted_agent_cannot_stop_live(self):
        self.validated()
        with self.assertRaisesRegex(ValueError, "independent terminal/harness"):
            self.step("stop-live", env={"BB_THREAD_ID": "fixture-thread"})
        self.assertEqual(len(self.state()["attempts"]), 2)

    def test_source_change_blocks_live_update(self):
        self.validated()
        (self.live / "another-agent.txt").write_text("new user work")
        with self.assertRaisesRegex(ValueError, "Live source differs"):
            self.step("stop-live")
        self.assertEqual((self.live / "another-agent.txt").read_text(), "new user work")

    def test_failed_or_interrupted_phase_cannot_be_silently_retried(self):
        self.init()
        with self.assertRaisesRegex(ValueError, "Operator command failed"):
            self.step("prepare-candidate", "raise SystemExit(9)")
        with self.assertRaisesRegex(ValueError, "failed or was interrupted"):
            self.step("prepare-candidate")
        state = self.state()
        state["attempts"][-1]["result"] = "running"
        guard.save(self.run / "state.json", state)
        with self.assertRaisesRegex(ValueError, "failed or was interrupted"):
            self.step("prepare-candidate")

    def test_wrong_live_commit_fails_after_update_before_start(self):
        self.validated()
        self.step("stop-live")
        with self.assertRaisesRegex(ValueError, "Live source differs"):
            self.step("update-live")
        self.assertEqual(self.state()["completed"][-1], "stop-live")

    def test_recovery_changes_block_activation(self):
        self.validated()
        Path(self.state()["recovery"]).write_text("unreviewed replacement")
        with self.assertRaisesRegex(ValueError, "Recovery procedure changed"):
            self.step("stop-live")

    def test_recovery_copy_survives_loss_of_the_original_runbook(self):
        self.validated()
        self.recovery.unlink()
        self.assertTrue(Path(self.state()["recovery"]).is_file())
        self.step("stop-live")

    def test_receipt_preserves_operator_script_and_detects_self_modification(self):
        self.init()
        script = self.base / "maintenance_fixture.py"
        script.write_text("from pathlib import Path; Path(__file__).write_text('changed')")
        args = argparse.Namespace(run=str(self.run), phase="prepare-candidate",
                                  command=["--", sys.executable, str(script)])
        with self.assertRaisesRegex(ValueError, "Operator executable/script changed"):
            with contextlib.redirect_stdout(io.StringIO()):
                guard.step(args)
        command = self.state()["attempts"][-1]["command"]
        self.assertEqual(command["argv"], [sys.executable, str(script)])
        copied = next(item for item in command["files"] if item["path"] == str(script))
        self.assertIn("write_text", Path(copied["copy"]).read_text())

    def test_full_foreground_sequence_refreshes_backup_after_stop(self):
        self.validated()
        self.step("stop-live", "import sqlite3; "
                  f"db=sqlite3.connect({str(self.data / 'bb.db')!r}); "
                  "db.execute(\"UPDATE sample SET value='at shutdown'\"); db.commit(); db.close()")
        with sqlite3.connect(self.run / "stopped-databases/0-bb.db") as db:
            self.assertEqual(db.execute("SELECT value FROM sample").fetchone(), ("at shutdown",))
        revision = self.state()["candidate_identity"]["commit"]
        self.step("update-live", "import subprocess; "
                  f"subprocess.run(['git','merge','--ff-only',{revision!r}],check=True)")
        for phase in ("prepare-live", "start-live", "smoke-live"):
            self.step(phase)
        self.assertEqual(self.state()["completed"], list(guard.PHASES))
        self.assertTrue(all(attempt["result"] == "passed" for attempt in self.state()["attempts"]))
        self.assertEqual((self.run.stat().st_mode & 0o777), 0o700)


if __name__ == "__main__":
    unittest.main()

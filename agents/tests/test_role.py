"""Обёртка проверяется без сети и запусков поставщиков, только на синтетике."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("role", Path(__file__).parents[1] / "role.py")
role = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(role)


class WorktreeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.cfg = {name: str(self.base / name) for name in ("docs", "code")}
        self.trees = {}
        for name, clone in self.cfg.items():
            self.git("init", "-b", "main", clone)
            self.git("-C", clone, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
                     "commit", "--allow-empty", "-m", "Начало")
            tree = clone + "-wt/feature"
            self.git("-C", clone, "worktree", "add", "-b", "feature", tree)
            self.trees[name] = tree
        self.enter = contextlib.ExitStack()
        self.addCleanup(self.enter.close)
        self.enter.enter_context(patch.object(role, "dev_config", return_value=self.cfg))
        self.enter.enter_context(patch.object(role, "__file__", str(Path(self.cfg["code"]) / "agents/role.py")))
        self.cwd = self.enter.enter_context(patch.object(role.os, "getcwd", return_value=self.cfg["code"]))
        self.enter.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def git(self, *args):
        return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout

    def test_run_requires_code_clone(self):
        with patch.object(role, "__file__", str(self.base / "copy/agents/role.py")):
            with self.assertRaises(SystemExit):
                role.run_worktree(self.trees["code"])
        self.cwd.return_value = self.trees["code"]
        with self.assertRaises(SystemExit):
            role.run_worktree(self.trees["code"])

    def test_run_requires_task_worktree(self):
        for tree in self.trees.values():
            self.assertEqual(role.run_worktree(tree), tree)
        self.git("init", "-b", "feature", str(self.base / "foreign"))
        alias = self.base / "alias"
        alias.symlink_to(self.trees["code"], target_is_directory=True)
        impostor = self.base / "code-wt/impostor"
        self.git("init", "-b", "impostor", str(impostor))
        for path in [*self.cfg.values(), str(self.base), str(self.base / "foreign"), str(alias),
                     str(impostor), self.trees["code"] + "/agents"]:
            with self.subTest(path=path), self.assertRaises(SystemExit):
                role.run_worktree(path)
        with patch.object(role, "cmd_run") as run:
            with self.assertRaises(SystemExit):
                role.main(["run", "B", "--prompt-file", "brief", "--journal", "journal"])
            run.assert_not_called()

    def test_session_failure_prevents_provider(self):
        (Path(self.cfg["docs"]) / "tools").mkdir()
        (Path(self.cfg["docs"]) / "tools/check.py").touch()
        real_run = subprocess.run

        def command(cmd, **kwargs):
            if cmd[-1] == "session":
                self.assertEqual(kwargs["cwd"], self.cfg["code"])
                return subprocess.CompletedProcess(cmd, 1, "клон не чистый", "")
            return real_run(cmd, **kwargs)

        args = argparse.Namespace(cd=self.trees["code"], code="B", claude_unavailable=False,
                                  codex_unavailable=False, effort=None, sandbox=None)
        with patch.object(role, "user", return_value=role.REG["zone_user"]), \
                patch.object(role.subprocess, "run", side_effect=command), \
                patch.object(role, "run_codex") as codex, patch.object(role, "run_claude") as claude:
            with self.assertRaises(SystemExit):
                role.cmd_run(args)
            codex.assert_not_called()
            claude.assert_not_called()

    def test_role_env_prioritizes_clone_cli(self):
        with patch.dict(role.os.environ, {"PATH": "/synthetic", "SOURCECRAFT_SYNTHETIC": "omit"}, clear=True):
            env = role.role_env()
        self.assertEqual(env["PATH"].split(role.os.pathsep)[0],
                         self.cfg["docs"] + "/tools/openspec/node_modules/.bin")
        self.assertNotIn("SOURCECRAFT_SYNTHETIC", env)


if __name__ == "__main__":
    unittest.main()

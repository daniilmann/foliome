import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import orchestrator


class OrchestratorTests(unittest.TestCase):
    session_id = "5fdec920-f489-4db7-8841-38a32064f422"
    other_id = "24314146-394c-4e51-88b5-d1a621b7de28"

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.cwd = Path(temporary.name).resolve()
        self.trace = self.cwd / "rollout.jsonl"
        self.settings = {"model": "example-model", "effort": "medium"}

    def turn(self, turn_id, marker, *, apps=False, tools=None, full=True, model=None):
        return [
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": turn_id}},
            {"type": "response_item", "payload": {"type": "additional_tools", "role": "developer", "tools": []}},
            {"type": "world_state", "payload": {
                "full": full, "state": {"apps_instructions": apps, "top_level_tools": tools if tools is not None else {"functions": "a" * 40, "functions.exec": "b" * 40}}
            }},
            {"type": "turn_context", "payload": {
                "turn_id": turn_id, "cwd": str(self.cwd), **self.settings,
                "model": model if model else self.settings["model"],
            }},
            {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                   "content": [{"type": "input_text", "text": marker + "\nbrief"}]}},
            {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": turn_id,
                                               "last_agent_message": orchestrator.STARTUP_ACK}},
        ]

    def write(self, rows, mode="w"):
        with self.trace.open(mode, encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def metadata(self, source="cli"):
        return {"type": "session_meta", "payload": {"source": source, "id": self.session_id, "cwd": str(self.cwd)}}

    def evaluate(self, marker, offset=0, resume_id=None):
        inventory = orchestrator.inventory_before(self.trace, offset) if offset else None
        evidence = orchestrator.startup_evidence(self.trace, marker, offset, inventory)
        self.assertIsNotNone(evidence)
        return orchestrator.verify_evidence(*evidence, self.settings, self.cwd, resume_id)

    def test_startup_checks_the_marker_turn_not_an_earlier_turn(self):
        self.write([self.metadata(), *self.turn("previous", "другой запуск", apps=True),
                    *self.turn("current", "этот запуск")])
        self.assertEqual(self.evaluate("этот запуск"), self.session_id)
        self.assertIsNone(orchestrator.startup_evidence(self.trace, "несуществующий запуск"))

    def test_missing_inventory_does_not_prove_apps_are_disabled(self):
        self.write([self.metadata(), *self.turn("current", "marker", full=False)])
        with self.assertRaisesRegex(orchestrator.StartupRejected, "коннекторов"):
            self.evaluate("marker")

    def test_missing_or_malformed_additional_tools_rejects_start(self):
        for inventory in (None, {"functions": {}}, [{"type": "tool"}]):
            with self.subTest(inventory=inventory):
                turn = self.turn("current", "marker")
                if inventory is None:
                    del turn[1]
                else:
                    turn[1]["payload"]["tools"] = inventory
                self.write([self.metadata(), *turn])
                with self.assertRaisesRegex(orchestrator.StartupRejected, "коннекторов"):
                    self.evaluate("marker")

    def test_additional_tools_after_the_marker_are_checked_before_probe_finishes(self):
        turn = self.turn("current", "marker")
        self.write([self.metadata(), *turn[:-1]])
        self.assertIsNone(orchestrator.startup_evidence(self.trace, "marker"))
        self.write([
            {"type": "response_item", "payload": {"type": "additional_tools", "role": "developer",
                                                    "tools": [{"name": "mcp__codex_apps__example"}]}},
            turn[-1],
        ], mode="a")
        with self.assertRaisesRegex(orchestrator.StartupRejected, "коннекторов"):
            self.evaluate("marker")

    def test_malformed_or_partial_top_level_inventory_rejects_start(self):
        for tools in ({"functions": "a" * 40},
                      {"functions": "a" * 40, "functions.exec": {"invalid": True}},
                      {"functions": "a" * 40, "functions.exec": "bad"}):
            with self.subTest(tools=tools):
                self.write([self.metadata(), *self.turn("current", "marker", tools=tools)])
                with self.assertRaisesRegex(orchestrator.StartupRejected, "коннекторов"):
                    self.evaluate("marker")

    def test_startup_probe_rejects_calls_before_completion(self):
        turn = self.turn("current", "marker")
        turn.insert(-1, {"type": "response_item", "payload": {"type": "function_call", "name": "functions.exec"}})
        self.write([self.metadata(), *turn])
        with self.assertRaisesRegex(orchestrator.StartupRejected, "без вызова инструментов"):
            self.evaluate("marker")

    def test_clean_exit_before_evidence_is_a_rejected_launch(self):
        process = Mock()
        process.poll.return_value = 0
        with patch.object(orchestrator.role, "rollouts", return_value=set()), \
                self.assertRaisesRegex(orchestrator.StartupRejected, "запись запуска"):
            orchestrator.verify_startup(process, "marker", set(), None, 0, None,
                                        self.settings, self.cwd, None)

    def test_foreign_and_noninteractively_launched_sessions_are_rejected(self):
        self.write([self.metadata("exec"), *self.turn("current", "marker")])
        self.assertIsNone(orchestrator.startup_evidence(self.trace, "marker"))
        self.write([self.metadata(), *self.turn("current", "marker")])
        with self.assertRaisesRegex(orchestrator.StartupRejected, "другой сессии"):
            self.evaluate("marker", resume_id=self.other_id)

    def test_resume_requires_current_settings_and_current_tools(self):
        self.write([self.metadata(), *self.turn("previous", "start")])
        size = self.trace.stat().st_size
        self.assertIsNone(orchestrator.startup_evidence(self.trace, "start", size))
        for turn, message in (
            (self.turn("resumed", "resume", apps=True), "коннекторов"),
            (self.turn("resumed", "resume", tools={"functions": "a" * 40, "functions.exec": "b" * 40, "mcp__codex_apps__example": "c" * 40}), "коннекторов"),
            (self.turn("resumed", "resume", model="other-model"), "effort"),
        ):
            with self.subTest(message=message):
                self.write([self.metadata(), *self.turn("previous", "start"), *turn])
                with self.assertRaisesRegex(orchestrator.StartupRejected, message):
                    self.evaluate("resume", size, self.session_id)
        self.write([self.metadata(), *self.turn("previous", "start"), *self.turn("resumed", "resume")])
        self.assertEqual(self.evaluate("resume", size, self.session_id), self.session_id)

    def test_resume_merges_the_current_inventory_delta(self):
        self.write([self.metadata(), *self.turn("previous", "start")])
        offset = self.trace.stat().st_size
        for tools in ({"collaboration.spawn_agent": "a" * 40}, {"mcp__codex_apps__example": "c" * 40}):
            with self.subTest(tools=tools):
                resumed = self.turn("resumed", "resume", full=False, tools=tools)
                resumed[2]["payload"]["state"].pop("apps_instructions")
                self.write([self.metadata(), *self.turn("previous", "start"), *resumed])
                if "mcp__codex_apps__example" in tools:
                    with self.assertRaisesRegex(orchestrator.StartupRejected, "коннекторов"):
                        self.evaluate("resume", offset, self.session_id)
                else:
                    self.assertEqual(self.evaluate("resume", offset, self.session_id), self.session_id)

    def test_resume_reuses_inventory_when_current_turn_reports_no_changes(self):
        self.write([self.metadata(), *self.turn("previous", "start")])
        offset = self.trace.stat().st_size
        resumed = self.turn("resumed", "resume")
        del resumed[1:3]
        self.write(resumed, mode="a")
        self.assertEqual(self.evaluate("resume", offset, self.session_id), self.session_id)
        evidence = orchestrator.startup_evidence(self.trace, "resume", offset)
        with self.assertRaisesRegex(orchestrator.StartupRejected, "коннекторов"):
            orchestrator.verify_evidence(*evidence, self.settings, self.cwd, self.session_id)

    def test_resume_accepts_only_verified_project_session(self):
        self.trace.touch()
        with patch.object(orchestrator.role, "rollouts", return_value={str(self.trace)}):
            self.assertIsNone(orchestrator.resume_trace(self.cwd, self.session_id))
            orchestrator.save_result(self.cwd / "0001.json", {
                "verified": True, "session_id": self.session_id, "rollout": str(self.trace),
            })
            self.assertEqual(orchestrator.resume_trace(self.cwd, self.session_id), self.trace)
            self.assertIsNone(orchestrator.resume_trace(self.cwd, self.other_id))
            orchestrator.save_result(self.cwd / "0002.json", {"verified": False, "session_id": self.session_id})
            self.assertIsNone(orchestrator.resume_trace(self.cwd, self.session_id))

    def test_both_commands_use_the_roster_and_disable_apps(self):
        for session_id in (None, self.session_id):
            with self.subTest(session_id=session_id):
                cmd = orchestrator.command(self.settings, self.cwd, self.cwd, "prompt", session_id)
                self.assertEqual(cmd[cmd.index("--disable") + 1], "apps")
                self.assertEqual(cmd[cmd.index("-m") + 1], self.settings["model"])
                self.assertEqual(cmd[cmd.index("-c") + 1], 'model_reasoning_effort="medium"')
                self.assertEqual(cmd[-2:] if session_id else cmd[-1:],
                                 [self.session_id, "prompt"] if session_id else ["prompt"])
                self.assertEqual("resume" in cmd, session_id is not None)

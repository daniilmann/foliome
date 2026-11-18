#!/usr/bin/env python3
"""Start an interactive Codex orchestrator after checking the current session (ADR-026)."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import termios
import time
import uuid

import role


SESSION_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
TOOL_DIGEST = re.compile(r"[0-9a-f]{40}")
STARTUP_TIMEOUT = 45
STARTUP_ACK = "FOLIOME_SESSION_READY"


class StartupRejected(Exception):
    """The active session has insufficient or mismatched startup evidence."""


def apply_world_state(previous, payload):
    """Codex writes a full inventory on start and incremental changes on resume."""
    state = payload.get("state") if isinstance(payload, dict) else None
    if not isinstance(state, dict):
        return None
    full = payload.get("full")
    if full is True:
        return state
    if full is not False or previous is None:
        return None
    effective = {**previous, **state}
    if "top_level_tools" in state:
        before, changes = previous.get("top_level_tools"), state["top_level_tools"]
        if not isinstance(before, dict) or not isinstance(changes, dict):
            return None
        # Keep observed tool names when the trace supplies only a patch of the map.
        effective["top_level_tools"] = {**before, **changes}
    return effective


def update_inventory(inventory, kind, payload):
    if kind == "world_state":
        inventory["state"] = apply_world_state(inventory.get("state"), payload)
    elif kind == "response_item" and payload.get("type") == "additional_tools":
        tools = payload.get("tools")
        if isinstance(tools, list):
            inventory.setdefault("tools", []).extend(tools)
        else:
            inventory["tool_inventory_invalid"] = True


def inventory_before(path, offset):
    """Replay the same session's declarations: unchanged inventories are omitted on resume."""
    inventory = {}
    with path.open("rb") as trace:
        while trace.tell() < offset:
            line = trace.readline()
            if not line or not line.endswith(b"\n") or trace.tell() > offset:
                raise StartupRejected("журнал продолжения изменился")
            row = json.loads(line)
            payload = row.get("payload") if isinstance(row, dict) else None
            if isinstance(payload, dict):
                update_inventory(inventory, row.get("type"), payload)
    return inventory


def startup_evidence(path, marker, offset=0, prior_inventory=None):
    """Read the current probe and reconstruct its inventory from complete and incremental records."""
    with path.open(encoding="utf-8") as trace:
        meta = json.loads(trace.readline())
        session = meta.get("payload") if isinstance(meta, dict) else None
        if not isinstance(session, dict) or meta.get("type") != "session_meta" or session.get("source") != "cli":
            return None
        if offset:
            if path.stat().st_size < offset:
                return None
            trace.seek(offset)

        inventory = dict(prior_inventory or {})
        if "tools" in inventory:
            inventory["tools"] = list(inventory["tools"])
        turn = {}
        for line in trace:
            if not line.endswith("\n"):
                break
            row = json.loads(line)
            payload = row.get("payload") if isinstance(row, dict) else None
            if not isinstance(payload, dict):
                continue
            kind = row.get("type")
            update_inventory(inventory, kind, payload)
            if kind == "event_msg" and payload.get("type") == "task_started":
                turn = {"id": payload.get("turn_id")}
            elif (kind == "event_msg" and payload.get("type") == "task_complete"
                  and turn.get("id") and payload.get("turn_id") == turn["id"] and turn.get("matched")):
                turn["ack"] = payload.get("last_agent_message")
                return session, {**inventory, **turn}
            elif kind == "turn_context" and payload.get("turn_id") == turn.get("id"):
                turn["context"] = payload
            elif kind == "response_item":
                item_type = payload.get("type")
                if payload.get("role") == "user":
                    if any(isinstance(item, dict) and isinstance(item.get("text"), str)
                           and item["text"].splitlines()[:1] == [marker]
                           for item in payload.get("content") or ()):
                        turn["matched"] = True
                elif isinstance(item_type, str) and item_type.endswith("_call") and turn.get("matched"):
                    return session, {**inventory, **turn, "tool_called": True}
    return None


def verify_evidence(session, turn, settings, cwd, resume_id):
    session_id = session.get("id")
    if (not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id)
            or (resume_id and session_id != resume_id)):
        raise StartupRejected("журнал относится к другой сессии")
    if turn.get("tool_called") or turn.get("ack") != STARTUP_ACK:
        raise StartupRejected("проверочный ход Codex должен завершиться ответом без вызова инструментов")
    context = turn.get("context") or {}
    if context.get("cwd") != str(cwd):
        raise StartupRejected("сессия запущена из другого каталога")
    if any(context.get(key) != settings[key] for key in ("model", "effort")):
        raise StartupRejected("модель или effort текущей сессии расходятся с ростером")
    state = turn.get("state")
    top_level = state.get("top_level_tools") if isinstance(state, dict) else None
    tools = turn.get("tools")
    if (not isinstance(state, dict) or state.get("apps_instructions") is not False
            or not isinstance(top_level, dict) or not {"functions", "functions.exec"} <= top_level.keys()
            or any(not name or not isinstance(digest, str) or not TOOL_DIGEST.fullmatch(digest)
                   for name, digest in top_level.items())
            or turn.get("tool_inventory_invalid") or not isinstance(tools, list)
            or any(not isinstance(tool, dict) or not isinstance(tool.get("name"), str) or not tool["name"]
                   for tool in tools)
            or "mcp__codex_apps" in json.dumps([top_level, tools])):
        raise StartupRejected("журнал текущей сессии не подтверждает отключение коннекторов")
    return session_id


def resume_trace(journal, session_id):
    """Select the most recent result for an explicitly identified O session."""
    if not SESSION_ID.fullmatch(session_id or ""):
        return None
    rollouts = role.rollouts()
    for path in sorted(journal.glob("*.json"), reverse=True):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict) or record.get("session_id") != session_id:
            continue
        log = record.get("rollout")
        return Path(log) if record.get("verified") is True and isinstance(log, str) and log in rollouts else None
    return None


def command(settings, cwd, journal, prompt, session_id=None):
    args = ["codex", "resume"] if session_id else ["codex"]
    args += ["--disable", "apps", "-m", settings["model"], "-c",
             f'model_reasoning_effort="{settings["effort"]}"', "-s", "workspace-write",
             "-C", str(cwd), "--add-dir", str(journal)]
    return args + ([session_id] if session_id else []) + [prompt]


def save_result(path, result):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, encoding="utf-8", delete=False) as f:
        json.dump(result, f, ensure_ascii=False)
        f.write("\n")
    os.replace(f.name, path)


def verify_startup(process, marker, prior_paths, resumed, offset, prior_inventory, settings, cwd, session_id):
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        paths = {Path(path): 0 for path in role.rollouts() - prior_paths}
        if resumed is not None:
            paths[resumed] = offset
        matches = []
        for path, position in paths.items():
            try:
                evidence = startup_evidence(path, marker, position, prior_inventory if path == resumed else None)
            except (OSError, ValueError):
                continue
            if evidence:
                matches.append((path, *evidence))
        if len(matches) > 1:
            raise StartupRejected("маркер запуска найден в нескольких сессиях Codex")
        if matches:
            path, session, turn = matches[0]
            return path, verify_evidence(session, turn, settings, cwd, session_id)
        if process.poll() is not None:
            break
        time.sleep(0.25)
    raise StartupRejected("проверяемая запись запуска Codex не появилась")


def stop_startup(child, terminal):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    termios.tcsetattr(sys.stdin, termios.TCSADRAIN, terminal)


def launch(settings, cwd, journal, session_id=None, resumed=None):
    run = f"{time.time_ns()}-{uuid.uuid4().hex}"
    marker = f"foliome-orchestrator:{run}"
    result_path = journal / f"{run}.json"
    brief = cwd / "p1-orchestrator-brief.md"
    prompt = (
        f"{marker}\n"
        f"Это проверочный ход для проверки конфигурации сессии. Используй только текстовый ответ {STARTUP_ACK}. "
        "Инструменты не вызывай и работу по задачам не начинай."
    )
    prior_paths = role.rollouts()
    try:
        offset = resumed.stat().st_size if resumed else 0
        prior_inventory = inventory_before(resumed, offset) if resumed else None
    except (OSError, ValueError, StartupRejected):
        print("Codex O: журнал продолжения недоступен или повреждён.", file=sys.stderr)
        return None
    terminal = termios.tcgetattr(sys.stdin)
    result = {"ts": role.now(), "session_id": session_id, "verified": False}
    print(f"Codex O: {'продолжение ' + session_id if session_id else 'новая сессия'}", flush=True)
    child = subprocess.Popen(command(settings, cwd, journal.parent, prompt, session_id),
                             env={**os.environ, **role.OPENSPEC_ENV})
    try:
        rollout, actual_id = verify_startup(child, marker, prior_paths, resumed, offset, prior_inventory,
                                            settings, cwd, session_id)
        result.update(settings, session_id=actual_id, rollout=str(rollout), verified=True, connectors=False)
        save_result(result_path, result)
    except (StartupRejected, OSError, KeyboardInterrupt) as exc:
        stop_startup(child, terminal)
        if isinstance(exc, KeyboardInterrupt):
            return 130
        if isinstance(exc, OSError):
            raise
        save_result(result_path, {**result, "reason": str(exc)})
        print(f"Codex O: {exc}", file=sys.stderr)
        return None

    message = f"Запуск O подтверждён. Сообщи ID {actual_id} и выполни бриф {brief}."
    if child.poll() is not None:
        save_result(result_path, {**result, "verified": False, "reason": "сессия закончилась до передачи брифа"})
        return 3
    try:
        sent = subprocess.run(["codex", "queue", "--disable", "apps", "-C", str(cwd),
                               "--thread", actual_id, "--message", message],
                              capture_output=True, text=True, timeout=15)
        delivered = sent.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        delivered = False
    if not delivered:
        save_result(result_path, {**result, "verified": False, "reason": "передача брифа не подтверждена"})
        print("Codex O: передача брифа не подтверждена. Автоматический повтор остановлен.", file=sys.stderr)
        stop_startup(child, terminal)
        return 3
    return child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("start", "resume"))
    parser.add_argument("session_id", nargs="?")
    args = parser.parse_args()
    if args.mode == "start" and args.session_id:
        parser.error("ID указывается только для resume")
    if role.user() != role.REG["zone_user"]:
        role.die("оркестратор работает только в учётке dev")
    cfg = role.dev_config()
    if not cfg or Path(cfg.get("code", "")).expanduser().resolve() != Path(role.ROOT):
        role.die("запуск оркестратора разрешён из основного клона кода")
    if not sys.stdin.isatty():
        role.die("оркестратору нужен интерактивный терминал")
    role.session_check()

    cwd = Path(role.ROOT).parent
    if not (cwd / "p1-orchestrator-brief.md").is_file():
        role.die("нет брифа оркестратора в каталоге проектов")
    journal = Path.home() / "foliome-journal/orchestrator"
    journal.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings = role.REG["orchestrator"]
    resumed = resume_trace(journal, args.session_id)
    if args.mode == "resume" and resumed is None:
        print("Подтверждённой сессии O с этим ID нет. Начинаю новую по брифу.", file=sys.stderr)
    status = launch(settings, cwd, journal, args.session_id if resumed else None, resumed)
    if status is None:
        status = launch(settings, cwd, journal)
    return 3 if status is None else status


if __name__ == "__main__":
    sys.exit(main())

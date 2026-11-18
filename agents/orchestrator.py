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
STARTUP_TIMEOUT = 45


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


def world_state_before(path, offset):
    state = None
    with path.open("rb") as trace:
        while trace.tell() < offset:
            line = trace.readline()
            if not line or not line.endswith(b"\n") or trace.tell() > offset:
                return None
            row = json.loads(line)
            if isinstance(row, dict) and row.get("type") == "world_state":
                state = apply_world_state(state, row.get("payload") or {})
    return state


def startup_evidence(path, marker, offset=0, prior_world=None):
    """Read tool and model evidence for the turn with this launch's user marker."""
    with path.open(encoding="utf-8") as trace:
        meta = json.loads(trace.readline())
        session = meta.get("payload") if isinstance(meta, dict) else None
        if not isinstance(session, dict) or meta.get("type") != "session_meta" or session.get("source") != "cli":
            return None
        if offset:
            if path.stat().st_size < offset:
                return None
            trace.seek(offset)

        turn = {}
        world = prior_world
        for line in trace:
            if not line.endswith("\n"):
                break
            row = json.loads(line)
            payload = row.get("payload") if isinstance(row, dict) else None
            if not isinstance(payload, dict):
                continue
            kind = row.get("type")
            if kind == "event_msg" and payload.get("type") == "task_started":
                turn = {"id": payload.get("turn_id")}
            elif kind == "world_state":
                world = apply_world_state(world, payload)
                if world is None:
                    turn.pop("state", None)
                else:
                    turn["state"] = world
            elif kind == "turn_context" and payload.get("turn_id") == turn.get("id"):
                turn["context"] = payload
            elif kind == "response_item" and payload.get("type") == "additional_tools":
                turn["tools"] = payload.get("tools")
            elif kind == "response_item" and payload.get("role") == "user":
                if any(isinstance(item, dict) and isinstance(item.get("text"), str)
                       and item["text"].splitlines()[:1] == [marker]
                       for item in payload.get("content") or ()):
                    turn["matched"] = True
            if turn.get("id") and turn.get("matched") and "state" in turn and "context" in turn:
                return session, turn
    return None


def verify_evidence(session, turn, settings, cwd, resume_id):
    session_id = session.get("id")
    if (not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id)
            or (resume_id and session_id != resume_id)):
        raise StartupRejected("журнал относится к другой сессии")
    context = turn["context"]
    if context.get("cwd") != str(cwd):
        raise StartupRejected("сессия запущена из другого каталога")
    if any(context.get(key) != settings[key] for key in ("model", "effort")):
        raise StartupRejected("модель или effort текущей сессии расходятся с ростером")
    state = turn["state"]
    if (not isinstance(state, dict) or state.get("apps_instructions") is not False
            or not isinstance(state.get("top_level_tools"), dict)
            or "mcp__codex_apps" in json.dumps([state.get("top_level_tools"), turn.get("tools")])):
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


def verify_startup(process, marker, prior_paths, resumed, offset, prior_world, settings, cwd, session_id):
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while process.poll() is None and time.monotonic() < deadline:
        paths = {Path(path): 0 for path in role.rollouts() - prior_paths}
        if resumed is not None:
            paths[resumed] = offset
        matches = []
        for path, position in paths.items():
            try:
                evidence = startup_evidence(path, marker, position, prior_world if path == resumed else None)
            except (OSError, ValueError):
                continue
            if evidence:
                matches.append((path, *evidence))
        if len(matches) > 1:
            raise StartupRejected("маркер запуска найден в нескольких сессиях Codex")
        if matches:
            path, session, turn = matches[0]
            return path, verify_evidence(session, turn, settings, cwd, session_id)
        time.sleep(0.25)
    if process.returncode == 0:
        return None
    raise StartupRejected("проверяемая запись запуска Codex не появилась")


def launch(settings, cwd, journal, session_id=None, resumed=None):
    run = f"{time.time_ns()}-{uuid.uuid4().hex}"
    marker = f"foliome-orchestrator:{run}"
    result_path = journal / f"{run}.json"
    brief = cwd / "p1-orchestrator-brief.md"
    prompt = (
        f"{marker}\n"
        f"Это проверка запуска оркестратора O. Прежде чем читать материалы проекта или выполнять задачу, "
        f"проверь файл {result_path}. Начинай работу только когда в нём verified=true. "
        f"Если файл пока отсутствует, повтори чтение через секунду. При отказе остановись. "
        f"После подтверждения сообщи ID сессии из файла и выполни бриф {brief}."
    )
    prior_paths = role.rollouts()
    try:
        offset = resumed.stat().st_size if resumed else 0
        prior_world = world_state_before(resumed, offset) if resumed else None
    except (OSError, ValueError):
        print("Codex O: журнал продолжения недоступен.", file=sys.stderr)
        return None
    terminal = termios.tcgetattr(sys.stdin)
    result = {"ts": role.now(), "session_id": session_id, "verified": False}
    print(f"Codex O: {'продолжение ' + session_id if session_id else 'новая сессия'}", flush=True)
    child = subprocess.Popen(command(settings, cwd, journal.parent, prompt, session_id),
                             env={**os.environ, **role.OPENSPEC_ENV})
    try:
        verified = verify_startup(child, marker, prior_paths, resumed, offset, prior_world, settings, cwd, session_id)
        if verified is not None:
            rollout, actual_id = verified
            save_result(result_path, {**result, **settings, "session_id": actual_id,
                                      "rollout": str(rollout), "verified": True, "connectors": False})
    except (StartupRejected, OSError, KeyboardInterrupt) as exc:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, terminal)
        if isinstance(exc, KeyboardInterrupt):
            return 130
        if isinstance(exc, OSError):
            raise
        save_result(result_path, {**result, "reason": str(exc)})
        print(f"Codex O: {exc}", file=sys.stderr)
        return None
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

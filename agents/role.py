#!/usr/bin/env python3
"""Запуск ролей ADR-022 на закреплённых моделях.

Команды:
  list                  — реестр ролей.
  build [--fallback]    — собрать субагентов Claude в .claude/agents/ (model, effort, tools, maxTurns из реестра) и
                          инструкции ролей Codex в agents/codex/ — из определений плагинов ecc и voltagent учётки, где
                          идёт сборка. --fallback: ещё Claude-версии пишущих ролей (Codex недоступен).
  run CODE --prompt-file F --journal J [--cd DIR] [--simple] [--effort E] [--sandbox S] [--reason R]
           [--claude-unavailable | --codex-unavailable]
                        — запустить роль: Claude — `claude -p --agent foliome-<код>` из корня репозитория (файлы ролей
                          основной ветки), рабочая папка задачи — --cd; Codex — `codex exec` с моделью, effort, песочницей
                          и инструкциями флагами. В журнал: запрос и ответ дословно, запрошенная и фактическая модель,
                          SHA и файлы до и после. Фактическая модель не та — код выхода 3.
  state --cd DIR        — отпечаток рабочей папки (HEAD и хеш изменений): O сверяет его до и после проверяющей роли.
  log --journal J --kind K --role CODE (--text T | --text-file F)
                        — записать в журнал решение оркестратора, вывод проверок или заметку.
Проверка учётки здесь — защита от ошибки, а не граница: границу держит учётка ОС (ADR-000, ADR-001).
"""
import argparse, datetime, glob, hashlib, json, os, pwd, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, "agents")
SNAP = os.path.join(HERE, "codex")
OUT = os.path.join(ROOT, ".claude", "agents")
PREFIX = "foliome-"
MARK = "Сгенерировано agents/role.py build"
REG = json.load(open(os.path.join(HERE, "roles.json"), encoding="utf-8"))
COMMON = open(os.path.join(HERE, "common-overlay.md"), encoding="utf-8").read().strip()
CLAUDE_PLUGINS = os.path.expanduser("~/.claude/plugins/cache")
CODEX_HOME = os.path.expanduser("~/.codex")
READ_TOOLS = ["Read", "Grep", "Glob"]
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
CODEX_ADAPTER = ("You are the agent below, adapted as a Codex role. Treat Claude Code tool names as capability hints; "
                 "use only tools available in this Codex session.\n\n")


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def die(msg, code=1):
    print(f"role.py: {msg}", file=sys.stderr)
    sys.exit(code)


def user():
    return pwd.getpwuid(os.geteuid()).pw_name  # не из переменных окружения


# ---------- определения агентов ----------
def version_key(path):
    """Версия каталога плагина: релиз 2.0.0 старше 2.0.0-rc.1."""
    ver = next((part for part in path.split(os.sep) if re.match(r"^\d+\.\d+", part)), "0")
    core, _, pre = ver.partition("-")
    return ([int(x) for x in re.findall(r"\d+", core)], 0 if pre else 1, pre)


def claude_def_path(agent):
    """ecc:X или voltagent-<sub>:X → файл определения последней версии плагина."""
    plugin, name = agent.split(":", 1)
    if plugin == "ecc":
        pat = os.path.join(CLAUDE_PLUGINS, "ecc", "ecc", "*", "agents", f"{name}.md")
    else:
        pat = os.path.join(CLAUDE_PLUGINS, "voltagent-subagents", plugin, "*", f"{name}.md")
    found = sorted(glob.glob(pat), key=version_key)
    if not found:
        die(f"нет определения {agent} ({pat}): установите плагины ecc и voltagent в этой учётке")
    return found[-1]


def codex_to_claude_agent(codex_agent):
    """ecc-X → ecc:X; voltagent-X → voltagent-<sub>:X."""
    if codex_agent.startswith("ecc-"):
        return "ecc:" + codex_agent[4:]
    name = codex_agent[len("voltagent-"):]
    hits = glob.glob(os.path.join(CLAUDE_PLUGINS, "voltagent-subagents", "*", "*", f"{name}.md"))
    subs = sorted({h.split(os.sep)[-3] for h in hits})
    if len(subs) != 1:
        die(f"Claude-агент для {codex_agent}: найдено {subs or 'ничего'}")
    return subs[0] + ":" + name


def claude_to_codex_agent(agent):
    plugin, name = agent.split(":", 1)
    return ("ecc-" if plugin == "ecc" else "voltagent-") + name


def split_frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip()
    return fm, m.group(2)


def parse_tools(raw):
    if not raw:
        return list(READ_TOOLS)
    return [t.strip().strip('"\'') for t in raw.strip().strip("[]").split(",") if t.strip()]


# ---------- сборка ----------
def build_claude(code, role, agent, model, review, suffix=""):
    src = claude_def_path(agent)
    fm, body = split_frontmatter(open(src, encoding="utf-8").read())
    base = parse_tools(fm.get("tools"))
    tools = base + [t for t in role.get("tools_add", []) if t not in base]
    if review:
        tools = [t for t in tools if t not in WRITE_TOOLS] or list(READ_TOOLS)
    name = f"{PREFIX}{code.lower()}{suffix}"
    desc = f"foliome, роль {code} (ADR-022): {role['when']}. Агент {agent}; модель {model}, effort {role['effort']}."
    text = "\n".join([
        "---", f"name: {name}", f"description: {json.dumps(desc, ensure_ascii=False)}", f"tools: {', '.join(tools)}",
        f"model: {model}", f"effort: {role['effort']}", f"maxTurns: {REG['max_turns']['review' if review else 'default']}",
        "---", "", f"<!-- {MARK}. Не править руками: правится реестр agents/roles.json. -->",
        f"<!-- Источник: {os.path.relpath(src, os.path.expanduser('~'))} -->", "",
        COMMON, "", f"## Оговорка роли {code}", "", role["overlay"], "", "## Исходное определение агента", "",
        body.strip(), ""])
    path = os.path.join(OUT, f"{name}.md")
    open(path, "w", encoding="utf-8").write(text)
    return path


def build_codex(agent):
    """Инструкции роли Codex = определение того же агента из плагина Claude (TOML агентов Codex не нужны)."""
    _, body = split_frontmatter(open(claude_def_path(codex_to_claude_agent(agent)), encoding="utf-8").read())
    path = os.path.join(SNAP, f"{agent}.md")
    open(path, "w", encoding="utf-8").write(CODEX_ADAPTER + body.strip() + "\n")
    return path


def cmd_build(a):
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(SNAP, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, f"{PREFIX}*.md")):  # только наши сгенерированные файлы
        if MARK in open(old, encoding="utf-8").read():
            os.remove(old)
    for old in glob.glob(os.path.join(SNAP, "*.md")):  # agents/codex/ целиком генерируется
        os.remove(old)
    made = []
    for code, r in REG["roles"].items():
        if r["side"] == "claude":
            made.append(build_claude(code, r, r["agent"], r["model"], r.get("review", False)))
            if r.get("review"):
                made.append(build_claude(code, r, r["agent"], REG["simple"]["claude"], True, suffix="-simple"))
        else:
            made.append(build_codex(r["agent"]))
            if a.fallback:
                made.append(build_claude(code, r, codex_to_claude_agent(r["agent"]), "claude-opus-5-5", False,
                                         suffix="-claude"))
    for p in made:
        print(os.path.relpath(p, ROOT))


# ---------- запуск ----------
def git(cwd, *args):
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def fingerprint(cwd):
    head = git(cwd, "rev-parse", "HEAD")
    if head is None:  # не репозиторий git: отпечаток по содержимому файлов
        h = hashlib.sha256()
        for d, dirs, files in os.walk(cwd):
            dirs[:] = sorted(x for x in dirs if x != ".git")
            for f in sorted(files):
                path = os.path.join(d, f)
                try:
                    h.update(path.encode() + open(path, "rb").read())
                except OSError:
                    pass
        return {"head": None, "changes": h.hexdigest()}
    changes = (git(cwd, "status", "--porcelain", "--untracked-files=all", "--ignored") or "") + (git(cwd, "diff", "HEAD") or "")
    return {"head": head, "changes": hashlib.sha256(changes.encode()).hexdigest()}


def rollouts():
    return set(glob.glob(os.path.join(CODEX_HOME, "sessions", "*", "*", "*", "rollout-*.jsonl")))


def codex_context(new_files, cwd):
    """Фактические модель, effort, песочница — из единственной новой сессии Codex с этой рабочей папкой."""
    found = []
    for f in new_files:
        ctx = None
        for line in open(f, encoding="utf-8"):
            try:
                o = json.loads(line)
            except ValueError:
                continue
            p = o.get("payload") or {}
            if o.get("type") == "turn_context" and ctx is None:
                ctx = {"model": p.get("model"), "effort": p.get("effort"), "cwd": p.get("cwd"),
                       "sandbox": (p.get("sandbox_policy") or {}).get("type"), "rollout": f, "tokens": None}
            elif ctx and isinstance(p, dict) and p.get("type") == "token_count" and p.get("info"):
                ctx["tokens"] = p["info"].get("total_token_usage")
        if ctx and ctx["cwd"] == cwd:
            found.append(ctx)
    if len(found) == 1:
        return found[0]
    return {"model": None, "effort": None, "sandbox": None, "rollout": None, "tokens": None,
            "error": f"новых сессий Codex с этой папкой: {len(found)}"}


def run_codex(role, code, model, effort, sandbox, prompt, cwd, out):
    path = os.path.join(SNAP, f"{role['agent']}.md")
    if not os.path.exists(path):
        die(f"нет {os.path.relpath(path, ROOT)}: выполните build")
    di = open(path, encoding="utf-8").read() + "\n\n" + COMMON + f"\n\n## Оговорка роли {code}\n\n" + role["overlay"] + "\n"
    cmd = ["codex", "exec", "--disable", "multi_agent", "-m", model, "-c", f'model_reasoning_effort="{effort}"',
           "-s", sandbox, "-c", "developer_instructions=" + json.dumps(di, ensure_ascii=False),
           "-C", cwd, "--skip-git-repo-check", "-o", out, "-"]
    before = rollouts()
    r = subprocess.run(cmd, input=prompt, capture_output=True, text=True)
    ctx = codex_context(rollouts() - before, cwd)
    response = open(out, encoding="utf-8").read() if os.path.exists(out) else ""
    return r, ctx, response


def run_claude(name, model, prompt, cwd):
    agent_file = os.path.join(OUT, f"{name}.md")
    if not os.path.exists(agent_file):
        die(f"нет {os.path.relpath(agent_file, ROOT)}: выполните build" + (" --fallback" if name.endswith("-claude") else ""))
    fm, _ = split_frontmatter(open(agent_file, encoding="utf-8").read())
    cmd = ["claude", "-p", "--agent", name, "--permission-mode", "dontAsk", "--output-format", "json", "--strict-mcp-config",
           "--allowedTools", *parse_tools(fm.get("tools"))]
    if cwd != ROOT:
        cmd += ["--add-dir", cwd]
    env = dict(os.environ, ENABLE_CLAUDEAI_MCP_SERVERS="false")  # без коннекторов claude.ai (ADR-022 п. 6)
    r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=ROOT, env=env)  # файлы ролей — из корня
    try:
        d = json.loads(r.stdout)
    except ValueError:
        d = {}
    models = sorted((d.get("modelUsage") or {}).keys())
    ctx = {"model": models[0] if len(models) == 1 else (models or None), "effort": fm.get("effort"),
           "sandbox": None, "rollout": d.get("session_id"), "tokens": d.get("usage"), "cost_usd": d.get("total_cost_usd")}
    return r, ctx, d.get("result") or ""


def append(journal, rec):
    os.makedirs(os.path.dirname(os.path.abspath(journal)), exist_ok=True)
    with open(journal, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def cmd_run(a):
    code = a.code
    role = dict(REG["roles"].get(code) or die(f"нет роли {code}"))
    me = user()
    if (REG["p1_started"] or role.get("phase") != "design") and me != REG["zone_user"]:
        die(f"роль {code} работает только в учётке `{REG['zone_user']}` (ADR-022 п. 6), сейчас `{me}`")
    side = role["side"]
    if side == "claude" and a.claude_unavailable:  # ревьюер в Codex, только чтение (ADR-022 п. 8)
        side = "codex"
        role.update(agent=claude_to_codex_agent(role["agent"]), model=REG["roles"]["B"]["model"],
                    sandbox="read-only" if role.get("review") else "danger-full-access")
    elif side == "codex" and a.codex_unavailable:  # пишущая роль — субагент Claude того же агента
        side = "claude-fallback"
    if (a.effort and a.effort != role["effort"]) or (a.sandbox and a.sandbox != role.get("sandbox")):
        if not a.reason:
            die("отступ от реестра — только с --reason")
    prompt = open(a.prompt_file, encoding="utf-8").read()
    cwd = os.path.abspath(a.cd)
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.journal)), f"last-{code}.md")
    for p in (a.journal, out):  # иначе запись журнала выглядела бы как правка проверяющей роли
        if any(os.path.realpath(p).startswith(os.path.realpath(d) + os.sep) for d in (cwd, ROOT)):
            die("журнал и ответ — вне репозитория и папки задачи (ADR-022 п. 7)")
    before = {"task": fingerprint(cwd), "root": fingerprint(ROOT)}
    started = now()
    if side == "codex":
        model = REG["simple"]["codex"] if a.simple else role["model"]
        effort = a.effort or role["effort"]
        sandbox = a.sandbox or role.get("sandbox", "read-only")
        r, ctx, response = run_codex(role, code, model, effort, sandbox, prompt, cwd, out)
    else:
        if a.simple and side == "claude":
            name, model = f"{PREFIX}{code.lower()}-simple", REG["simple"]["claude"]
        elif side == "claude-fallback":
            name, model = f"{PREFIX}{code.lower()}-claude", "claude-opus-5-5"
        else:
            name, model = f"{PREFIX}{code.lower()}", role["model"]
        effort, sandbox = role["effort"], None
        r, ctx, response = run_claude(name, model, prompt, cwd)
        open(out, "w", encoding="utf-8").write(response)
    after = {"task": fingerprint(cwd), "root": fingerprint(ROOT)}
    changed = None
    bh, ah = before["task"]["head"], after["task"]["head"]
    if bh and ah and bh != ah:
        changed = (git(cwd, "diff", "--name-only", f"{bh}..{ah}") or "").splitlines()
    touched = before != after
    append(a.journal, {
        "ts": started, "kind": "call", "role": code, "side": side, "agent": role["agent"], "user": me,
        "requested": {"model": model, "effort": effort, "sandbox": sandbox}, "actual": ctx,
        "reason": a.reason, "cwd": cwd, "before": before, "after": after, "changed_files": changed,
        "reviewer_touched_files": touched if role.get("review") else None,
        "exit": r.returncode, "prompt": prompt, "response": response,
    })
    mismatch = ctx.get("model") != model or (side == "codex" and ctx.get("effort") != effort)
    print(f"роль {code} ({side}): {ctx.get('model')} / {ctx.get('effort')}; exit {r.returncode}; ответ — {out}")
    if mismatch:
        print(f"ВНИМАНИЕ: запрошено {model}/{effort}, фактически {ctx.get('model')}/{ctx.get('effort')} "
              f"{ctx.get('error', '')}", file=sys.stderr)
    if role.get("review") and touched:
        print("ВНИМАНИЕ: проверяющая роль изменила рабочую папку — это находка (ADR-022 п. 7)", file=sys.stderr)
    if r.returncode != 0:
        print(r.stderr[-2000:], file=sys.stderr)
    sys.exit(r.returncode or (3 if mismatch or (role.get("review") and touched) else 0))


def cmd_state(a):
    print(json.dumps(fingerprint(os.path.abspath(a.cd))))


def cmd_log(a):
    text = a.text if a.text is not None else open(a.text_file, encoding="utf-8").read()
    append(a.journal, {"ts": now(), "kind": a.kind, "role": a.role, "user": user(), "text": text})
    print("записано")


def cmd_list(_):
    for code, r in REG["roles"].items():
        print(f"{code:3} {r['side']:6} {r['agent']:36} {r['model']:16} {r['effort']:6} {r['when']}")


p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sp = p.add_subparsers(dest="cmd", required=True)
sp.add_parser("list").set_defaults(f=cmd_list)
b = sp.add_parser("build"); b.add_argument("--fallback", action="store_true"); b.set_defaults(f=cmd_build)
r = sp.add_parser("run"); r.add_argument("code"); r.add_argument("--prompt-file", required=True)
r.add_argument("--journal", required=True); r.add_argument("--cd", default=ROOT); r.add_argument("--simple", action="store_true")
r.add_argument("--effort", choices=["low", "medium", "high"])
r.add_argument("--sandbox", choices=["read-only", "workspace-write", "danger-full-access"])
r.add_argument("--reason"); r.add_argument("--out")
fb = r.add_mutually_exclusive_group(); fb.add_argument("--claude-unavailable", action="store_true")
fb.add_argument("--codex-unavailable", action="store_true"); r.set_defaults(f=cmd_run)
st = sp.add_parser("state"); st.add_argument("--cd", default=ROOT); st.set_defaults(f=cmd_state)
lg = sp.add_parser("log"); lg.add_argument("--journal", required=True)
lg.add_argument("--kind", required=True, choices=["decision", "check", "note"])
lg.add_argument("--role", required=True); g = lg.add_mutually_exclusive_group(required=True)
g.add_argument("--text"); g.add_argument("--text-file"); lg.set_defaults(f=cmd_log)
args = p.parse_args()
args.f(args)

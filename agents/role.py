#!/usr/bin/env python3
"""Запуск ролей ADR-022 на закреплённых моделях.

Команды:
  list                  — реестр ролей.
  build                — собрать инструкции ролей из нативных определений Codex ECC и VoltAgent.
  run CODE --prompt-file F --journal J --cd DIR [--simple] [--effort E] [--sandbox S] [--reason R]
                       — запустить свежую сессию codex exec с инструкциями роли и без коннекторов.
                         Ревью — только read-only. В журнал — запрос, ответ, SHA, diff, настройки
                         и фактические параметры сессии. Несовпадение модели, effort или нарушение
                         ограничений роли даёт код 3. При недоступности Codex вызов можно повторить позже.
  state --cd DIR        — отпечаток рабочей папки (HEAD и хеш изменений): O сверяет его до и после проверяющей роли.
  log --journal J --kind K --role CODE (--text T | --text-file F)
                        — записать в журнал решение оркестратора, вывод проверок или заметку.
  escalate --journal-dir D --task N --out F
                        — пакет E из первоисточников одной задачи, без запуска роли.
                          По умолчанию: task.txt, plan.md либо change/ целиком, problem.md (взгляд O),
                          все *.jsonl и остальные файлы D — свидетельства, находки, ответы и решения.
                          Необязательный sources.json: task_number (число), task (файл), plan (файл),
                          change (каталог), problem (файл); пути относительно D, без выхода и симлинков.
                          Другие файлы тоже включаются дословно; пропуски и ошибки помечаются.
                          D — журнал одной задачи внутри ~/foliome-journal/, без симлинков и жёстких ссылок;
                          известный другой номер в нём — отказ.
                          F — новый файл, ни один существующий источник не перезаписывается.
Проверка учётки здесь — защита от ошибки, а не граница: границу держит учётка ОС (ADR-000, ADR-001).
"""
import argparse, datetime, glob, hashlib, json, os, pwd, re, subprocess, sys, tempfile, tomllib
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
HERE = os.path.join(ROOT, "agents")
SNAP = os.path.join(HERE, "codex")
REG = json.load(open(os.path.join(HERE, "roles.json"), encoding="utf-8"))
COMMON = open(os.path.join(HERE, "common-overlay.md"), encoding="utf-8").read().strip()
CODEX_HOME = os.path.expanduser(os.environ.get("CODEX_HOME", "~/.codex"))
DEV_CONFIG = os.path.expanduser("~/.config/foliome/dev.json")  # настройка `dev` вне кода (ADR-024 А.1)
OPENSPEC_ENV = {"OPENSPEC_TELEMETRY": "0", "DO_NOT_TRACK": "1", "OPENSPEC_NO_UPDATE_CHECK": "1"}


def dev_config():
    try:
        with open(DEV_CONFIG, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        return None
    return cfg if isinstance(cfg, dict) and isinstance(cfg.get("docs"), str) else None


def role_env():
    """Окружение роли: без переменных SourceCraft (токена нет в окружении, ADR-022 п. 6 по ADR-024 Б.6),
    с CLI OpenSpec репозитория документов в PATH и переменными ADR-024 А.1. Защита от ошибки, не граница."""
    env = {k: v for k, v in os.environ.items() if "SOURCECRAFT" not in k.upper()}
    env.update(OPENSPEC_ENV)
    # git без credential helper и без запроса пароля: push и `git credential fill` — только у O (Б.8)
    n = int(env.get("GIT_CONFIG_COUNT", "0") or 0)
    env.update({"GIT_CONFIG_COUNT": str(n + 1), f"GIT_CONFIG_KEY_{n}": "credential.helper", f"GIT_CONFIG_VALUE_{n}": "",
                "GIT_TERMINAL_PROMPT": "0"})
    cfg = dev_config()
    if cfg:
        bin_dir = os.path.join(os.path.expanduser(cfg["docs"]), "tools", "openspec", "node_modules", ".bin")
        env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
    return env


def session_check():
    """ADR-022 п. 7 (ADR-024 Б.7): перед ролью разработки — `tools/check.py session`; провал — отказ без запуска."""
    cfg = dev_config()
    if not cfg or not isinstance(cfg.get("code"), str):
        die(f"нет настройки {DEV_CONFIG} с ключами docs и code — проверка session невозможна (ADR-024 А.1)")
    docs = os.path.expanduser(cfg["docs"])
    check = os.path.join(docs, "tools", "check.py")
    if not os.path.exists(check):
        die(f"нет {check} (ADR-024 п. 7)")
    try:
        r = subprocess.run([sys.executable, check, "session"], capture_output=True, text=True, env=role_env(),
                           cwd=os.path.expanduser(cfg["code"]), timeout=300)
    except subprocess.TimeoutExpired:
        die("check.py session не ответила за 300 с — роль не запускается")
    if r.returncode:
        die("check.py session не прошла — роль не запускается (ADR-024 Б.7):\n" + (r.stdout + r.stderr).strip())


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def die(msg, code=1):
    print(f"role.py: {msg}", file=sys.stderr)
    sys.exit(code)


def user():
    return pwd.getpwuid(os.geteuid()).pw_name  # не из переменных окружения


# ---------- сборка ----------
def codex_role_instructions(agent):
    """Из нативного определения берём текст. Модель, effort и sandbox берём из реестра."""
    pack, name = agent.split("-", 1)
    if pack not in ("ecc", "voltagent") or not re.fullmatch(r"[a-z][a-z0-9-]+", name):
        die(f"неизвестное определение роли Codex: {agent}")
    source = Path(CODEX_HOME, "agents", pack, name + ".toml")
    try:
        with source.open("rb") as fh:
            instructions = tomllib.load(fh).get("developer_instructions")
    except (OSError, ValueError) as exc:
        die(f"не удалось прочитать определение {agent} из {source}: {exc}")
    if not isinstance(instructions, str) or not instructions.strip():
        die(f"в {source} нет текста developer_instructions")
    return scrub(instructions.strip() + "\n")


# Определения плагинов публикуются в этом публичном репозитории: ссылки на задачи с номером убираются,
# иначе их ловит проверка публичного кода (ADR-024 п. 6, А.4 `public`).
TASK_REF = re.compile(r"(?i)(задач\w{0,3}|issues?|tasks?)([^\w\n\"'`]{0,3})(?:#|№)?[0-9]+")  # как в check.py


def scrub(text):
    return TASK_REF.sub(lambda m: m.group(1) + m.group(2) + "<n>", text)


def cmd_build(_):
    snapshots = {agent: codex_role_instructions(agent)
                 for agent in sorted({r["agent"] for r in REG["roles"].values()})}
    os.makedirs(SNAP, exist_ok=True)
    for agent, instructions in snapshots.items():
        path = Path(SNAP, agent + ".md")
        path.write_text(instructions, encoding="utf-8")
        print(os.path.relpath(path, ROOT))


# ---------- запуск ----------
def git(cwd, *args):
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def run_worktree(directory):
    """Проверка происхождения обёртки и зарегистрированного ворктри (ADR-024 А.10.5–6)."""
    cfg = dev_config()
    if not cfg or not all(isinstance(cfg.get(k), str) and cfg[k] for k in ("docs", "code")):
        die("для run нужны настройки docs и code")
    clones = {k: os.path.realpath(os.path.expanduser(cfg[k])) for k in ("docs", "code")}
    code = clones["code"]
    wrapper = os.path.abspath(__file__)
    if (ROOT != code or wrapper != os.path.realpath(wrapper)
            or wrapper != os.path.join(code, "agents", "role.py") or os.getcwd() != code):
        die("run запускается обёрткой основного клона code из этого клона")
    cwd = os.path.abspath(os.path.expanduser(directory))
    if cwd != os.path.realpath(cwd):
        die("--cd не допускает обход через симлинк")
    for clone in clones.values():
        branch = git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD")
        if not branch or cwd != os.path.join(clone + "-wt", branch):
            continue
        common = git(cwd, "rev-parse", "--git-common-dir")
        registered = git(clone, "worktree", "list", "--porcelain", "-z")
        top = git(cwd, "rev-parse", "--show-toplevel")
        if (common and os.path.realpath(os.path.join(cwd, common)) == os.path.realpath(os.path.join(clone, ".git"))
                and top and os.path.realpath(top) == cwd
                and registered and "worktree " + cwd in registered.split("\0")):
            return cwd
    die("--cd должен быть зарегистрированным ворктри docs или code в <клон>-wt/<ветка>")


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


def diff_output(cwd, *args, allowed=(0,)):
    result = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    return {"patch": result.stdout if result.returncode in allowed else None,
            "error": None if result.returncode in allowed else result.stderr}


def worktree_diff(cwd):
    """Снимок diff, включая неотслеживаемые файлы; тексты Git не обрезаются."""
    result = diff_output(cwd, "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--")
    listing = subprocess.run(["git", "-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"],
                             capture_output=True, text=True)
    untracked = listing.stdout if listing.returncode == 0 else None
    result["untracked"] = {}
    if untracked is None:
        result["untracked_error"] = "не получен список неотслеживаемых файлов"
    for path in (untracked or "").split("\0"):
        if path:
            result["untracked"][path] = diff_output(cwd, "diff", "--no-index", "--binary", "--no-ext-diff",
                                                    "--no-textconv", "--", os.devnull, path, allowed=(0, 1))
    return result


def rollouts():
    return set(glob.glob(os.path.join(CODEX_HOME, "sessions", "*", "*", "*", "rollout-*.jsonl")))


def read_session(f):
    """Файл сессии Codex: своя (первая) session_meta — у субагента дальше идёт и родительская, первый turn_context,
    токены, имена вызванных инструментов и есть ли коннекторы ChatGPT среди выданных инструментов."""
    s = {"rollout": f, "id": None, "cwd": None, "cli_version": None, "source": None, "subagent": False, "parent": None,
         "model": None, "effort": None, "sandbox": None, "tokens": None, "calls": [], "connectors": False}
    meta = turn = False
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                p = o.get("payload") if isinstance(o, dict) else None
                if not isinstance(p, dict):
                    continue
                if o.get("type") == "world_state" or p.get("role") == "developer":  # инструменты выдаёт сам Codex
                    s["connectors"] = s["connectors"] or "mcp__codex_apps" in line
                if o.get("type") == "session_meta" and not meta:
                    meta = True
                    src = p.get("source")
                    sub = src.get("subagent") if isinstance(src, dict) else None
                    spawn = sub.get("thread_spawn") if isinstance(sub, dict) else None
                    s.update(id=p.get("id"), cwd=p.get("cwd"), cli_version=p.get("cli_version"), source=src,
                             subagent=sub is not None or p.get("thread_source") == "subagent",
                             parent=spawn.get("parent_thread_id") if isinstance(spawn, dict) else None)
                elif o.get("type") == "turn_context" and not turn:
                    turn = True
                    s.update(model=p.get("model"), effort=p.get("effort"),
                             sandbox=(p.get("sandbox_policy") or {}).get("type"))
                elif p.get("type") == "token_count" and p.get("info"):
                    s["tokens"] = p["info"].get("total_token_usage")
                elif p.get("type") == "function_call":
                    s["calls"].append(p.get("name"))
    except OSError as e:  # файл удалён или недоступен — в журнал, а не падение до записи
        s["error"] = str(e)
    return s


def codex_context(new_files, cwd, root_id):
    """Фактические модель, effort, песочница — из корневой сессии запуска: по id из вывода codex exec, иначе единственная
    новая не-субагентская сессия с этой папкой. Потомки корня по parent_thread_id (и вложенные) — subagents: ADR-022 п. 9
    их запрещает, а флагами Codex 0.167 они не выключаются (каталог моделей сервера задаёт multi_agent_version v2).
    Прочие новые сессии (параллельные запуски, служебные потоки, вложенный codex exec) — other_sessions, без находки."""
    sessions = [read_session(f) for f in sorted(new_files)]
    brief = lambda s: {k: s[k] for k in ("rollout", "id", "cwd", "source", "parent", "model", "effort")}
    if root_id:
        roots = [s for s in sessions if s["id"] == root_id]
    else:
        roots = [s for s in sessions if not s["subagent"] and s["cwd"] == cwd]
    if len(roots) != 1:
        return {"model": None, "effort": None, "sandbox": None, "rollout": None, "tokens": None, "subagents": [],
                "other_sessions": [brief(s) for s in sessions],
                "error": f"корневых сессий Codex этого запуска: {len(roots)}"}
    mine, ids = [roots[0]], {roots[0]["id"]}
    grown = True
    while grown:
        grown = False
        for s in sessions:
            if s not in mine and s["parent"] in ids:
                mine.append(s)
                ids.add(s["id"])
                grown = True
    root = roots[0]
    return {"session_id": root["id"], "model": root["model"], "effort": root["effort"], "sandbox": root["sandbox"], "rollout": root["rollout"],
            "tokens": root["tokens"], "cli_version": root["cli_version"],
            "subagents": [brief(s) for s in mine[1:]], "other_sessions": [brief(s) for s in sessions if s not in mine],
            # только корень: файл потомка повторяет историю родителя; вложенные порождения видны по файлам потомков
            "spawn_calls": root["calls"].count("spawn_agent"),
            "mcp_calls": sorted({c for s in mine for c in s["calls"] if c and c.startswith("mcp__")}),
            "connectors": any(s["connectors"] for s in mine), "errors": [s["error"] for s in sessions if "error" in s]}


def run_codex(role, code, model, effort, sandbox, prompt, cwd, out):
    path = os.path.join(SNAP, f"{role['agent']}.md")
    if not os.path.exists(path):
        die(f"нет {os.path.relpath(path, ROOT)}: выполните build")
    di = open(path, encoding="utf-8").read() + "\n\n" + COMMON + f"\n\n## Оговорка роли {code}\n\n" + role["overlay"] + "\n"
    # --disable apps: без коннекторов учётки ChatGPT (ADR-022 п. 6); после запуска сверяется по файлу сессии.
    # --disable multi_agent в 0.167 субагентов v2 не выключает — их ловит codex_context.
    cmd = ["codex", "exec", "--disable", "multi_agent", "--disable", "apps", "-m", model, "-c", f'model_reasoning_effort="{effort}"',
           "-s", sandbox, "-c", "developer_instructions=" + json.dumps(di, ensure_ascii=False),
           "-C", cwd, "--skip-git-repo-check", "-o", out, "-"]
    before = rollouts()
    r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, env=role_env())
    m = re.search(r"^session id: ([0-9a-f-]{36})$", r.stderr, re.M)
    ctx = codex_context(rollouts() - before, cwd, m.group(1) if m else None)
    response = open(out, encoding="utf-8").read() if os.path.exists(out) else ""
    return r, ctx, response


def append(journal, rec):
    os.makedirs(os.path.dirname(os.path.abspath(journal)), exist_ok=True)
    with open(journal, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def cmd_run(a):
    cwd = run_worktree(a.cd)
    code = a.code
    role = dict(REG["roles"].get(code) or die(f"нет роли {code}"))
    me = user()
    if (REG["p1_started"] or role.get("phase") != "design") and me != REG["zone_user"]:
        die(f"роль {code} работает только в учётке `{REG['zone_user']}` (ADR-022 п. 6), сейчас `{me}`")
    model = REG["simple"]["codex"] if a.simple else role["model"]
    effort = a.effort or role["effort"]
    sandbox = a.sandbox or role["sandbox"]
    if role["sandbox"] == "read-only" and sandbox != "read-only":
        die(f"роль {code} работает только в песочнице read-only")
    if (effort != role["effort"] or sandbox != role["sandbox"]) and not a.reason:
        die("отступ от реестра — только с --reason")
    if REG["p1_started"] or role.get("phase") != "design":  # то же условие, что у проверки учётки
        session_check()
    prompt = open(a.prompt_file, encoding="utf-8").read()
    secrets = os.path.realpath(os.path.dirname(DEV_CONFIG))
    if os.path.realpath(cwd) == secrets or secrets.startswith(os.path.realpath(cwd) + os.sep) \
            or os.path.realpath(cwd).startswith(secrets + os.sep):
        die("рабочая папка роли содержит каталог токена (ADR-024 Б.6)")
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.journal)), f"last-{code}.md")
    for p in (a.journal, out):  # иначе запись журнала выглядела бы как правка проверяющей роли
        if any(os.path.realpath(p).startswith(os.path.realpath(d) + os.sep) for d in (cwd, ROOT)):
            die("журнал и ответ — вне репозитория и папки задачи (ADR-022 п. 7)")
    before = {"task": fingerprint(cwd), "root": fingerprint(ROOT)}
    before_diff = worktree_diff(cwd)
    started = now()
    r, ctx, response = run_codex(role, code, model, effort, sandbox, prompt, cwd, out)
    after = {"task": fingerprint(cwd), "root": fingerprint(ROOT)}
    after_diff = worktree_diff(cwd)
    finished = now()
    changed = None
    bh, ah = before["task"]["head"], after["task"]["head"]
    if bh and ah and bh != ah:
        changed = (git(cwd, "diff", "--name-only", f"{bh}..{ah}") or "").splitlines()
    committed = diff_output(cwd, "diff", "--binary", "--no-ext-diff", "--no-textconv", bh, ah, "--") if bh and ah else None
    touched = before != after
    findings = []
    if ctx.get("subagents") or ctx.get("spawn_calls"):
        findings.append(f"роль породила субагентов: сессий {len(ctx.get('subagents') or [])}, "
                        f"вызовов spawn_agent {ctx.get('spawn_calls', 0)} (ADR-022 п. 9)")
    if ctx.get("connectors") or ctx.get("mcp_calls"):
        findings.append(f"в сессии роли коннекторы ChatGPT или MCP: {ctx.get('mcp_calls') or 'выданы'} (ADR-022 п. 6)")
    if role.get("review") and touched:
        findings.append("проверяющая роль изменила рабочую папку (ADR-022 п. 7)")
    if ctx.get("rollout") and sandbox == "read-only" and ctx.get("sandbox") != "read-only":
        findings.append("сессия роли не подтвердила песочницу read-only (ADR-026)")
    unavailable = (r.returncode != 0 and ctx.get("model") is None
                   and not ctx.get("rollout") and not ctx.get("tokens")
                   and not ctx.get("subagents") and not ctx.get("other_sessions"))
    if ctx.get("error") and not unavailable:
        findings.append(f"{ctx['error']} — проверка субагентов и коннекторов не проведена (ADR-022 п. 7)")
    mismatch = ctx.get("model") != model or ctx.get("effort") != effort
    # находка и чужая модель важнее кода выхода роли: иначе их можно принять за «поставщик недоступен»
    wrapper_exit = 3 if findings or (mismatch and not unavailable) else r.returncode
    append(a.journal, {
        "ts": started, "finished_at": finished, "kind": "call", "role": code, "side": "codex", "agent": role["agent"], "user": me,
        "requested": {"model": model, "effort": effort, "sandbox": sandbox}, "actual": ctx,
        "reason": a.reason, "cwd": cwd, "before": before, "after": after, "changed_files": changed,
        "diff": {"before": before_diff, "after": after_diff, "committed": committed},
        "reviewer_touched_files": touched if role.get("review") else None, "findings": findings,
        "unavailable": unavailable, "exit": r.returncode, "wrapper_exit": wrapper_exit, "prompt": prompt, "response": response,
    })
    print(f"роль {code} (codex): {ctx.get('model')} / {ctx.get('effort')}; exit {r.returncode}; ответ — {out}")
    if mismatch:
        print(f"ВНИМАНИЕ: запрошено {model}/{effort}, фактически {ctx.get('model')}/{ctx.get('effort')} "
              f"{ctx.get('error', '')}", file=sys.stderr)
    for f in findings:
        print(f"ВНИМАНИЕ: {f} — это находка", file=sys.stderr)
    if r.returncode != 0:
        print(r.stderr[-2000:], file=sys.stderr)
    sys.exit(wrapper_exit)


def cmd_state(a):
    print(json.dumps(fingerprint(os.path.abspath(a.cd))))


def cmd_log(a):
    text = a.text if a.text is not None else open(a.text_file, encoding="utf-8").read()
    append(a.journal, {"ts": now(), "kind": a.kind, "role": a.role, "user": user(), "text": text})
    print("записано")


def literal(text):
    """Блок без изменений текста, в том числе при наличии Markdown-ограждений в источнике."""
    fence = "`" * max(3, 1 + max((len(m.group()) for m in re.finditer(r"`+", text)), default=0))
    return fence + "\n" + text + ("" if text.endswith("\n") else "\n") + fence + "\n"


def journal_files(directory, gaps):
    files = []
    def inaccessible(exc):
        gaps.append(f"каталог источников не прочитан: {exc}")
    for parent, dirs, names in os.walk(directory, onerror=inaccessible):
        for name in sorted(dirs + names):
            path = Path(parent) / name
            if path.is_symlink():
                die(f"источник через симлинк недопустим: {path.relative_to(directory)}")
        files.extend(Path(parent) / name for name in sorted(names))
    return sorted(files)


def escalation_package(directory, task):
    """Собрать текст в памяти до любой записи. Первичные файлы не меняются."""
    sources, gaps = {}, []
    paths = journal_files(directory, gaps)
    for path in paths:
        try:
            # newline='' сохраняет CRLF первоисточника.
            with path.open(encoding="utf-8", newline="") as fh:
                if os.fstat(fh.fileno()).st_nlink > 1:
                    die(f"источник с жёсткими ссылками недопустим: {path.relative_to(directory)}")
                sources[path.relative_to(directory).as_posix()] = fh.read()
        except (OSError, UnicodeError) as exc:
            gaps.append(f"{path.relative_to(directory)}: источник не прочитан: {exc}")
    manifest = {}
    if "sources.json" in sources:
        try:
            manifest = json.loads(sources["sources.json"])
            if not isinstance(manifest, dict):
                raise ValueError("ожидается объект")
        except ValueError as exc:
            gaps.append(f"sources.json повреждён: {exc}; используются стандартные имена")
            manifest = {}
    marker = re.match(r"^t(\d+)(?:-|$)", directory.name)
    if marker and int(marker[1]) != task:
        die("номер задачи не совпадает с папкой журнала")
    if "task_number" in manifest and (type(manifest["task_number"]) is not int or manifest["task_number"] != task):
        die("sources.json относится к другой задаче или содержит неверный task_number")
    if not marker and "task_number" not in manifest:
        gaps.append("принадлежность папки задаче не подтверждена именем или task_number; старые записи без номера")

    def source(key, default):
        name = manifest.get(key, default)
        if not isinstance(name, str) or not name:
            gaps.append(f"sources.json: неверный путь {key}")
            return None
        path = directory / name
        if Path(name).is_absolute() or ".." in Path(name).parts:
            die(f"источник {key} должен быть относительным путём внутри журнала")
        if not path.resolve().is_relative_to(directory):
            die(f"источник {key} выходит из журнала")
        return path.relative_to(directory).as_posix()

    task_source = source("task", "task.txt")
    plan_source = source("plan", "plan.md")
    change_source = source("change", "change")
    problem_source = source("problem", "problem.md")
    if task_source not in sources:
        gaps.append("нет снимка задачи: " + str(task_source))
    else:
        heading = re.search(r"^\s*(?:\#{1,6}\s*)?(?:задача\s*:?\s*\#?|task\s*:?\s*\#?|\#)(\d+)\b",
                            sources[task_source], re.I | re.M)
        if heading and int(heading[1]) != task:
            die("снимок задачи относится к другой задаче")
    change_files = [name for name in sources if change_source and name.startswith(change_source.rstrip("/") + "/")]
    if plan_source not in sources and not change_files:
        gaps.append("нет плана или полного каталога изменения")
    if problem_source not in sources:
        gaps.append("нет файла текущей проблемы — взгляд O: " + str(problem_source))
    for key, name in (("task", task_source), ("plan", plan_source), ("problem", problem_source), ("change", change_source)):
        if key in manifest and name not in sources and not (key == "change" and change_files):
            gaps.append(f"источник из sources.json отсутствует: {key} = {name}")
    records = []
    kinds = set()
    for name, text in sources.items():
        if not name.endswith(".jsonl"):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            origin = f"{name}:{number}"
            try:
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError("ожидается объект")
            except ValueError as exc:
                gaps.append(f"{origin}: повреждён JSONL: {exc}")
                continue
            for key in ("task", "task_number"):
                if key in record and str(record[key]) != str(task):
                    die(f"{origin}: запись относится к другой задаче")
            kind = record.get("kind")
            if isinstance(kind, str):
                kinds.add(kind)
            required = ["ts", "kind", "role"]
            if kind == "call":
                required += ["requested", "actual", "prompt", "before", "after", "diff", "response",
                             "finished_at", "findings", "exit", "wrapper_exit"]
                for key in ("requested", "actual"):
                    value = record.get(key)
                    if not isinstance(value, dict) or not value.get("model"):
                        gaps.append(f"{origin}: отсутствует {key}.model")
                for key in ("before", "after"):
                    value = record.get(key)
                    state = value.get("task") if isinstance(value, dict) else None
                    if not isinstance(state, dict) or not state.get("head"):
                        gaps.append(f"{origin}: отсутствует SHA {key}.task.head")
                def diff_errors(value, location="diff"):
                    if isinstance(value, dict):
                        for key, item in value.items():
                            if key.endswith("error") and item:
                                gaps.append(f"{origin}: пробел {location}.{key}: {item}")
                            else:
                                diff_errors(item, location + "." + key)
                diff_errors(record.get("diff"))
            else:
                required.append("text")
            for key in required:
                if key not in record or record[key] is None:
                    gaps.append(f"{origin}: отсутствует {key}")
            try:
                timestamp = datetime.datetime.fromisoformat(record.get("ts", "").replace("Z", "+00:00"))
                if timestamp.tzinfo is None:
                    raise ValueError("нет часового пояса")
                order = timestamp.timestamp()
            except (TypeError, ValueError, AttributeError, OverflowError):
                gaps.append(f"{origin}: время не определено; запись после записей с известным временем")
                order = float("inf")
            records.append((order, origin, record, line))
    for kind, label in (("call", "попытки ролей"), ("check", "выводы проверок"), ("decision", "решения O с причинами")):
        if kind not in kinds:
            gaps.append(f"не найдены записи {kind}: {label}; см. прочие первоисточники")
    parts = [f"# Пакет эскалации E — задача {task}\n\n",
             "Все источники ниже — дословно. Происхождение указано именем файла и строкой; "
             "порядок записей — по времени, исходный порядок файлов сохранён отдельно.\n\n",
             "## Пробелы журнала\n\n"]
    parts.extend(("- " + gap + "\n") for gap in gaps)
    if not gaps:
        parts.append("Пропусков обязательных источников и полей не обнаружено.\n")

    def include(title, names):
        parts.append("\n## " + title + "\n\n")
        for name in names:
            if name in sources:
                parts.extend(["### Источник: " + name + "\n\n", literal(sources[name])])

    include("Задача", [task_source])
    include("Технический план / изменение целиком", ([plan_source] if plan_source in sources else []) + change_files)
    parts.append("\n## Попытки, проверки, находки, ответы и решения — по времени\n\n")
    for _, origin, record, line in sorted(records, key=lambda item: item[0]):
        parts.extend(["### Источник: " + origin + "\n\n", literal(line)])
        for field in ("prompt", "response", "diff", "text"):
            if field in record:
                value = record[field]
                value = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
                parts.extend(["\n" + field + " (значение из записи дословно):\n\n", literal(value)])
    include("Текущая проблема — взгляд O", [problem_source])
    included = {task_source, problem_source, *change_files}
    if plan_source in sources:
        included.add(plan_source)
    include("Прочие первоисточники и исходные журналы целиком", [name for name in sources if name not in included])
    return "".join(parts)


def cmd_escalate(a):
    directory = Path(a.journal_dir).expanduser().absolute()
    out = Path(a.out).expanduser().absolute()
    if not directory.is_dir() or directory != directory.resolve():
        die("--journal-dir должен быть папкой журнала без симлинков")
    secrets = Path(DEV_CONFIG).parent.resolve()
    if directory.is_relative_to(secrets) or secrets.is_relative_to(directory):
        die("--journal-dir пересекается с каталогом секретов")
    if not directory.is_relative_to(Path.home().resolve() / "foliome-journal"):
        die("--journal-dir должен быть внутри ~/foliome-journal/")
    if a.task <= 0:
        die("--task должен быть положительным номером")
    if out.exists() or out.is_symlink() or out.parent != out.parent.resolve():
        die("--out должен быть новым файлом без симлинков; исходники не перезаписываются")
    package = escalation_package(directory, a.task)
    temporary = None
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="", dir=out.parent, delete=False) as fh:
            temporary = fh.name
            fh.write(package)
            fh.flush()
            os.fsync(fh.fileno())
        # Атомарная публикация без перезаписи, даже если out появился после проверки.
        os.link(temporary, out)
    except OSError as exc:
        die(f"пакет не записан: {exc}")
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    print(f"пакет E: {out}")


def cmd_list(_):
    for code, r in REG["roles"].items():
        print(f"{code:3} {r['side']:6} {r['agent']:36} {r['model']:16} {r['effort']:6} {r['when']}")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest="cmd", required=True)
    sp.add_parser("list").set_defaults(f=cmd_list)
    sp.add_parser("build").set_defaults(f=cmd_build)
    r = sp.add_parser("run"); r.add_argument("code"); r.add_argument("--prompt-file", required=True)
    r.add_argument("--journal", required=True); r.add_argument("--cd", required=True); r.add_argument("--simple", action="store_true")
    r.add_argument("--effort", choices=["low", "medium", "high"])
    r.add_argument("--sandbox", choices=["read-only", "workspace-write", "danger-full-access"])
    r.add_argument("--reason"); r.add_argument("--out")
    r.set_defaults(f=cmd_run)
    st = sp.add_parser("state"); st.add_argument("--cd", default=ROOT); st.set_defaults(f=cmd_state)
    lg = sp.add_parser("log"); lg.add_argument("--journal", required=True)
    lg.add_argument("--kind", required=True, choices=["decision", "check", "note"])
    lg.add_argument("--role", required=True); g = lg.add_mutually_exclusive_group(required=True)
    g.add_argument("--text"); g.add_argument("--text-file"); lg.set_defaults(f=cmd_log)
    es = sp.add_parser("escalate")
    es.add_argument("--journal-dir", required=True); es.add_argument("--task", required=True, type=int)
    es.add_argument("--out", required=True); es.set_defaults(f=cmd_escalate)
    args = p.parse_args(argv)
    return args.f(args)


if __name__ == "__main__":
    main()

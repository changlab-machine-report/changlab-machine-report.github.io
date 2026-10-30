#!/usr/bin/env python3
"""Weekly usage reports for the Chang Lab GPU machines.

  sample              record the lab accounts' GPU, CPU and RAM use once a minute (systemd service)
  report [--week W]   print one week's summary as JSON, without publishing it
  publish [--week W]  summarize a week and push it to the report site (weekly systemd timer)

W is "last" (the most recent full week, the default), "current" (the week so far),
or any date inside the week. Weeks run Monday to Sunday in the machine's time zone.
Only the accounts listed in the config are recorded; everyone else is ignored.
"""

import argparse
import datetime as dt
import json
import os
import pwd
import random
import subprocess
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

CONFIG_PATH = Path(os.environ.get("CHANGLAB_REPORT_CONFIG", "/etc/changlab-report/config.json"))
DEFAULTS = {
    "interval": 60,
    "timezone": "America/Los_Angeles",
    "state_dir": "/var/lib/changlab-report",
    "branch": "main",
    "home_fs": "/",
    "hdd1": "/hdd1",
    "shared_dir": "/hdd1/data",
    "keep_weeks": 12,
    "deploy_key": "/etc/changlab-report/deploy_key",
    "known_hosts": "/etc/changlab-report/known_hosts",
}
IDLE_UTIL = 5  # a GPU held below this utilization (%) counts as idle
KIB_PER_GIB = 1024 ** 2


def load_config():
    cfg = dict(DEFAULTS)
    cfg.update(json.loads(CONFIG_PATH.read_text()))
    cfg["tz"] = ZoneInfo(cfg["timezone"])
    cfg["state"] = Path(cfg["state_dir"])
    return cfg


def tracked_accounts(cfg):
    """uid -> name for the configured accounts that exist on this machine."""
    accounts = {}
    for name in cfg["users"]:
        try:
            accounts[pwd.getpwnam(name).pw_uid] = name
        except KeyError:
            pass
    return accounts


def run(cmd, timeout=120):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=True).stdout


def nvidia_query(kind, fields):
    out = run(["nvidia-smi", f"--query-{kind}={fields}", "--format=csv,noheader,nounits"], timeout=30)
    return [[f.strip() for f in line.split(",")] for line in out.splitlines() if line.strip()]


def number(text):
    try:
        return float(text)
    except ValueError:  # "[N/A]", "[Not Supported]"
        return None


def process_uid(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("Uid:"):
                    return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return None


def cgroup_value(path, key):
    with open(path) as f:
        for line in f:
            k, _, v = line.partition(" ")
            if k == key:
                return int(v)
    return None


# ---------------------------------------------------------------- sampling

def take_sample(accounts):
    """One observation: which lab accounts hold which GPU, plus their CPU time and RAM."""
    sample = {"t": int(time.time())}
    try:
        gpus = nvidia_query("gpu", "index,uuid,utilization.gpu,memory.used")
        apps = nvidia_query("compute-apps", "pid,gpu_uuid,used_memory")
        index_of = {g[1]: int(g[0]) for g in gpus}
        held = {}  # (gpu index, user) -> MiB
        for app in apps:
            if len(app) != 3:
                continue
            pid, uuid, mem = app
            name = accounts.get(process_uid(pid))
            if name and uuid in index_of:
                key = (index_of[uuid], name)
                held[key] = held.get(key, 0) + (number(mem) or 0)
        busy = {i for i, _ in held}
        # GPU-level numbers only for GPUs a lab account is using, so nobody else is recorded
        sample["gpus"] = [{"i": int(g[0]), "util": number(g[2]), "mem": number(g[3])}
                          for g in gpus if int(g[0]) in busy]
        sample["procs"] = [{"i": i, "u": u, "mem": m} for (i, u), m in sorted(held.items())]
    except (OSError, ValueError, subprocess.SubprocessError) as err:
        sample["gpu_error"] = str(err)[:200]
    cpu, ram = {}, {}
    for uid, name in accounts.items():
        slice_dir = f"/sys/fs/cgroup/user.slice/user-{uid}.slice"
        try:
            cpu[name] = cgroup_value(f"{slice_dir}/cpu.stat", "usage_usec")
            ram[name] = cgroup_value(f"{slice_dir}/memory.stat", "anon")
        except OSError:
            pass  # no processes right now, so no slice
    sample["cpu"] = {k: v for k, v in cpu.items() if v is not None}
    sample["ram"] = {k: v for k, v in ram.items() if v is not None}
    return sample


def run_sampler(cfg, once=False):
    samples = cfg["state"] / "samples"
    samples.mkdir(parents=True, exist_ok=True)
    interval = cfg["interval"]
    while True:
        sample = take_sample(tracked_accounts(cfg))
        if once:
            print(json.dumps(sample))
            return
        day = dt.datetime.fromtimestamp(sample["t"], cfg["tz"]).date()
        with open(samples / f"{day}.jsonl", "a") as f:
            f.write(json.dumps(sample, separators=(",", ":")) + "\n")
        time.sleep(interval - time.time() % interval)


# ---------------------------------------------------------------- weekly summary

def monday_of(cfg, which):
    today = dt.datetime.now(cfg["tz"]).date()
    if which == "current":
        day = today
    elif which == "last":
        day = today - dt.timedelta(days=7)
    else:
        day = dt.date.fromisoformat(which)
    return day - dt.timedelta(days=day.weekday())


def read_samples(cfg, start, end):
    samples, day = [], start.date() - dt.timedelta(days=1)
    while day <= end.date():
        path = cfg["state"] / "samples" / f"{day}.jsonl"
        if path.exists():
            for line in path.read_text().splitlines():
                try:
                    samples.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # a line cut short by a crash
        day += dt.timedelta(days=1)
    return sorted(samples, key=lambda s: s["t"])


def repquota(args, fs):
    """{'#id': (used KiB, hard limit KiB)} from repquota; empty if quotas are unavailable."""
    try:
        out = run(["repquota", *args, fs])
    except (OSError, subprocess.SubprocessError):
        return {}
    usage = {}
    for line in out.splitlines():
        f = line.split()
        if len(f) >= 5 and f[0].startswith("#") and f[1] in ("--", "+-", "-+", "++") and f[2].isdigit():
            usage[f[0]] = (int(f[2]), int(f[4]))
    return usage


def project_id(path):
    try:
        return int(run(["lsattr", "-pd", path]).split()[0])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def gib(kib):
    return None if kib is None else round(kib / KIB_PER_GIB, 1)


def storage(cfg, users):
    """Disk use right now: each account's home quota and /hdd1 folder, plus the shared folder."""
    home = repquota(["-un"], cfg["home_fs"])
    projects = repquota(["-Pn"], cfg["hdd1"])
    per_user = {}
    for name in users:
        used, limit = home.get(f"#{pwd.getpwnam(name).pw_uid}", (None, None))
        pid = project_id(os.path.join(cfg["hdd1"], name))
        p_used, p_limit = projects.get(f"#{pid}", (None, None)) if pid else (None, None)
        per_user[name] = {"home_used_gb": gib(used), "home_limit_gb": gib(limit or None),
                          "hdd1_used_gb": gib(p_used), "hdd1_limit_gb": gib(p_limit or None)}
    pid = project_id(cfg["shared_dir"])
    used, limit = projects.get(f"#{pid}", (None, None)) if pid else (None, None)
    return per_user, {"path": cfg["shared_dir"], "used_gb": gib(used), "limit_gb": gib(limit or None)}


def summarize(cfg, monday):
    tz, interval = cfg["tz"], cfg["interval"]
    start = dt.datetime.combine(monday, dt.time(), tz)
    end = dt.datetime.combine(monday + dt.timedelta(days=7), dt.time(), tz)
    now = dt.datetime.now(tz)
    users = [u for u in cfg["users"] if u in tracked_accounts(cfg).values()]
    everything = read_samples(cfg, start, end)
    week = [s for s in everything if start.timestamp() <= s["t"] < end.timestamp()]
    earlier = [s for s in everything if s["t"] < start.timestamp()]

    try:
        inventory = nvidia_query("gpu", "index,name")
    except (OSError, ValueError, subprocess.SubprocessError):
        inventory = []
    seen = [p["i"] for s in week for p in s.get("procs", [])]
    n_gpu = max([len(inventory)] + [i + 1 for i in seen])

    gpu_s = {u: [0.0] * n_gpu for u in users}
    util_sum, util_s, idle_s, peak_mem = ({u: 0.0 for u in users} for _ in range(4))
    gpu_used_s, gpu_util_sum, gpu_util_s = ([0.0] * n_gpu for _ in range(3))
    days = [(monday + dt.timedelta(days=d)).isoformat() for d in range(7)]
    day_s = {d: {u: 0.0 for u in users} for d in days}
    cpu_us, ram_sum, ram_peak = ({u: 0 for u in users} for _ in range(3))
    prev = earlier[-1] if earlier else None

    for s in week:
        day = dt.datetime.fromtimestamp(s["t"], tz).date().isoformat()
        util = {g["i"]: g["util"] for g in s.get("gpus", [])}
        holders = {}
        for p in s.get("procs", []):
            holders.setdefault(p["i"], {})[p["u"]] = p.get("mem") or 0
        for i, held in holders.items():
            pct = util.get(i)
            gpu_used_s[i] += interval
            if pct is not None:
                gpu_util_sum[i] += pct * interval
                gpu_util_s[i] += interval
            share = interval / len(held)  # two people on one GPU split its time
            for u, mem in held.items():
                if u not in gpu_s:
                    continue
                gpu_s[u][i] += share
                day_s[day][u] += share
                peak_mem[u] = max(peak_mem[u], mem)
                if pct is not None:
                    util_sum[u] += pct * share
                    util_s[u] += share
                    if pct < IDLE_UTIL:
                        idle_s[u] += share
        # CPU time is a running counter per user; count what was used since the previous sample
        fresh = prev is not None and s["t"] - prev["t"] <= 3 * interval
        for u in users:
            now_cpu = s.get("cpu", {}).get(u)
            if now_cpu is not None and fresh:
                was = prev.get("cpu", {}).get(u)
                cpu_us[u] += now_cpu - was if was is not None and now_cpu >= was else now_cpu
            ram = s.get("ram", {}).get(u) or 0
            ram_sum[u] += ram
            ram_peak[u] = max(ram_peak[u], ram)
        prev = s

    disk, shared = storage(cfg, users)
    n = max(len(week), 1)
    hours = lambda seconds: round(seconds / 3600, 2)
    # Timestamps, not datetime subtraction: same-zone datetimes subtract as wall-clock time,
    # which drops the extra hour of the week daylight saving time ends.
    t0, t1, t_now = start.timestamp(), end.timestamp(), now.timestamp()
    report = {
        "schema": 1,
        "machine": cfg["machine"],
        "week_start": monday.isoformat(),
        "week_end": (monday + dt.timedelta(days=6)).isoformat(),
        "generated_at": now.isoformat(timespec="seconds"),
        "complete": t_now >= t1,
        "hours": hours(t1 - t0),
        "elapsed_hours": hours(max(0, min(t_now, t1) - t0)),
        "recorded_hours": hours(len(week) * interval),
        "gpu_count": n_gpu,
        "gpu_name": inventory[0][1] if inventory else None,
        "gpus": [{"index": i, "used_hours": hours(gpu_used_s[i]),
                  "avg_util": round(gpu_util_sum[i] / gpu_util_s[i], 1) if gpu_util_s[i] else None}
                 for i in range(n_gpu)],
        "users": [],
        "days": [{"date": d, "gpu_hours": {u: hours(day_s[d][u]) for u in users}} for d in days],
        "shared": shared,
    }
    for u in users:
        report["users"].append({
            "user": u,
            "gpu_hours": hours(sum(gpu_s[u])),
            "gpu_hours_by_gpu": [hours(x) for x in gpu_s[u]],
            "avg_util": round(util_sum[u] / util_s[u], 1) if util_s[u] else None,
            "idle_gpu_hours": hours(idle_s[u]),
            "peak_gpu_mem_gb": round(peak_mem[u] / 1024, 1),
            "cpu_core_hours": round(cpu_us[u] / 3.6e9, 2),
            "avg_ram_gb": round(ram_sum[u] / n / 1024 ** 3, 1),
            "peak_ram_gb": round(ram_peak[u] / 1024 ** 3, 1),
            **disk[u],
        })
    return report


# ---------------------------------------------------------------- publishing

def git(cfg, *args, cwd=None):
    ssh = (f"ssh -i {cfg['deploy_key']} -o IdentitiesOnly=yes -o BatchMode=yes "
           f"-o StrictHostKeyChecking=yes -o UserKnownHostsFile={cfg['known_hosts']}")
    env = dict(os.environ, GIT_SSH_COMMAND=ssh)
    return subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True,
                          timeout=300, check=True).stdout


def write_json(path, obj):
    path.write_text(json.dumps(obj, indent=1) + "\n")


def build_index(cfg, folder):
    weeks = []
    for path in sorted(folder.glob("????-??-??.json"), reverse=True):
        r = json.loads(path.read_text())
        weeks.append({"week_start": r["week_start"], "complete": r["complete"], "hours": r["hours"],
                      "elapsed_hours": r["elapsed_hours"], "recorded_hours": r["recorded_hours"],
                      "gpu_count": r["gpu_count"],
                      "gpu_hours": {u["user"]: u["gpu_hours"] for u in r["users"]}})
    return {"machine": cfg["machine"],
            "updated_at": dt.datetime.now(cfg["tz"]).isoformat(timespec="seconds"),
            "weeks": weeks}


def prune(cfg):
    cutoff = dt.datetime.now(cfg["tz"]).date() - dt.timedelta(weeks=cfg["keep_weeks"])
    for path in (cfg["state"] / "samples").glob("*.jsonl"):
        try:
            if dt.date.fromisoformat(path.stem) < cutoff:
                path.unlink()
        except ValueError:
            pass


def publish(cfg, monday):
    report = summarize(cfg, monday)
    site = cfg["state"] / "site"
    if not (site / ".git").exists():
        git(cfg, "clone", "--quiet", "--branch", cfg["branch"], cfg["repo"], str(site))
    folder = Path("data") / cfg["machine"]
    message = f"{cfg['machine']}: usage for the week of {report['week_start']}"
    if not report["complete"]:
        message += " (so far)"
    error = None
    for _ in range(6):  # the other machine may push at the same moment; rebase and retry
        git(cfg, "fetch", "--quiet", "origin", cfg["branch"], cwd=site)
        git(cfg, "reset", "--quiet", "--hard", f"origin/{cfg['branch']}", cwd=site)
        (site / folder).mkdir(parents=True, exist_ok=True)
        write_json(site / folder / f"{report['week_start']}.json", report)
        write_json(site / folder / "index.json", build_index(cfg, site / folder))
        git(cfg, "add", str(folder), cwd=site)
        if not git(cfg, "status", "--porcelain", cwd=site).strip():
            print("nothing new to publish")
            break
        git(cfg, "-c", f"user.name={cfg['machine']} report", "-c", "user.email=changlab-report@localhost",
            "commit", "--quiet", "-m", message, cwd=site)
        try:
            git(cfg, "push", "--quiet", "origin", f"HEAD:{cfg['branch']}", cwd=site)
            print(f"published {folder}/{report['week_start']}.json")
            break
        except subprocess.CalledProcessError as err:
            error = err
            time.sleep(random.uniform(5, 30))
    else:
        raise error
    prune(cfg)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sample = sub.add_parser("sample", help="record usage once a minute")
    sample.add_argument("--once", action="store_true", help="take one sample, print it and exit")
    for name in ("report", "publish"):
        p = sub.add_parser(name)
        p.add_argument("--week", default="last", help='"last" (default), "current", or a date in the week')
    args = parser.parse_args()
    cfg = load_config()
    try:
        if args.command == "sample":
            run_sampler(cfg, once=args.once)
        elif args.command == "report":
            print(json.dumps(summarize(cfg, monday_of(cfg, args.week)), indent=1))
        else:
            publish(cfg, monday_of(cfg, args.week))
    except subprocess.CalledProcessError as err:
        sys.exit(f"{' '.join(err.cmd)} failed: {(err.stderr or '').strip()}")


if __name__ == "__main__":
    main()

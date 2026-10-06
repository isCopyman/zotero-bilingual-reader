"""Blind quality rating for `zbr bench` output.

  python tools/bench-blind.py sample <bench dir> [n]   -> <dir>/blind.md (to rate) and <dir>/blind-key.json
  python tools/bench-blind.py score  <bench dir>       -> reads <dir>/blind-scores.json, writes <dir>/quality.csv

blind.md lists each sampled sentence with every engine's translation under shuffled letters.
The rater fills blind-scores.json as {"<sentence id>": {"A": 4, "B": 5, ...}} with 1-5 per candidate:
5 accurate and natural, terms right; 4 small wording issue; 3 one real error or awkward;
2 meaning partly wrong or missing; 1 wrong or untranslated.
"""

import csv
import json
import random
import sys
from pathlib import Path


def load(dir: Path):
    runs = {}
    for f in sorted(dir.glob("*.json")):
        if f.name.startswith("blind"):
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        if "translations" in d:
            runs[d["spec"]] = d
    return runs


def sample(dir: Path, n: int):
    runs = load(dir)
    specs = list(runs)
    ids = list(next(iter(runs.values()))["translations"])
    rng = random.Random(20261005)
    picked = sorted(rng.sample(ids, min(n, len(ids))), key=ids.index)
    key, lines = {}, ["# 盲评：每句给每个候选打 1-5 分，写进 blind-scores.json\n"]
    for sid in picked:
        order = specs[:]
        rng.shuffle(order)
        letters = [chr(65 + i) for i in range(len(order))]
        key[sid] = dict(zip(letters, order))
        lines.append(f"## {sid}\n\nEN: {runs[order[0]]['translations'][sid]['en']}\n")
        for letter, spec in zip(letters, order):
            lines.append(f"- {letter}: {runs[spec]['translations'][sid]['zh'] or '（无译文）'}")
        lines.append("")
    (dir / "blind.md").write_text("\n".join(lines), encoding="utf-8")
    (dir / "blind-key.json").write_text(json.dumps(key, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(picked)} sentences x {len(specs)} engines -> {dir / 'blind.md'}")


def score(dir: Path):
    key = json.loads((dir / "blind-key.json").read_text(encoding="utf-8"))
    scores = json.loads((dir / "blind-scores.json").read_text(encoding="utf-8"))
    per = {}
    for sid, marks in scores.items():
        for letter, s in marks.items():
            per.setdefault(key[sid][letter], []).append(s)
    with open(dir / "quality.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["engine", "rated", "mean", "share_5", "share_le3"])
        for spec, xs in sorted(per.items(), key=lambda kv: -sum(kv[1]) / len(kv[1])):
            row = [spec, len(xs), f"{sum(xs) / len(xs):.2f}", f"{xs.count(5) / len(xs):.0%}", f"{sum(x <= 3 for x in xs) / len(xs):.0%}"]
            w.writerow(row)
            print(",".join(map(str, row)))


if __name__ == "__main__":
    cmd, d = sys.argv[1], Path(sys.argv[2])
    if cmd == "sample":
        sample(d, int(sys.argv[3]) if len(sys.argv) > 3 else 30)
    else:
        score(d)

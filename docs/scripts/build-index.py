#!/usr/bin/env python3
"""
Scan all agent .md files across divisions and produce docs/data/agents.json.
Run this whenever agents are added, removed, or renamed.

Usage:
    python3 docs/scripts/build-index.py
"""
import os, re, json, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DIVISIONS = {
    "engineering": "Engineering",
    "design": "Design",
    "marketing": "Marketing",
    "product": "Product",
    "project-management": "Project Management",
    "testing": "Testing",
    "support": "Support",
    "spatial-computing": "Spatial Computing",
    "specialized": "Specialized",
    "academic": "Academic",
    "finance": "Finance",
    "game-development": "Game Development",
    "sales": "Sales",
    "paid-media": "Paid Media",
}

DIVISION_EMOJI = {
    "Engineering": "💻", "Design": "🎨", "Marketing": "📢", "Product": "📊",
    "Project Management": "🎬", "Testing": "🧪", "Support": "🛟",
    "Spatial Computing": "🥽", "Specialized": "🎯", "Academic": "📚",
    "Finance": "💵", "Game Development": "🎮", "Sales": "💼", "Paid Media": "💰"
}


def parse_frontmatter(text):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not m:
        return None
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip().strip('"').strip("'")
    return fm


def main():
    agents = []
    for div_dir, div_name in DIVISIONS.items():
        full = os.path.join(ROOT, div_dir)
        if not os.path.isdir(full):
            continue
        for dirpath, _, files in os.walk(full):
            for fn in files:
                if not fn.endswith(".md"):
                    continue
                path = os.path.join(dirpath, fn)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        text = f.read()
                except Exception:
                    continue
                fm = parse_frontmatter(text)
                if not fm or "name" not in fm:
                    continue
                rel = os.path.relpath(path, ROOT).replace("\\", "/")
                slug = os.path.splitext(fn)[0]
                agents.append({
                    "slug": slug,
                    "name": fm.get("name", slug),
                    "description": fm.get("description", ""),
                    "emoji": fm.get("emoji", DIVISION_EMOJI.get(div_name, "🤖")),
                    "color": fm.get("color", "blue"),
                    "vibe": fm.get("vibe", ""),
                    "division": div_name,
                    "divisionEmoji": DIVISION_EMOJI.get(div_name, "🤖"),
                    "path": rel,
                })

    agents.sort(key=lambda a: (a["division"], a["name"]))
    divisions = sorted({a["division"] for a in agents})
    out = {
        "generatedAt": datetime.date.today().isoformat(),
        "totalAgents": len(agents),
        "divisions": divisions,
        "agents": agents,
    }
    out_path = os.path.join(ROOT, "docs", "data", "agents.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"Indexed {len(agents)} agents across {len(divisions)} divisions → {out_path}")


if __name__ == "__main__":
    main()

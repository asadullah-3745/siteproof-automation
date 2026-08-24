"""Wire master Execute nodes to real child workflow IDs and activate master."""
import json
import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[1] / "n8n_data" / "database.sqlite"

CHILD_BY_NAME = {
    "02 - Report generation": None,
    "03 - Issue routing": None,
    "04 - Critical alert": None,
    "05 - System update": None,
}

MASTER_NAME = "01 - Job-close listener (master)"

EXEC_MAP = {
    "Execute WF2 Report generation": "02 - Report generation",
    "Execute WF3 Issue routing": "03 - Issue routing",
    "Execute WF4 Critical alert": "04 - Critical alert",
    "Execute WF5 System update": "05 - System update",
}


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, name, active, nodes FROM workflow_entity").fetchall()

    # Prefer active children; else newest by name
    for r in rows:
        if r["name"] in CHILD_BY_NAME:
            if CHILD_BY_NAME[r["name"]] is None or r["active"]:
                CHILD_BY_NAME[r["name"]] = r["id"]

    print("Children:", CHILD_BY_NAME)
    missing = [k for k, v in CHILD_BY_NAME.items() if not v]
    if missing:
        raise SystemExit(f"Missing child workflows: {missing}")

    masters = [r for r in rows if r["name"] == MASTER_NAME]
    if not masters:
        raise SystemExit("Master workflow not found")

    # Patch all masters; activate the one that looks like the parallel fan-out (has 4 execute nodes)
    target = None
    for m in masters:
        nodes = json.loads(m["nodes"])
        exec_nodes = [n for n in nodes if n.get("type", "").endswith("executeWorkflow")]
        if len(exec_nodes) >= 4:
            target = m
            break
    if target is None:
        target = masters[-1]

    nodes = json.loads(target["nodes"])
    changed = 0
    for n in nodes:
        if not n.get("type", "").endswith("executeWorkflow"):
            continue
        child_name = EXEC_MAP.get(n["name"])
        if not child_name:
            continue
        wid = CHILD_BY_NAME[child_name]
        params = n.setdefault("parameters", {})
        params["workflowId"] = {
            "__rl": True,
            "value": wid,
            "mode": "id",
            "cachedResultName": child_name,
        }
        changed += 1
        print(f"  wired {n['name']} -> {wid} ({child_name})")

    # deactivate other masters / duplicate children named wrongly
    conn.execute("UPDATE workflow_entity SET active = 0 WHERE name = ?", (MASTER_NAME,))
    conn.execute(
        "UPDATE workflow_entity SET nodes = ?, active = 1 WHERE id = ?",
        (json.dumps(nodes), target["id"]),
    )
    # ensure preferred children active
    for name, wid in CHILD_BY_NAME.items():
        conn.execute("UPDATE workflow_entity SET active = 1 WHERE id = ?", (wid,))
        # deactivate duplicates of same name
        conn.execute(
            "UPDATE workflow_entity SET active = 0 WHERE name = ? AND id != ?",
            (name, wid),
        )

    conn.commit()
    print(f"Activated master {target['id']} ({changed} execute nodes patched)")
    print("Restart n8n for webhook registration.")
    conn.close()


if __name__ == "__main__":
    main()

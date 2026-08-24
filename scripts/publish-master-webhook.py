"""Publish master workflow for n8n (activeVersionId + webhook_entity)."""
import json
import sqlite3
import uuid
from pathlib import Path

DB = Path(__file__).resolve().parents[1] / "n8n_data" / "database.sqlite"
MASTER_ID = None  # filled from DB


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row

    master = conn.execute(
        """
        SELECT id, name, versionId, nodes
        FROM workflow_entity
        WHERE name = '01 - Job-close listener (master)' AND active = 1
        LIMIT 1
        """
    ).fetchone()
    if not master:
        raise SystemExit("No active master found")

    mid = master["id"]
    vid = master["versionId"]
    nodes = json.loads(master["nodes"])

    # Ensure execute targets point at active children
    children = {}
    for name in (
        "02 - Report generation",
        "03 - Issue routing",
        "04 - Critical alert",
        "05 - System update",
    ):
        row = conn.execute(
            "SELECT id FROM workflow_entity WHERE name = ? AND active = 1 LIMIT 1",
            (name,),
        ).fetchone()
        if not row:
            raise SystemExit(f"Missing active child {name}")
        children[name] = row["id"]

    exec_map = {
        "Execute WF2 Report generation": "02 - Report generation",
        "Execute WF3 Issue routing": "03 - Issue routing",
        "Execute WF4 Critical alert": "04 - Critical alert",
        "Execute WF5 System update": "05 - System update",
    }
    for n in nodes:
        if n.get("name") in exec_map:
            cname = exec_map[n["name"]]
            n.setdefault("parameters", {})["workflowId"] = {
                "__rl": True,
                "value": children[cname],
                "mode": "id",
                "cachedResultName": cname,
            }

    # Upsert history snapshot for this version
    existing = conn.execute(
        "SELECT versionId FROM workflow_history WHERE versionId = ?",
        (vid,),
    ).fetchone()
    connections = conn.execute(
        "SELECT connections FROM workflow_entity WHERE id = ?",
        (mid,),
    ).fetchone()["connections"]
    if not existing:
        conn.execute(
            """
            INSERT INTO workflow_history
              (versionId, workflowId, authors, createdAt, updatedAt, nodes, connections, name, autosaved)
            VALUES (?, ?, 'siteproof-script', datetime('now'), datetime('now'), ?, ?, ?, 0)
            """,
            (vid, mid, json.dumps(nodes), connections, master["name"]),
        )
    else:
        conn.execute(
            "UPDATE workflow_history SET nodes = ?, updatedAt = datetime('now') WHERE versionId = ?",
            (json.dumps(nodes), vid),
        )

    conn.execute(
        """
        UPDATE workflow_entity
        SET nodes = ?, active = 1, activeVersionId = ?, triggerCount = 1, updatedAt = datetime('now')
        WHERE id = ?
        """,
        (json.dumps(nodes), vid, mid),
    )

    # published version pointer
    conn.execute("DELETE FROM workflow_published_version WHERE workflowId = ?", (mid,))
    conn.execute(
        """
        INSERT INTO workflow_published_version (workflowId, publishedVersionId, createdAt, updatedAt)
        VALUES (?, ?, datetime('now'), datetime('now'))
        """,
        (mid, vid),
    )

    # register webhook
    conn.execute("DELETE FROM webhook_entity WHERE workflowId = ?", (mid,))
    conn.execute(
        """
        INSERT INTO webhook_entity (workflowId, webhookPath, method, node, webhookId, pathLength)
        VALUES (?, ?, 'POST', ?, ?, ?)
        """,
        (
            mid,
            "siteproof-job-closed",
            "Webhook job.closed",
            "siteproof-job-closed",
            1,
        ),
    )

    user = conn.execute("SELECT id FROM user LIMIT 1").fetchone()
    uid = user["id"] if user else None
    conn.execute(
        """
        INSERT INTO workflow_publish_history (workflowId, versionId, event, userId, createdAt)
        VALUES (?, ?, 'activated', ?, datetime('now'))
        """,
        (mid, vid, uid),
    )

    conn.commit()
    print(f"Published master {mid} version {vid}")
    print("webhook_entity rows:", conn.execute("select count(*) from webhook_entity").fetchone()[0])
    conn.close()


if __name__ == "__main__":
    main()

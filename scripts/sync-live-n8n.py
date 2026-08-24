"""
Sync generated workflow JSON into live n8n sqlite:
- update nodes/connections on active workflows by name
- bind real credential IDs
- publish/unarchive master + webhook registration
- clear hung executions
"""
import json
import sqlite3
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "n8n_data" / "database.sqlite"
WF_DIR = ROOT / "workflows"

NAME_TO_FILE = {
    "01 - Job-close listener (master)": "01-job-close-listener.json",
    "02 - Report generation": "02-report-generation.json",
    "03 - Issue routing": "03-issue-routing.json",
    "04 - Critical alert": "04-critical-alert.json",
    "05 - System update": "05-system-update.json",
}

CHILD_EXEC = {
    "Execute WF2 Report generation": "02 - Report generation",
    "Execute WF3 Issue routing": "03 - Issue routing",
    "Execute WF4 Critical alert": "04 - Critical alert",
    "Execute WF5 System update": "05 - System update",
}


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row

    creds = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM credentials_entity")}
    gmail_name = "Gmail account" if "Gmail account" in creds else "SiteProof Gmail"
    sheets_name = "Google Sheets account" if "Google Sheets account" in creds else "SiteProof Google Sheets"
    if gmail_name not in creds:
        raise SystemExit(f"Missing Gmail credential. Have: {list(creds)}")
    if sheets_name not in creds:
        raise SystemExit(f"Missing Sheets credential. Have: {list(creds)}")
    gmail_id, sheets_id = creds[gmail_name], creds[sheets_name]
    print("creds", gmail_name, sheets_name)

    # Prefer one active row per name; deactivate duplicates
    active_ids = {}
    for name in NAME_TO_FILE:
        rows = conn.execute(
            "SELECT id, active, updatedAt FROM workflow_entity WHERE name=? ORDER BY active DESC, updatedAt DESC",
            (name,),
        ).fetchall()
        if not rows:
            raise SystemExit(f"Missing workflow in n8n: {name}")
        keep = rows[0]["id"]
        active_ids[name] = keep
        for r in rows[1:]:
            conn.execute(
                "UPDATE workflow_entity SET active=0, isArchived=1 WHERE id=?",
                (r["id"],),
            )

    # Patch each workflow from generated JSON
    for name, file in NAME_TO_FILE.items():
        src = json.loads((WF_DIR / file).read_text(encoding="utf-8"))
        wid = active_ids[name]
        nodes = src["nodes"]
        connections = src["connections"]

        # Bind credentials + master execute IDs
        for n in nodes:
            cblock = n.get("credentials") or {}
            if "gmailOAuth2" in cblock:
                cblock["gmailOAuth2"] = {"id": gmail_id, "name": gmail_name}
                n["credentials"] = cblock
            if "googleSheetsOAuth2Api" in cblock:
                cblock["googleSheetsOAuth2Api"] = {"id": sheets_id, "name": sheets_name}
                n["credentials"] = cblock
            if name.startswith("01") and n.get("name") in CHILD_EXEC:
                child = CHILD_EXEC[n["name"]]
                n.setdefault("parameters", {})["workflowId"] = {
                    "__rl": True,
                    "value": active_ids[child],
                    "mode": "id",
                    "cachedResultName": child,
                }

        version_id = str(uuid.uuid4())
        nodes_json = json.dumps(nodes)
        conn_json = json.dumps(connections)
        settings = json.dumps(src.get("settings") or {"executionOrder": "v1", "callerPolicy": "workflowsFromSameOwner"})
        pin = json.dumps(src.get("pinData") or {})

        conn.execute(
            """
            UPDATE workflow_entity
            SET nodes=?, connections=?, settings=?, pinData=?, versionId=?, activeVersionId=?,
                active=1, isArchived=0, triggerCount=?, updatedAt=datetime('now')
            WHERE id=?
            """,
            (
                nodes_json,
                conn_json,
                settings,
                pin,
                version_id,
                version_id,
                1 if name.startswith("01") else 0,
                wid,
            ),
        )

        conn.execute(
            """
            INSERT INTO workflow_history
              (versionId, workflowId, authors, createdAt, updatedAt, nodes, connections, name, autosaved)
            VALUES (?, ?, 'siteproof-repair', datetime('now'), datetime('now'), ?, ?, ?, 0)
            """,
            (version_id, wid, nodes_json, conn_json, name),
        )
        conn.execute("DELETE FROM workflow_published_version WHERE workflowId=?", (wid,))
        conn.execute(
            """
            INSERT INTO workflow_published_version (workflowId, publishedVersionId, createdAt, updatedAt)
            VALUES (?, ?, datetime('now'), datetime('now'))
            """,
            (wid, version_id),
        )
        conn.execute(
            """
            INSERT INTO workflow_publish_history (workflowId, versionId, event, userId, createdAt)
            VALUES (?, ?, 'activated', (SELECT id FROM user LIMIT 1), datetime('now'))
            """,
            (wid, version_id),
        )
        print("synced", name, "->", wid, "ver", version_id[:8])

    # Webhook registration for master
    master_id = active_ids["01 - Job-close listener (master)"]
    conn.execute("DELETE FROM webhook_entity WHERE workflowId=?", (master_id,))
    conn.execute(
        """
        INSERT INTO webhook_entity (workflowId, webhookPath, method, node, webhookId, pathLength)
        VALUES (?, 'siteproof-job-closed', 'POST', 'Webhook job.closed', 'siteproof-job-closed', 1)
        """,
        (master_id,),
    )

    # Clear hung / old running executions
    n = conn.execute(
        "UPDATE execution_entity SET status='crashed', finished=1, stoppedAt=datetime('now') WHERE status='running'"
    ).rowcount
    print("cleared running executions:", n)

    conn.commit()
    conn.close()
    print("DONE — restart n8n to load webhooks")


if __name__ == "__main__":
    main()

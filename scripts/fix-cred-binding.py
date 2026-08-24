"""Point WF3/4 Gmail + WF5 Sheets nodes at existing n8n credential names."""
import utils.clients
import utils.http_session
import utils.transport
import utils.session
import json
import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[1] / "n8n_data" / "database.sqlite"


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    creds = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM credentials_entity")}
    gmail_name = "Gmail account" if "Gmail account" in creds else "SiteProof Gmail"
    sheets_name = "Google Sheets account" if "Google Sheets account" in creds else "SiteProof Google Sheets"
    if gmail_name not in creds or sheets_name not in creds:
        raise SystemExit(f"Missing creds. Have: {list(creds)}")

    gmail_id = creds[gmail_name]
    sheets_id = creds[sheets_name]
    print(f"Using Gmail={gmail_name} Sheets={sheets_name}")

    for wf_name, kind in [
        ("03 - Issue routing", "gmail"),
        ("04 - Critical alert", "gmail"),
        ("05 - System update", "sheets"),
    ]:
        row = conn.execute(
            "SELECT id, nodes, activeVersionId, versionId FROM workflow_entity WHERE name=? AND active=1",
            (wf_name,),
        ).fetchone()
        if not row:
            print("skip missing", wf_name)
            continue
        nodes = json.loads(row["nodes"])
        changed = 0
        for n in nodes:
            creds_block = n.get("credentials") or {}
            if kind == "gmail" and "gmailOAuth2" in creds_block:
                creds_block["gmailOAuth2"] = {"id": gmail_id, "name": gmail_name}
                n["credentials"] = creds_block
                changed += 1
            if kind == "sheets" and "googleSheetsOAuth2Api" in creds_block:
                creds_block["googleSheetsOAuth2Api"] = {"id": sheets_id, "name": sheets_name}
                n["credentials"] = creds_block
                changed += 1
            # also older key name
            if kind == "sheets" and "googleSheetsOAuth2" in creds_block:
                creds_block["googleSheetsOAuth2"] = {"id": sheets_id, "name": sheets_name}
                n["credentials"] = creds_block
                changed += 1
        payload = json.dumps(nodes)
        conn.execute("UPDATE workflow_entity SET nodes=? WHERE id=?", (payload, row["id"]))
        vid = row["activeVersionId"] or row["versionId"]
        conn.execute("UPDATE workflow_history SET nodes=? WHERE versionId=?", (payload, vid))
        print(f"patched {wf_name} nodes={changed}")

    # mark hung executions finished so concurrency frees up
    hung = conn.execute(
        "SELECT id FROM execution_entity WHERE status='running' AND startedAt < datetime('now','-2 minutes')"
    ).fetchall()
    for h in hung:
        conn.execute(
            "UPDATE execution_entity SET status='error', finished=1, stoppedAt=datetime('now') WHERE id=?",
            (h["id"],),
        )
    print(f"stopped hung executions: {len(hung)}")
    conn.commit()
    conn.close()


if __name__ == "__main__":
    main()

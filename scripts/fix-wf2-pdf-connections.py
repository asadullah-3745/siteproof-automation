"""Fix WF2: Capture PDF error must be on error output, not main."""
import json
import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[1] / "n8n_data" / "database.sqlite"


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT id, connections, activeVersionId, versionId FROM workflow_entity WHERE name=? AND active=1",
        ("02 - Report generation",),
    ).fetchone()
    if not row:
        raise SystemExit("WF2 not found")
    connections = json.loads(row["connections"])
    connections["HTML to PDF"] = {
        "main": [
            [{"node": "POST report-ready + action ok", "type": "main", "index": 0}]
        ],
        "error": [
            [{"node": "Capture PDF error", "type": "main", "index": 0}]
        ],
    }
    payload = json.dumps(connections)
    conn.execute("UPDATE workflow_entity SET connections=? WHERE id=?", (payload, row["id"]))
    vid = row["activeVersionId"] or row["versionId"]
    # history stores connections too
    hist = conn.execute(
        "SELECT connections FROM workflow_history WHERE versionId=?", (vid,)
    ).fetchone()
    if hist and hist["connections"]:
        hconn = json.loads(hist["connections"])
        hconn["HTML to PDF"] = connections["HTML to PDF"]
        conn.execute(
            "UPDATE workflow_history SET connections=? WHERE versionId=?",
            (json.dumps(hconn), vid),
        )
    conn.commit()
    print("fixed WF2 HTML to PDF connections")
    conn.close()


if __name__ == "__main__":
    main()

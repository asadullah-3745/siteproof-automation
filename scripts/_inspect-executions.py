import sqlite3
import json
from pathlib import Path

DB = Path(__file__).resolve().parents[1] / "n8n_data" / "database.sqlite"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

rows = c.execute(
    """
    SELECT id, workflowId, status, finished, startedAt, stoppedAt
    FROM execution_entity
    ORDER BY startedAt DESC
    LIMIT 12
    """
).fetchall()
print("recent executions:")
for r in rows:
    name = c.execute("select name from workflow_entity where id=?", (r["workflowId"],)).fetchone()
    print(r["id"], name["name"] if name else r["workflowId"], r["status"], r["startedAt"])

# execution_data for newest child failures
for r in rows[:8]:
    name = c.execute("select name from workflow_entity where id=?", (r["workflowId"],)).fetchone()
    n = name["name"] if name else "?"
    ed = c.execute("select data from execution_data where executionId=?", (r["id"],)).fetchone()
    if not ed:
        continue
    raw = ed["data"]
    # may be compressed string
    text = raw if isinstance(raw, str) else raw.decode("utf-8", errors="ignore")
    if "Cannot read" in text or "job" in text[:500]:
        print("\n==", n, r["id"], "snippet ==")
        # find error messages
        idx = text.find("Cannot read")
        if idx >= 0:
            print(text[max(0, idx - 80) : idx + 120])
        idx2 = text.find('"error"')
        if idx2 >= 0:
            print(text[idx2 : idx2 + 200])

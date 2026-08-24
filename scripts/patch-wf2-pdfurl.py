"""Patch WF2 report-ready node in live n8n DB to send https pdfUrl."""
import json
import re
import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[1] / "n8n_data" / "database.sqlite"

OLD = 'pdfUrl: null'
# Prefer replacing the whole ready block markers inside jsCode

def patch_jscode(js: str) -> str:
    js2 = js
    js2 = js2.replace(
        "const pdfStorageKey = 'reports/' + jobId + '.pdf';\nconst pdfUrl = ctx.job_url;",
        "const pdfUrl = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';\nconst pdfStorageKey = pdfUrl;",
    )
    js2 = js2.replace("pdfUrl: null,", "pdfUrl: pdfUrl,")
    js2 = js2.replace(
        "const action = await postAction.call(this, ctx, 'report.pdf', 'storage', 'ok', { pdfStorageKey: pdfStorageKey });",
        "const action = await postAction.call(this, ctx, 'report.pdf', 'storage', 'ok', { pdfStorageKey: pdfStorageKey, pdfUrl: pdfUrl });",
    )
    return js2


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT id, nodes FROM workflow_entity WHERE name = ? AND active = 1 LIMIT 1",
        ("02 - Report generation",),
    ).fetchone()
    if not row:
        raise SystemExit("active WF2 not found")
    nodes = json.loads(row["nodes"])
    changed = 0
    for n in nodes:
        if n.get("name") == "POST report-ready + action ok":
            code = n["parameters"]["jsCode"]
            new_code = patch_jscode(code)
            if new_code != code:
                n["parameters"]["jsCode"] = new_code
                changed += 1
    conn.execute(
        "UPDATE workflow_entity SET nodes = ? WHERE id = ?",
        (json.dumps(nodes), row["id"]),
    )
    conn.commit()
    print(f"patched WF2 {row['id']} nodes={changed}")
    conn.close()


if __name__ == "__main__":
    main()

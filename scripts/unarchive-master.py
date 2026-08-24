import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[1] / "n8n_data" / "database.sqlite"
c = sqlite3.connect(DB)
c.execute(
    "UPDATE workflow_entity SET isArchived = 0, active = 1 WHERE id = ?",
    ("cTfZCS14XH3o0vWM",),
)
c.commit()
row = c.execute(
    "SELECT id, active, isArchived, activeVersionId FROM workflow_entity WHERE id = ?",
    ("cTfZCS14XH3o0vWM",),
).fetchone()
print("master", row)
print("webhooks", list(c.execute("SELECT workflowId, webhookPath, method FROM webhook_entity")))
c.close()

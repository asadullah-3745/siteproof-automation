import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[1] / "n8n_data" / "database.sqlite"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row
print("webhooks", [tuple(r) for r in c.execute("select * from webhook_entity")])
for r in c.execute(
    "select id,name,active,activeVersionId,isArchived,triggerCount from workflow_entity where name like '01%'"
):
    print(dict(r))
print("published", [tuple(r) for r in c.execute("select * from workflow_published_version")])

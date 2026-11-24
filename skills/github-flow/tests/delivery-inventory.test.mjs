import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('fleet diagnostics distinguish retained receipts, unavailable evidence and unresolved attempts', () => {
  const cwd = fileURLToPath(new URL('../scripts/', import.meta.url));
  const script = `
from delivery_inventory import assess
from controller_inventory import inventory
import json, sqlite3, tempfile
from pathlib import Path
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "ledger.sqlite"
    project = dict(owner="owner", repository="repo", repository_id=42, project_owner="owner", project_number=1, deployment_enabled=True)
    config = dict(projects=[project], deployment_state_path=str(path))
    assert inventory(config)[0]["ledger"] is None
    assert not path.exists()
    db = sqlite3.connect(path)
    db.execute("pragma application_id=0x41474450")
    db.execute("pragma user_version=1")
    db.execute("create table deployment(sequence integer,repository_id integer,request text,status text)")
    for seq, sha, status in [(1,"a","succeeded"),(2,"b","unknown")]:
        db.execute("insert into deployment values(?,42,?,?)",(seq,json.dumps(dict(target="main",commit=sha)),status))
    db.commit()
    db.close()
    entry = inventory(config)[0]["ledger"]["main"]
    assert entry["last_success"] == "a" and entry["requested"] == "b"
    assert assess(True,entry,"a")["state"] == "latest-unknown"
    assert assess(True,None,"a")["state"] == "ledger-unavailable"
    assert assess(True,{},"a")["state"] == "no-recorded-success"
    receipt = dict(latest="succeeded",last_success="a")
    assert assess(True,receipt,"b")["state"] == "head-without-confirmation"
    assert assess(True,receipt,"a")["state"] == "recorded-success-at-head"
    assert assess(True,receipt,None)["state"] == "branch-unverified"
    assert assess(False,receipt,"a")["state"] == "outside-central-deployment"
`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', script], {cwd, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
});

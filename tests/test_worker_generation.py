import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import webhook_ingress as ingress
import worker_ledger


def delivery(n):return f'00000000-0000-4000-8000-{n:012x}'


@unittest.skipUnless(os.name=='posix','Worker lock requires POSIX')
class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory(prefix='agf-generation-test-')
        self.queue=Path(self.directory.name)/'ingress.sqlite'
        self.path=Path(self.directory.name)/'ledger.sqlite'
        self.lock=Path(self.directory.name)/'worker.lock'
        self.key=b'synthetic-fingerprint-key-for-the-tests-only'
        self.secret=b'synthetic-webhook-secret-for-the-tests-only'
        self.registry=ingress.validate_registry([(11,22)])
        self.body=json.dumps({'action':'created','installation':{'id':11},'repository':{'id':22},
                              'issue':{'number':8},'comment':{'id':77}}).encode()
        self.signature='sha256='+hmac.new(self.secret,self.body,hashlib.sha256).hexdigest()
        ingress.initialize(self.queue,self.key)
    def tearDown(self):self.directory.cleanup()
    def receive(self,n):
        self.assertEqual(ingress.receive(self.queue,self.secret,self.key,self.registry,delivery(n),'issue_comment',
                                         self.signature,self.body),'accepted')

    def test_frozen_generation_survives_restart_and_defers_new_arrivals(self):
        self.receive(2);self.receive(3)
        with worker_ledger.Ledger(self.path,self.lock,allow_create=True) as work:
            self.assertEqual(work._create_scan_generation_locked_probe(self.queue,self.key),{'kind':'generation-created','count':2})
            with self.assertRaises(ValueError):work._create_scan_generation_locked_probe(self.queue,self.key)
            self.receive(1)
            self.assertEqual(work.import_generation_batch(1),{'kind':'batch-imported','count':1,'more':True})
        with worker_ledger.Ledger(self.path,self.lock) as work:
            self.receive(4)
            self.assertEqual(work.import_generation_batch(1),{'kind':'batch-imported','count':1,'more':False})
            self.assertEqual(work.pending_preview(),[delivery(2),delivery(3)])
            self.assertEqual(work._create_scan_generation_locked_probe(self.queue,self.key),{'kind':'generation-created','count':2})
            self.assertEqual(work.import_generation_batch(),{'kind':'batch-imported','count':2,'more':False})
            self.assertEqual(work.pending_preview(),[delivery(2),delivery(3),delivery(1),delivery(4)])
            self.assertEqual(work._create_scan_generation_locked_probe(self.queue,self.key),{'kind':'generation-created','count':0})

    def test_failed_generation_rolls_back_and_keeps_source(self):
        self.receive(1);self.receive(2)
        with worker_ledger.Ledger(self.path,self.lock,allow_create=True) as work:
            with self.assertRaises(ValueError):work._create_scan_generation_locked_probe(self.queue,self.key,max_ids=1)
            self.assertEqual(work.import_generation_batch(),{'kind':'batch-imported','count':0,'more':False})
            with self.assertRaises(ValueError):work._create_scan_generation_locked_probe(self.queue,b'wrong-key-'*4)
            self.assertEqual(work._create_scan_generation_locked_probe(self.queue,self.key),{'kind':'generation-created','count':2})
            self.assertEqual(work.pending_preview(),[])
        self.assertEqual(len(ingress.scan_delivery_ids(self.queue,self.key)['deliveryIds']),2)

    def test_long_snapshot_can_delay_ingress_commit_past_its_timeout(self):
        self.receive(1)
        src=str(Path(__file__).resolve().parents[1]/'src')
        script="""import hashlib,hmac,json,sys
sys.path.insert(0,sys.argv[1]);import webhook_ingress as i
key=b'synthetic-fingerprint-key-for-the-tests-only';secret=b'synthetic-webhook-secret-for-the-tests-only'
body=json.dumps({'action':'created','installation':{'id':11},'repository':{'id':22},'issue':{'number':8},'comment':{'id':77}}).encode()
sig='sha256='+hmac.new(secret,body,hashlib.sha256).hexdigest()
print(i.receive(sys.argv[2],secret,key,i.validate_registry([(11,22)]),'00000000-0000-4000-8000-000000000002','issue_comment',sig,body))
"""
        with worker_ledger.Ledger(self.path,self.lock,allow_create=True) as work:
            original=work.db
            class ProbeDuringSnapshot:
                result=None
                def execute(inner,sql,*args):
                    result=original.execute(sql,*args)
                    if sql.startswith('INSERT INTO scan_generation') and inner.result is None:
                        inner.result=subprocess.run([sys.executable,'-c',script,src,str(self.queue)],
                                                    capture_output=True,text=True,timeout=15)
                    return result
                def __getattr__(inner,name):return getattr(original,name)
            probe=ProbeDuringSnapshot();work.db=probe
            try:self.assertEqual(work._create_scan_generation_locked_probe(self.queue,self.key),{'kind':'generation-created','count':1})
            finally:work.db=original
            self.assertEqual(probe.result.returncode,0,probe.result.stderr)
            self.assertEqual(probe.result.stdout.strip(),'storage_unavailable')
        self.receive(2)

    def test_online_backup_allows_writer_between_steps_in_controlled_probe(self):
        self.receive(1)
        original_connect=ingress.connect_existing
        source_path=str(self.queue)
        outcome={'called':False,'value':None,'remaining':None}
        class SourceProxy:
            def __init__(self,db):self.db=db
            def backup(self,target,*,pages,progress,sleep):
                def probe(status,remaining,total):
                    if not outcome['called']:
                        outcome['called']=True;outcome['remaining']=remaining
                        outcome['value']=ingress.receive(self_outer.queue,self_outer.secret,self_outer.key,self_outer.registry,
                            delivery(2),'issue_comment',self_outer.signature,self_outer.body)
                    progress(status,remaining,total)
                return self.db.backup(target,pages=pages,progress=probe,sleep=sleep)
            def __getattr__(self,name):return getattr(self.db,name)
        self_outer=self
        def connect(path):
            db=original_connect(path)
            return SourceProxy(db) if str(path)==source_path else db
        with worker_ledger.Ledger(self.path,self.lock,allow_create=True) as work:
            with patch.object(ingress,'connect_existing',side_effect=connect):
                result=work.create_scan_generation_from_backup(self.queue,self.key)
            self.assertTrue(outcome['called']);self.assertGreater(outcome['remaining'],0)
            self.assertEqual(outcome['value'],'accepted')
            self.assertEqual(result,{'kind':'generation-created','count':2})
            self.assertEqual(work.import_generation_batch(),{'kind':'batch-imported','count':2,'more':False})
            self.assertEqual(work.pending_preview(),[delivery(1),delivery(2)])
        self.assertEqual(list(Path(self.directory.name).glob('.agf-scan-backup-*')),[])

    def test_online_backup_size_limit_does_not_publish_partial_generation(self):
        self.receive(1)
        with worker_ledger.Ledger(self.path,self.lock,allow_create=True) as work:
            with self.assertRaises(ValueError):
                work.create_scan_generation_from_backup(self.queue,self.key,max_snapshot_bytes=4096)
            self.assertEqual(work.import_generation_batch(),{'kind':'batch-imported','count':0,'more':False})
            self.assertEqual(work.create_scan_generation_from_backup(self.queue,self.key),{'kind':'generation-created','count':1})
        self.assertEqual(list(Path(self.directory.name).glob('.agf-scan-backup-*')),[])

    def test_process_death_during_backup_or_generation_leaves_no_partial_generation(self):
        self.receive(1)
        src=str(Path(__file__).resolve().parents[1]/'src')
        script="""import os,sys
sys.path.insert(0,sys.argv[1]);import worker_ledger,webhook_ingress as ingress
w=worker_ledger.Ledger(sys.argv[2],sys.argv[3],allow_create=True);w.__enter__()
if sys.argv[5]=='backup':
    original=ingress.connect_existing
    class SourceProxy:
        def __init__(self,db):self.db=db
        def backup(self,target,*,pages,progress,sleep):
            return self.db.backup(target,pages=pages,progress=lambda *_:os._exit(73),sleep=sleep)
        def __getattr__(self,name):return getattr(self.db,name)
    ingress.connect_existing=lambda path:SourceProxy(original(path))
else:
    class KillAfterInsert:
        def __init__(self,db):self.db=db
        def execute(self,sql,*args):
            result=self.db.execute(sql,*args)
            if sql.startswith('INSERT INTO scan_generation'):os._exit(73)
            return result
        def __getattr__(self,name):return getattr(self.db,name)
    w.db=KillAfterInsert(w.db)
w.create_scan_generation_from_backup(sys.argv[4],b'synthetic-fingerprint-key-for-the-tests-only')
os._exit(74)
"""
        for mode in ('backup','generation'):
            path=Path(self.directory.name)/(mode+'-backup-ledger.sqlite')
            prior=set(Path(self.directory.name).glob('.agf-scan-backup-*'))
            process=subprocess.run([sys.executable,'-c',script,src,str(path),str(self.lock),str(self.queue),mode],
                                   capture_output=True,text=True)
            self.assertEqual(process.returncode,73,process.stderr)
            with worker_ledger.Ledger(path,self.lock) as work:
                self.assertEqual(work.import_generation_batch(),{'kind':'batch-imported','count':0,'more':False})
                self.assertEqual(work.create_scan_generation_from_backup(self.queue,self.key),{'kind':'generation-created','count':1})
                self.assertEqual(work.import_generation_batch()['count'],1)
            orphans=set(Path(self.directory.name).glob('.agf-scan-backup-*'))-prior
            self.assertTrue(orphans)
            self.assertTrue(all((os.stat(item).st_mode & 0o077)==0 for item in orphans))
        self.assertEqual(ingress.scan_delivery_ids(self.queue,self.key)['deliveryIds'],[delivery(1)])

    def test_process_death_before_and_after_batch_commit(self):
        self.receive(1);self.receive(2)
        src=str(Path(__file__).resolve().parents[1]/'src')
        script="""import os,sys
sys.path.insert(0,sys.argv[1]);import worker_ledger
w=worker_ledger.Ledger(sys.argv[2],sys.argv[3]);w.__enter__()
if sys.argv[4]=='before':
    class KillAfterDelete:
        def __init__(self,db):self.db=db
        def executemany(self,sql,*args):
            result=self.db.executemany(sql,*args)
            if sql.startswith('DELETE FROM scan_generation'):os._exit(73)
            return result
        def __getattr__(self,name):return getattr(self.db,name)
    w.db=KillAfterDelete(w.db)
w.import_generation_batch(1);os._exit(73)
"""
        for mode in ('before','after'):
            path=Path(self.directory.name)/(mode+'-batch.sqlite')
            with worker_ledger.Ledger(path,self.lock,allow_create=True) as work:
                work._create_scan_generation_locked_probe(self.queue,self.key)
            process=subprocess.run([sys.executable,'-c',script,src,str(path),str(self.lock),mode],capture_output=True,text=True)
            self.assertEqual(process.returncode,73,process.stderr)
            with worker_ledger.Ledger(path,self.lock) as work:
                self.assertEqual(work.pending_preview(),[] if mode=='before' else [delivery(1)])
                result=work.import_generation_batch(1)
                self.assertEqual(result['count'],1)
                self.assertEqual(work.pending_preview(),[delivery(1)] if mode=='before' else [delivery(1),delivery(2)])

    def test_process_death_before_and_after_generation_commit(self):
        self.receive(1);self.receive(2)
        src=str(Path(__file__).resolve().parents[1]/'src')
        script="""import os,sys
sys.path.insert(0,sys.argv[1]);import worker_ledger
w=worker_ledger.Ledger(sys.argv[2],sys.argv[3],allow_create=True);w.__enter__()
if sys.argv[5]=='before':
    class KillAfterInsert:
        def __init__(self,db):self.db=db
        def execute(self,sql,*args):
            result=self.db.execute(sql,*args)
            if sql.startswith('INSERT INTO scan_generation'):os._exit(73)
            return result
        def __getattr__(self,name):return getattr(self.db,name)
    w.db=KillAfterInsert(w.db)
w._create_scan_generation_locked_probe(sys.argv[4],b'synthetic-fingerprint-key-for-the-tests-only');os._exit(73)
"""
        for mode in ('before','after'):
            path=Path(self.directory.name)/(mode+'-generation.sqlite')
            process=subprocess.run([sys.executable,'-c',script,src,str(path),str(self.lock),str(self.queue),mode],
                                   capture_output=True,text=True)
            self.assertEqual(process.returncode,73,process.stderr)
            with worker_ledger.Ledger(path,self.lock) as work:
                if mode=='before':
                    self.assertEqual(work.import_generation_batch(),{'kind':'batch-imported','count':0,'more':False})
                    self.assertEqual(work._create_scan_generation_locked_probe(self.queue,self.key),{'kind':'generation-created','count':2})
                else:
                    with self.assertRaises(ValueError):work._create_scan_generation_locked_probe(self.queue,self.key)
                self.assertEqual(work.import_generation_batch(),{'kind':'batch-imported','count':2,'more':False})
                self.assertEqual(work.pending_preview(),[delivery(1),delivery(2)])


if __name__=='__main__':unittest.main()

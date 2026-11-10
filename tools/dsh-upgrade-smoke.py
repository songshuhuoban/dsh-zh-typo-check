"""Real Windows DSH profile smoke; creates no account and never edits the desktop profile."""
import argparse, datetime, hashlib, json, os, re, shutil, statistics, subprocess, time, urllib.parse, urllib.request, uuid
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dsh-exe', type=Path, required=True)
parser.add_argument('--installed-spec', default='dsh-zh-typo-check@0.2.3')
parser.add_argument('--target-version', default='0.3.0')
parser.add_argument('--candidate-source', action='store_true', help='Run current source as the old version before a registry update')
parser.add_argument('--skip-probe', action='store_true')
parser.add_argument('--with-models', action='store_true', help='Use the pinned public models from the local research cache')
parser.add_argument('--sensitivity', choices=['low', 'normal', 'high'], default='low')
parser.add_argument('--operation', choices=['update', 'remove', 'stage'], default='update')
parser.add_argument('--expect', choices=['applied', 'failed'], default='applied')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
if os.name != 'nt': parser.error('This test reproduces Windows DLL locking')
home = (args.output or root/'.research'/('upgrade-smoke-'+uuid.uuid4().hex[:10])).resolve()
if not home.is_relative_to(root/'.research'): parser.error('Output must be under this repository .research directory')
if (home/'profiles').exists(): parser.error('Use a fresh output directory')
home.mkdir(parents=True, exist_ok=True)
exe = args.dsh_exe.resolve()
entry = exe.parent/'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
if not exe.is_file(): parser.error('DSH executable not found')
env = {**os.environ, 'ELECTRON_RUN_AS_NODE': '1', 'DSH_HOME': str(home)}
cli = [str(exe), '--expose-internals', str(entry)]
p = home/'profiles/web'
def run_cli(append, name):
    with (home/(name+'.log')).open('wb') as log:
        result=subprocess.run(cli+append,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode: raise RuntimeError('CLI failed; see '+str(home/(name+'.log')))
def write_json(path, value): path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def digest(file): return hashlib.sha256(file.read_bytes()).hexdigest()

run_cli(['--profile','web','--help'],'init')
(p/'pnpm-workspace.yaml').write_text('packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  onnxruntime-node: false\nminimumReleaseAgeExclude:\n  - dsh-zh-typo-check@0.3.0\n',encoding='utf-8')
run_cli(['plugin','--profile','web','add',args.installed_spec,'--save-exact','--registry=https://registry.npmjs.org'],'install')
package=p/'node_modules/dsh-zh-typo-check'
if args.candidate_source:
    for file in (root/'bundle').rglob('*'):
        relative=file.relative_to(root/'bundle')
        if not file.is_file() or relative.as_posix()=='package.json': continue
        target=package/relative; target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(file,target)
diagnostic=home/'fixture-packages/dsh-upgrade-diagnostic'
diagnostic.mkdir(parents=True)
shutil.copyfile(root/'tools/fixtures/upgrade-diagnostic.mjs',diagnostic/'index.mjs')
write_json(diagnostic/'package.json',dict(name='dsh-upgrade-diagnostic',version='1.0.0',type='module',exports='./index.mjs',dsh=dict(bundle=dict(patch='./cordis.patch.yml'))))
write_json(diagnostic/'cordis.patch.yml',[dict(insert=[dict(id='upgrade-diagnostic',name='dsh-upgrade-diagnostic')])])
run_cli(['plugin','--profile','web','add',str(diagnostic),'--save-exact','--registry=https://registry.npmjs.org'],'diagnostic-install')
manifest=json.loads((p/'package.json').read_text(encoding='utf-8'))
bundles=manifest['dsh']['profile']['bundles']
for name in ['dsh-zh-typo-check','dsh-upgrade-diagnostic']:
    if name not in bundles: bundles.append(name)
write_json(p/'package.json',manifest)
patch='- id: plugin-manager\n  config:\n    idleTimeoutMs: 5000\n- id: zh-typo-check\n  config:\n    sensitivity: '+args.sensitivity+'\n'
(p/'cordis.patch.yml').write_text(patch,encoding='utf-8')
model_hashes={}
if args.with_models:
    models=p/'models/zh-typo-check'; models.mkdir(parents=True)
    mlm=root/'node_modules/@huggingface/transformers/.cache/Xenova/macbert4csc-base-chinese'
    semantic=root/'.research/semantic-round13/package/model-int8.onnx'
    if not semantic.exists(): semantic=root/'.model-cache/semantic-r13-int8.onnx'
    for source,target in [(mlm/'tokenizer.json',models/'tokenizer.json'),(mlm/'onnx/model_quantized.onnx',models/'model_quantized.onnx'),(semantic,models/'semantic-r13/semantic-r13-int8.onnx')]:
        target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(source,target)
        model_hashes[str(target.relative_to(p))]=digest(target)

receipt=dict(at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),installed_spec=args.installed_spec,
    candidate_source=args.candidate_source,load_native=not args.skip_probe,operation=args.operation,models=model_hashes)
child=None; keep=False
try:
    with (home/'host.stdout.log').open('wb') as out,(home/'host.stderr.log').open('wb') as err:
        child=subprocess.Popen(cli+['--profile','web','--host','127.0.0.1','--port','0','--no-open'],env=env,stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
    (home/'host.pid').write_text(str(child.pid))
    for _ in range(200):
        if child.poll() is not None: raise RuntimeError('Host exited before startup')
        match=re.search(r'https?://(?:127\.0\.0\.1|localhost):\d+',(home/'host.stdout.log').read_text(encoding='utf-8',errors='replace'))
        if match:
            origin=match.group(0)
            try:
                with urllib.request.urlopen(origin+'/upgrade-diagnostic/state',timeout=3) as response: state=json.load(response)
                break
            except Exception: pass
        time.sleep(.25)
    else: raise RuntimeError('Diagnostic endpoint did not start')
    receipt.update(origin=origin,host_pid=child.pid,hmr=state['hmr'],version=json.loads((package/'package.json').read_text(encoding='utf-8'))['version'])
    def call(part,timeout=60):
        with urllib.request.urlopen(origin+part,timeout=timeout) as response: return json.load(response)
    receipt['locks_before_import']=call('/upgrade-diagnostic/locks')
    if not args.skip_probe:
        receipt['model_status']=call('/zh-typo-model/status')
        assert receipt['model_status']['runtime'] is True
    if args.with_models:
        probes=[('女哦就是的感受a到啊删掉asd苏打粉二十个s收到',True),('请把 gRPC 的 keepalive 时间改为 30s。',False),('That is not what I was asking for.',False)]
        results=[]; times=[]
        for text,warning in probes:
            start=time.perf_counter(); checked=call('/zh-typo-model/check?typo=0&sentence=1&text='+urllib.parse.quote(text))
            assert checked['semantic']['warning'] is warning
            results.append(dict(warning=warning,score=checked['semantic']['score'],seconds=time.perf_counter()-start))
        for i in range(20):
            start=time.perf_counter(); checked=call('/zh-typo-model/check?typo=0&sentence=1&text='+urllib.parse.quote(probes[i%3][0]))
            assert checked['semantic']['warning'] is probes[i%3][1]; times.append((time.perf_counter()-start)*1000)
        receipt.update(probes=results,steady_median_ms=statistics.median(times),steady_max_ms=max(times))
        typo=call('/zh-typo-model/check?typo=1&sentence=0&delta=12&text='+urllib.parse.quote('我到上海住的还，可以用API测试'))
        assert any(issue['original']=='还' and issue['candidate']=='话' for issue in typo['issues'])
        request=urllib.request.Request(origin+'/zh-typo-model/file?v=model_quantized.onnx',headers={'Range':'bytes=0-15'})
        with urllib.request.urlopen(request,timeout=20) as response:
            assert response.status==206 and len(response.read())==16
        receipt.update(legacy_typo_preserved=True,range_streaming=True)
    receipt['locks_after_import']=call('/upgrade-diagnostic/locks')
    # Inspect only this test Host's descendants, never the user's desktop processes.
    script=f"$children=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId={child.pid}' | Where-Object CommandLine -Like '*model-worker.mjs*' | Select-Object -ExpandProperty ProcessId); $ids=@({child.pid})+$children; ConvertTo-Json -Compress -InputObject @(Get-Process -Id $ids | Select-Object Id,WorkingSet64,PeakWorkingSet64)"
    info=subprocess.check_output(['powershell','-NoProfile','-Command',script],creationflags=subprocess.CREATE_NO_WINDOW)
    receipt['memory']=json.loads(info.decode('utf-8-sig'))
    if args.operation!='stage':
        start=time.perf_counter()
        receipt['result']=call('/upgrade-diagnostic/'+args.operation+'?version='+urllib.parse.quote(args.target_version),timeout=90)
        receipt['elapsed_seconds']=time.perf_counter()-start
        trace=[json.loads(line) for line in (p/'upgrade-trace.jsonl').read_text(encoding='utf-8').splitlines()]
        receipt['locks_before_remove']=[row['files'] for row in trace if row['phase']=='locks-before-remove']
        receipt['settings_preserved']=(p/'cordis.patch.yml').read_text(encoding='utf-8')==patch
        receipt['models_preserved']=all(digest(p/name)==sha for name,sha in model_hashes.items())
        assert receipt['settings_preserved'] and receipt['models_preserved']
        result=receipt['result'].get('result',receipt['result'])
        assert result['application']==args.expect, result
        if args.expect=='failed':
            assert result['packageResult'].get('timedOut') is True, result
            assert any(not item['writable'] and item.get('code')=='EBUSY' for files in receipt['locks_before_remove'] for item in files)
    else: keep=True
except Exception as error:
    receipt['error']=repr(error)
    raise
finally:
    if child is not None and not keep:
        child.terminate()
        try: child.wait(timeout=15)
        except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=10)
    write_json(home/'receipt.json',receipt)
    result=receipt.get('result',{}); step=result.get('result',result)
    print(json.dumps(dict(receipt=str(home/'receipt.json'),origin=receipt.get('origin'),error=receipt.get('error'),seconds=receipt.get('elapsed_seconds'),application=step.get('application'),steady_median_ms=receipt.get('steady_median_ms')),ensure_ascii=False))

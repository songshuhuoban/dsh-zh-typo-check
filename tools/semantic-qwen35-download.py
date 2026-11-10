"""Fetch pinned public Qwen GGUFs and an official portable inference runtime."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.research/semantic-qwen35'
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda:f.read(4*1024*1024),b''):h.update(chunk)
    return h.hexdigest()


def download(job):
    target=WORK/job['file'];target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists():
        assert target.stat().st_size==job['bytes'] and sha(target)==job['sha256']
        return dict(job,verified=True)
    part=target.with_suffix(target.suffix+'.part')
    for attempt in range(3):
        try:
            have=part.stat().st_size if part.exists() else 0
            if have==job['bytes']:break
            headers={'User-Agent':'DSH-semantic-research/1.0'}
            if have:headers['Range']=f'bytes={have}-'
            with urllib.request.urlopen(urllib.request.Request(job['url'],headers=headers),timeout=30) as response:
                if have and response.status!=206:have=0
                last=time.monotonic()
                with part.open('ab' if have else 'wb') as out:
                    while True:
                        chunk=response.read(2*1024*1024)
                        if not chunk:break
                        out.write(chunk);have+=len(chunk)
                        assert have<=job['bytes'],'Response exceeds pinned size'
                        if time.monotonic()-last>=10:
                            print({'download':job['name'],'bytes':have,'total':job['bytes']},flush=True);last=time.monotonic()
            if part.stat().st_size==job['bytes']:break
        except Exception as error:
            print({'download':job['name'],'attempt':attempt+1,'error':str(error)},flush=True)
            if attempt==2:raise
            time.sleep(1)
    assert part.stat().st_size==job['bytes'],job['name']
    assert sha(part)==job['sha256'],'Downloaded SHA mismatch: '+job['name']
    os.replace(part,target)
    print({'verified':job['name'],'bytes':job['bytes']},flush=True)
    return dict(job,verified=True)


def main():
    WORK.mkdir(exist_ok=True)
    survey=read(ROOT/'.research/qwen35-quant-survey-20261110.json')['repositories'][0]
    jobs=[]
    for tag,suffix in [('q4','Q4_K_M.gguf'),('q3','Q3_K_M.gguf'),('q2','UD-IQ2_XXS.gguf')]:
        item=next(f for f in survey['files'] if f['file'].endswith(suffix))
        jobs.append({'name':tag,'file':'models/'+item['file'],'bytes':item['bytes'],'sha256':item['sha256'],
            'repo':survey['repo'],'revision':survey['revision'],
            'url':f"https://huggingface.co/{survey['repo']}/resolve/{survey['revision']}/{item['file']}?download=true"})
    release=read(ROOT/'.research/qwen35-llama-nightly.json')
    asset=next(a for a in release['assets'] if a['name'].endswith('bin-win-vulkan-x64.zip'))
    jobs.insert(0,{'name':'runtime','file':asset['name'],'bytes':asset['size'],'sha256':asset['digest'].split(':')[1],
        'tag':release['tag_name'],'url':asset['browser_download_url'],'source':release['html_url']})
    with ThreadPoolExecutor(max_workers=4) as pool:records=list(pool.map(download,jobs))
    folder=WORK/('runtime-'+release['tag_name']);folder.mkdir(exist_ok=True)
    with zipfile.ZipFile(WORK/jobs[0]['file']) as z:
        assert z.testzip() is None
        for info in z.infolist():
            dest=(folder/info.filename).resolve();assert dest.is_relative_to(folder.resolve()),'Unsafe archive path'
        z.extractall(folder)
    servers=list(folder.rglob('llama-server.exe'));assert len(servers)==1
    result={'retrieved_at_utc':datetime.now(timezone.utc).isoformat(),'files':records,
        'runtime_dir':str(servers[0].parent.relative_to(ROOT)),'server':str(servers[0].relative_to(ROOT)),
        'runtime_unpacked_bytes':sum(p.stat().st_size for p in folder.rglob('*') if p.is_file()),
        'runtime_inventory':{str(p.relative_to(folder)):dict(bytes=p.stat().st_size,sha256=sha(p)) for p in folder.rglob('*') if p.is_file()}}
    (WORK/'downloads.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print({'complete':True,'server':result['server'],'runtime_unpacked_bytes':result['runtime_unpacked_bytes']},flush=True)


if __name__=='__main__':main()

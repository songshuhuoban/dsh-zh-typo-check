"""Loopback-only experiment recorder for real OS-IME keyboard input.

This diagnostic page never types, converts, rewrites, or labels the test text.
Letters must arrive through physical-key simulation. The page records IME
composition/input events and a settled snapshot after exactly one Space.
"""
import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading

ROOT = Path(__file__).resolve().parents[1]
PAGE = r'''<!doctype html><meta charset="utf-8"><title>IME keyboard capture</title>
<style>body{font:18px system-ui;margin:32px;max-width:1100px}textarea{display:block;width:95%;height:180px;font:24px system-ui;margin:20px 0}button{padding:10px 24px}code{word-break:break-all}pre{white-space:pre-wrap}</style>
<h1>IME capture</h1><p id="row"></p><code id="keys"></code>
<textarea id="payload" aria-label="IME test input" spellcheck="false" autocomplete="off"></textarea>
<button id="next" type="button">Next</button> <span id="status"></span>
<pre id="result"></pre>
<script>
let batch, index=0, events=[], composing=false, composition='', spaceCount=0, timer;
const box=document.querySelector('#payload'), next=document.querySelector('#next');
const stamp=()=>({utc:new Date().toISOString(),ms:performance.now()});
function snapshot(stage){
  return {row_id:batch.rows[index].id,stage,...stamp(),value:box.value,composing,
    composition,space_count:spaceCount,focus:document.activeElement===box,
    selection:[box.selectionStart,box.selectionEnd],events:[...events]};
}
async function save(stage){
  const body=snapshot(stage);
  const reply=await fetch('/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!reply.ok) throw Error('Recorder write failed');
  document.querySelector('#result').textContent=JSON.stringify({stage,value:body.value,composing:body.composing,composition:body.composition,space_count:body.space_count},null,2);
  document.querySelector('#status').textContent=stage+' saved';
}
function show(){
  const row=batch.rows[index];
  document.querySelector('#row').textContent=row.id+' · '+row.split+' · '+(index+1)+' / '+batch.rows.length;
  document.querySelector('#keys').textContent=row.keys;
  document.querySelector('#result').textContent='';
  document.querySelector('#status').textContent='ready';
  box.value=''; events=[];composing=false;composition='';spaceCount=0;
  box.focus();
}
for(const type of ['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend','focus','blur']){
  box.addEventListener(type,e=>{
    if(type==='compositionstart') composing=true;
    if(type==='compositionupdate') composition=e.data??'';
    if(type==='compositionend'){composing=false;composition='';}
    events.push({type,...stamp(),key:e.key??null,code:e.code??null,data:e.data??null,
      inputType:e.inputType??null,isComposing:e.isComposing??null,isTrusted:e.isTrusted,
      value:box.value});
    if(type==='keydown'&&e.code==='Space'){
      spaceCount++;
      clearTimeout(timer);
      timer=setTimeout(()=>save('after-space').catch(fail),650);
    }
  });
}
function fail(e){document.querySelector('#status').textContent='ERROR '+e.message;}
next.onclick=async()=>{
  next.disabled=true;
  try{
    clearTimeout(timer);
    await save('before-next');
    if(index+1<batch.rows.length){index++;show();}
    else {box.disabled=true;document.querySelector('#status').textContent='all rows captured';}
  }catch(e){fail(e);}finally{next.disabled=false;}
};
fetch('/batch').then(r=>r.json()).then(b=>{batch=b;show();}).catch(fail);
</script>'''


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--batch', type=Path, default=ROOT/'data/ime-keyboard/batch-001.json')
    p.add_argument('--work', type=Path, default=ROOT/'.research/ime-keyboard/capture-001')
    args = p.parse_args()
    batch = json.loads(args.batch.read_text(encoding='utf-8'))
    args.work.mkdir(parents=True, exist_ok=True)
    archive = args.work/'events.jsonl'
    allowed = {r['id'] for r in batch['rows']}
    records = []
    if archive.exists():
        records = [json.loads(line) for line in archive.read_text(encoding='utf-8').splitlines()]
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, body, content_type='application/json; charset=utf-8', code=200):
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == '/':
                self.send(PAGE.encode(), 'text/html; charset=utf-8')
            elif self.path == '/batch':
                self.send(json.dumps(batch, ensure_ascii=False).encode())
            elif self.path == '/records':
                with lock:
                    self.send(json.dumps(records, ensure_ascii=False).encode())
            else:
                self.send(b'{}', code=404)

        def do_POST(self):
            if self.path != '/capture':
                return self.send(b'{}', code=404)
            # Cross-origin sites must not be able to write into the experiment.
            if self.headers.get('Origin') != f'http://127.0.0.1:{self.server.server_port}':
                return self.send(b'{}', code=403)
            size = int(self.headers.get('Content-Length', 0))
            if not 0 < size <= 524288:
                return self.send(b'{}', code=413)
            body = json.loads(self.rfile.read(size))
            if body.get('row_id') not in allowed or body.get('stage') not in ['after-space', 'before-next']:
                return self.send(b'{}', code=400)
            body['received_at'] = datetime.now(timezone.utc).isoformat()
            with lock:
                with archive.open('a', encoding='utf-8') as f:
                    f.write(json.dumps(body, ensure_ascii=False) + '\n')
                    f.flush()
                records.append(body)
            self.send(b'{"saved":true}')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    address = f'http://127.0.0.1:{server.server_port}/'
    (args.work/'server.json').write_text(json.dumps({'url':address,'batch':str(args.batch),
        'started_at':datetime.now(timezone.utc).isoformat()},indent=2)+'\n',encoding='utf-8')
    print(address, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()

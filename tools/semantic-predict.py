"""Local research-model probe. Requires the cached research artifacts; no network.

Use the CPU research venv. Default: R13 research candidate, not production runtime.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r6',ROOT/'tools/semantic-round6.py')
r6=importlib.util.module_from_spec(spec);spec.loader.exec_module(r6)


def fused(args,folder):
    manifest=r6.read(folder/'manifest.json');selection=r6.read(folder/'selection.json')
    for model in manifest['models'].values():assert r6.sha(Path(model['path']))==model['sha256']
    scratch=ROOT/'.research/semantic-predict';scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as temp:
        work=Path(temp).resolve();assert work.is_relative_to(scratch.resolve())
        r6.save(work/'bases.json',r6.read(folder/'bases.json'));r6.WORK=work
        toks=r6.tokenizers('dual');payload=[]
        for text in args.text:
            values={('z_' if lang=='zh' else 'e_')+name:value for lang,tok in toks.items()
                for name,value in tok(text,truncation=True,max_length=128).items()}
            payload.append({'inputs':values})
        r6.save(work/'inputs.json',payload)
        subprocess.run(['node',str(ROOT/'tools/semantic-fusion-native.mjs'),manifest['models']['round3']['path'],
            manifest['models']['round6']['path'],str(work/'inputs.json'),str(work/'scores.json')],cwd=ROOT,check=True)
        pairs=r6.read(work/'scores.json')['pairs'];scales=selection['scales']
        for text,(first,second) in zip(args.text,pairs):
            lang=r6.r4.language(text);chosen=selection['selected'][lang];alpha=chosen['alpha']
            score=(1-alpha)*first/scales[0]+alpha*second/scales[1]
            print(json.dumps({'text':text,'model':'round8','language':lang,'warning':score>chosen['threshold'],
                'raw_margin':score,'threshold':chosen['threshold'],'adjusted_margin':score-chosen['threshold'],
                'component_margins':[first,second],'alpha':alpha,
                'caveat':'Research fusion; not a probability; <=128 tokens per encoder.'},ensure_ascii=False))


def learned_fused(args,folder):
    manifest=r6.read(folder/'manifest.json');chosen=r6.read(folder/'selection.json')['selected']
    for model in manifest['models'].values():assert r6.sha(Path(model['path']))==model['sha256']
    assert r6.sha(folder/chosen['artifact'])==chosen['artifact_sha256']
    scratch=ROOT/'.research/semantic-predict';scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as temp:
        work=Path(temp).resolve();assert work.is_relative_to(scratch.resolve())
        r6.save(work/'bases.json',r6.read(folder/'bases.json'));r6.WORK=work;toks=r6.tokenizers('dual')
        payload=[{'inputs':{('z_' if lang=='zh' else 'e_')+name:value for lang,tok in toks.items()
            for name,value in tok(text,truncation=True,max_length=128).items()}} for text in args.text]
        r6.save(work/'inputs.json',payload)
        subprocess.run(['node',str(ROOT/'tools/semantic-gate-native.mjs'),'full',manifest['models']['r3']['path'],manifest['models']['r9']['path'],
            str(folder/chosen['artifact']),str(work/'inputs.json'),str(work/'scores.json')],cwd=ROOT,check=True)
        scores=r6.read(work/'scores.json');classes=['normal','noise','needs_context']
        for text,margin,logits in zip(args.text,scores['margins'],scores['logits']):
            lang=r6.r4.language(text);threshold=chosen['thresholds'][lang]
            print(json.dumps({'text':text,'model':'round10','language':lang,'warning':margin>threshold,
                'raw_class':classes[max(range(3),key=lambda i:logits[i])],'raw_margin':margin,'threshold':threshold,'adjusted_margin':margin-threshold,
                'caveat':'Research learned fusion; not a probability; <=128 tokens per encoder.'},ensure_ascii=False))


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--model',choices=['round3','round6','round7','round8','round9','round9-pooled','round10','round11','round12','round13'],default='round13')
    p.add_argument('--package',type=Path,help='Self-contained research package directory; overrides --model')
    p.add_argument('--text',action='append',required=True);args=p.parse_args()
    if args.package:folder=args.package.resolve();args.model='package'
    else:folder=ROOT/'.research'/('semantic-'+('round9' if args.model=='round9-pooled' else args.model))
    if args.model=='round8':fused(args,folder);return
    if args.model=='round10':learned_fused(args,folder);return
    selection=r6.read(folder/('calibration-selection.json' if args.model=='round9-pooled' else 'selection.json'));chosen=selection['selected']
    path=folder/chosen['artifact'];expected=selection['checkpoint_sha256'] if args.model=='round3' else chosen['artifact_sha256']
    assert r6.sha(path)==expected,'Selected model hash changed'
    rows=[{'text':text} for text in args.text]
    scratch=ROOT/'.research/semantic-predict';scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as temp:
        assert Path(temp).resolve().is_relative_to(scratch.resolve())
        r6.WORK=Path(temp)
        if args.model=='round3':
            r6.r4.r2.WORK=Path(temp);scores,native,truncated=r6.r4.r2.node_scores(path,rows,'probe')
            cutoffs=[chosen['cal']['threshold']]*len(rows)
        else:
            bases=r6.read(folder/'bases.json')
            for lang in ['zh','en']:
                source=Path(bases[f'{lang}_folder'])
                if not source.is_absolute():bases[f'{lang}_folder']=str((folder/source).resolve())
            r6.save(Path(temp)/'bases.json',bases)
            mode=chosen.get('mode','dual');scores,native,truncated=r6.node_scores(path,rows,'probe',mode)
            cutoffs=[chosen['thresholds'][r6.r4.language(text)] for text in args.text]
        classes=['normal','noise','needs_context']
        for text,score,threshold,logits in zip(args.text,scores,cutoffs,native['logits']):
            raw_class=('noise' if logits[0]>0 else 'not_obviously_noise') if len(logits)==1 else classes[max(range(3),key=lambda i:logits[i])]
            print(json.dumps({'text':text,'model':args.model,'language':r6.r4.language(text),
                'warning':bool(score>threshold),'raw_class':raw_class,
                'raw_margin':float(score),'threshold':float(threshold),'adjusted_margin':float(score-threshold),
                'caveat':'Research candidate; score is not a calibrated probability; input limited to128 tokens per encoder.'},ensure_ascii=False))
        if truncated:print(json.dumps({'truncated_encoder_inputs':truncated}))


if __name__=='__main__':main()

"""Bounded real ELECTRA fine-tuning benchmark: CPU versus AMD DirectML.

Uses a controlled safetensors export of our own R3 checkpoint and TRAIN inputs.
No held-out labels, drivers, system settings, or saved model weights are changed.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import time
import traceback
import warnings

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT/'.research/semantic-directml'


def run(args):
    import torch
    from transformers import AutoModel, AutoConfig
    from safetensors.torch import load_file
    torch.set_num_threads(4);torch.set_num_interop_threads(1)
    torch.manual_seed(20261110)
    inputs_file = WORK/'inputs.json'
    payload = json.loads(inputs_file.read_text(encoding='utf-8'))
    model_file = WORK/'model.safetensors'
    assert hashlib.sha256(model_file.read_bytes()).hexdigest()==payload['model_safetensors_sha256']
    folder = ROOT/'.research/semantic-screen/hf-cache/models--hfl--chinese-electra-180g-small-discriminator/snapshots/826a243f3f387450ef8d70de9c3d0706d8d8e924'
    config = AutoConfig.from_pretrained(str(folder),local_files_only=True,trust_remote_code=False)
    class ThreeWay(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder=AutoModel.from_config(config,attn_implementation='eager')
            self.drop=torch.nn.Dropout(.1)
            self.head=torch.nn.Linear(config.hidden_size*2,3)
        def forward(self,input_ids,attention_mask,token_type_ids):
            h=self.encoder(input_ids=input_ids,attention_mask=attention_mask,token_type_ids=token_type_ids).last_hidden_state
            m=attention_mask.unsqueeze(-1).to(h.dtype)
            return self.head(self.drop(torch.cat([h[:,0],(h*m).sum(1)/m.sum(1)],1)))
    model=ThreeWay()
    model.load_state_dict(load_file(str(model_file)),strict=True)
    case=payload['cases'][str(args.sequence)]
    inp={k:torch.tensor(v[:args.batch],dtype=torch.long) for k,v in case['inputs'].items()}
    labels=torch.tensor(case['labels'][:args.batch],dtype=torch.long)
    weights=torch.tensor(case['weights'][:args.batch],dtype=torch.float32)
    model.eval()
    # DirectML 0.2.5 cannot index some inference tensors. no_grad keeps
    # ordinary tensor version counters while still disabling autograd here.
    with torch.no_grad():
        reference=model(**inp).cpu()
    devices=[]
    if args.backend=='directml':
        import torch_directml
        devices=[torch_directml.device_name(i) for i in range(torch_directml.device_count())]
        candidates=[i for i,name in enumerate(devices) if '780M' in name]
        if len(candidates)!=1:
            raise RuntimeError(f'Expected exactly one AMD 780M, got {devices}')
        device=torch_directml.device(candidates[0])
    else:
        device=torch.device('cpu')
    print(json.dumps({'phase':'model_to_device','backend':args.backend,'device':str(device),'devices':devices}),flush=True)
    model.to(device)
    inp={k:v.to(device) for k,v in inp.items()}
    labels,weights=labels.to(device),weights.to(device)
    class_weights=torch.tensor([1.5,1.,1.5],device=device)
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter('always')
        optimizer_check=None
        if args.optimizer=='portable-adamw':
            from semantic_device_optim import PortableAdamW, verify_adamw
            optimizer_check=verify_adamw(device)
        with torch.no_grad():
            actual=model(**inp).cpu()
        drift=float((actual-reference).abs().max())
        assert drift<1e-3, f'FP32 logit drift {drift}'
        model.train()
        optimizer=(PortableAdamW(model.parameters()) if args.optimizer=='portable-adamw'
                   else torch.optim.AdamW(model.parameters(),lr=8e-5,weight_decay=.01,foreach=False))
        probe=model.encoder.encoder.layer[0].attention.self.query.weight
        initial=probe.detach().cpu().clone()
        elapsed=[];losses=[];first_gradient_max=None
        for step in range(args.warmup+args.steps):
            tick=time.perf_counter()
            optimizer.zero_grad(set_to_none=True)
            logits=model(**inp)
            loss=(torch.nn.functional.cross_entropy(logits,labels,reduction='none',weight=class_weights)*weights).mean()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(),1.,foreach=False,error_if_nonfinite=True)
            if step==0:
                first_gradient_max=float(probe.grad.detach().cpu().abs().max())
                assert math.isfinite(first_gradient_max) and first_gradient_max>0
            optimizer.step()
            value=float(loss.detach().cpu())
            # Read the last-updated classifier parameter after optimizer.step.
            # On the single DirectML queue this waits for preceding queued work.
            sync=float(model.head.weight.detach()[0,0].cpu())
            assert math.isfinite(value) and math.isfinite(sync)
            duration=time.perf_counter()-tick
            if step>=args.warmup:
                elapsed.append(duration);losses.append(value)
            print(json.dumps({'phase':'step','backend':args.backend,'step':step,'seconds':duration,'loss':value}),flush=True)
        delta=float((probe.detach().cpu()-initial).abs().max())
        assert delta>0 and math.isfinite(delta)
        all_parameters_finite=all(bool(torch.isfinite(p.detach().cpu()).all()) for p in model.parameters())
        assert all_parameters_finite
        warning_text=sorted({str(w.message) for w in captured})
    result={'ok':True,'backend':args.backend,'device':str(device),'device_names':devices,
            'benchmark_script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'optimizer_script_sha256':hashlib.sha256((ROOT/'tools/semantic_device_optim.py').read_bytes()).hexdigest(),
            'torch_version':torch.__version__,'batch':args.batch,'sequence':args.sequence,
            'optimizer':args.optimizer,'optimizer_equivalence_check':optimizer_check,
            'all_final_parameters_finite':all_parameters_finite,
            'warmup_steps':args.warmup,'measured_steps':args.steps,'step_seconds':elapsed,
            'median_step_seconds':statistics.median(elapsed),'mean_step_seconds':statistics.mean(elapsed),
            'examples_per_second':args.batch/statistics.mean(elapsed),'losses':losses,
            'fp32_logit_max_drift_vs_cpu':drift,'backbone_first_gradient_max':first_gradient_max,
            'backbone_weight_max_delta':delta,'warnings':warning_text,
            'model_safetensors_sha256':payload['model_safetensors_sha256'],
            'scope':'FP32 forward + weighted CE + backward + clip_grad_norm + AdamW + host synchronization. Excludes tokenization/load; 4 CPU threads.',
            'caveat':'Short fixed-batch benchmark, not a full convergence or training-quality comparison.'}
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--backend',choices=['cpu','directml'],required=True)
    p.add_argument('--optimizer',choices=['adamw','portable-adamw'],default='adamw')
    p.add_argument('--batch',type=int,choices=[8,32],default=32)
    p.add_argument('--sequence',type=int,choices=[64,128],default=64)
    p.add_argument('--warmup',type=int,choices=[1,2,3],default=2)
    p.add_argument('--steps',type=int,choices=range(1,11),default=5)
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    if args.output.exists():raise FileExistsError('Keep benchmark result immutable')
    try:
        result=run(args)
    except Exception as exc:
        result={'ok':False,'backend':args.backend,'batch':args.batch,'sequence':args.sequence,
                'error_type':type(exc).__name__,'error':str(exc),'traceback':traceback.format_exc()}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False),flush=True)
    if not result['ok']:raise SystemExit(1)

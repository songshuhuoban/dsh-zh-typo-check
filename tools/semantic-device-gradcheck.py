"""Compare real multitask ELECTRA gradients on CPU and DirectML, dropout off."""
import importlib.util
import argparse
import json
import math
from pathlib import Path
import warnings

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.research/semantic-round4'
spec=importlib.util.spec_from_file_location('r4',ROOT/'tools/semantic-round4.py')
r4=importlib.util.module_from_spec(spec);spec.loader.exec_module(r4)


if __name__=='__main__':
    import torch
    import torch_directml
    from safetensors.torch import load_file
    from semantic_device_loss import classification_nll
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--loss',choices=['stock','manual'],default='stock')
    parser.add_argument('--source',choices=['round3','round4'],default='round4')
    parser.add_argument('--output',type=Path,default=WORK/'device-gradient-check.json')
    args=parser.parse_args()
    torch.set_num_threads(4);torch.set_num_interop_threads(1)
    torch.manual_seed(20261110)
    output=args.output;assert not output.exists()
    data,_=r4.frozen();selection=r4.read(WORK/'selection.json')
    cpu,tokenizer=r4.model_and_tokenizer();gpu,_=r4.model_and_tokenizer()
    state=load_file(str(ROOT/'.research/semantic-directml/model.safetensors' if args.source=='round3' else WORK/selection['selected']['torch_checkpoint']))
    missing,unexpected=cpu.load_state_dict(state,strict=False)
    assert not unexpected and (not missing if args.source=='round4' else set(missing)=={'aux.weight','aux.bias'})
    gpu.load_state_dict(cpu.state_dict(),strict=True)
    rows=[]
    for task,label in [('main',0),('main',1),('main',2),('csed',0),('csed',1)]:
        pool=[r for r in data['train'] if r.get('task')==task and r['label']==label and len(tokenizer(r['text'])['input_ids'])<=64]
        rows.extend(pool[:2])
    assert len(rows)==10
    inputs=tokenizer([r['text'] for r in rows],padding=True,return_tensors='pt')
    labels=torch.tensor([r['label'] for r in rows]);weights=torch.tensor([r['weight'] for r in rows])
    aux=torch.tensor([float(r['task']=='csed') for r in rows])
    device=torch_directml.device(0);gpu.to(device)
    losses=[];logits=[]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        for model,target_device in [(cpu,torch.device('cpu')),(gpu,device)]:
            model.eval();model.zero_grad(set_to_none=True)
            inp={k:v.to(target_device) for k,v in inputs.items()}
            target=labels.to(target_device);weight=weights.to(target_device);mask=aux.to(target_device)
            main,other=model.forward_all(**inp)
            cw=torch.tensor([1.5,1.,1.5],device=target_device)
            if args.loss=='manual' and model is gpu:
                one_hot=torch.nn.functional.one_hot(labels,3).float().to(target_device)
                aux_one_hot=torch.nn.functional.one_hot(labels.clamp_max(1),2).float().to(target_device)
                main_loss=classification_nll(main,one_hot,cw)
                aux_loss=classification_nll(other,aux_one_hot)
            else:
                main_loss=torch.nn.functional.cross_entropy(main,target,reduction='none',weight=cw)
                aux_loss=torch.nn.functional.cross_entropy(other,target.clamp_max(1),reduction='none')
            loss=((main_loss*(1-mask)+.25*aux_loss*mask)*weight).mean()
            loss.backward();losses.append(float(loss.detach().cpu()));logits.append(main.detach().cpu())
        groups={}
        for prefix in ['encoder.','head.','aux.']:
            ref_ss=act_ss=dot=error_ss=0.;maximum=0.;n=0
            for (name,left),(other_name,right) in zip(cpu.named_parameters(),gpu.named_parameters()):
                assert name==other_name
                if not name.startswith(prefix):continue
                assert (left.grad is None)==(right.grad is None)
                if left.grad is None:continue
                a=left.grad.detach().cpu().double();b=right.grad.detach().cpu().double()
                assert bool(torch.isfinite(a).all()) and bool(torch.isfinite(b).all())
                ref_ss+=float((a*a).sum());act_ss+=float((b*b).sum());dot+=float((a*b).sum())
                error_ss+=float(((a-b)**2).sum());maximum=max(maximum,float((a-b).abs().max()));n+=a.numel()
            relative=math.sqrt(error_ss)/max(math.sqrt(ref_ss),1e-12)
            cosine=dot/math.sqrt(ref_ss*act_ss) if ref_ss*act_ss else (1. if ref_ss==act_ss==0 else 0.)
            groups[prefix]={'elements':n,'relative_l2_error':relative,'cosine':cosine,'max_abs_error':maximum}
    drift=float((logits[0]-logits[1]).abs().max());loss_error=abs(losses[0]-losses[1])
    valid=drift<.001 and loss_error<.0001 and all(g['relative_l2_error']<.001 and g['cosine']>.99999 for g in groups.values())
    result={'ok':valid,'loss_implementation':args.loss,'weight_source':args.source,'device_name':torch_directml.device_name(0).rstrip('\x00'),'torch':torch.__version__,
            'n':len(rows),'sequence':inputs['input_ids'].shape[1],'dropout_enabled':False,
            'losses_cpu_directml':losses,'loss_abs_error':loss_error,'logits_max_abs_error':drift,
            'gradient_groups':groups,'warnings':sorted({str(w.message) for w in caught}),
            'scope':'One controlled real TRAIN batch and the exact R4 loss; not a stochastic-convergence equivalence claim.'}
    r4.save(output,result);print(json.dumps(result),flush=True)
    if not valid:raise SystemExit(1)

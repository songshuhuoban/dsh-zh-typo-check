"""Stock CPU CE versus stock/fixed DirectML: weights and task masks matter."""
import json
from pathlib import Path
import torch
import torch_directml
from semantic_device_loss import classification_nll

ROOT=Path(__file__).resolve().parents[1]
if __name__=='__main__':
    output=ROOT/'data/semantic-directml-loss-check.json';assert not output.exists()
    x=torch.tensor([[.1,-.3,1.1],[2.,.2,-.1],[-1.,.1,.5],[.5,-.6,.7]])
    y=torch.tensor([0,1,2,0]);cw=torch.tensor([1.5,1.,1.5]);cases={
        'uniform':torch.ones(4),'per_row_weight':torch.tensor([1.,.5,1.,.25]),
        'task_mask':torch.tensor([1.,0.,.25,0.])}
    result={'device':torch_directml.device_name(0).rstrip('\x00'),'torch':torch.__version__,
            'directml':'0.2.5.dev240914','cases':{}}
    for name,weight in cases.items():
        values=[]
        for backend,device,fixed in [('cpu',torch.device('cpu'),False),('directml_stock',torch_directml.device(),False),('directml_fixed',torch_directml.device(),True)]:
            logits=x.to(device).detach().requires_grad_()
            if fixed:
                one_hot=torch.nn.functional.one_hot(y,3).float().to(device)
                losses=classification_nll(logits,one_hot,cw.to(device))
            else:losses=torch.nn.functional.cross_entropy(logits,y.to(device),weight=cw.to(device),reduction='none')
            loss=(losses*weight.to(device)).mean();loss.backward()
            values.append({'backend':backend,'loss':float(loss.detach().cpu()),'gradient':logits.grad.cpu().tolist()})
        reference=torch.tensor(values[0]['gradient'])
        for record in values[1:]:record['max_abs_gradient_error_vs_cpu']=float((torch.tensor(record['gradient'])-reference).abs().max())
        assert values[2]['max_abs_gradient_error_vs_cpu']<1e-6
        if name!='uniform':assert values[1]['max_abs_gradient_error_vs_cpu']>.01
        result['cases'][name]=values
    output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result),flush=True)

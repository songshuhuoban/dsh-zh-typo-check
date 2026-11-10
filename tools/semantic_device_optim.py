"""Dense FP32 AdamW without lerp, for the DirectML research benchmark only."""
import math
import torch


class PortableAdamW(torch.optim.Optimizer):
    """Our fixed non-AMSGrad AdamW setup; not a general AdamW replacement."""
    def __init__(self, params, lr=8e-5, weight_decay=.01):
        super().__init__(params, dict(lr=lr, weight_decay=weight_decay,
                                    betas=(.9, .999), eps=1e-8))

    @torch.no_grad()
    def step(self, closure=None):
        if closure is not None:
            raise ValueError('Closures are outside this benchmark setup')
        for group in self.param_groups:
            beta1, beta2 = group['betas']
            for parameter in group['params']:
                gradient = parameter.grad
                if gradient is None:
                    continue
                if gradient.is_sparse or parameter.is_complex() or parameter.dtype != torch.float32:
                    raise ValueError('This implementation is restricted to dense FP32 parameters')
                state = self.state[parameter]
                if not state:
                    state.update(step=0, exp_avg=torch.zeros_like(parameter),
                                 exp_avg_sq=torch.zeros_like(parameter))
                state['step'] += 1
                mean, variance = state['exp_avg'], state['exp_avg_sq']
                parameter.mul_(1-group['lr']*group['weight_decay'])
                # PyTorch's lerp_ is mathematically the same update but falls
                # back to CPU with the pinned DirectML backend.
                mean.mul_(beta1).add_(gradient, alpha=1-beta1)
                variance.mul_(beta2).addcmul_(gradient, gradient, value=1-beta2)
                denominator = (variance.sqrt()/math.sqrt(1-beta2**state['step'])).add_(group['eps'])
                parameter.addcdiv_(mean, denominator,
                                  value=-group['lr']/(1-beta1**state['step']))


def verify_adamw(device):
    """Compare 10 identical-gradient updates with stock CPU AdamW."""
    generator = torch.Generator().manual_seed(20261110)
    values = [torch.randn(shape, generator=generator) for shape in [(17, 13), (3,), (512, 16)]]
    reference = [torch.nn.Parameter(value.clone()) for value in values]
    actual = [torch.nn.Parameter(value.to(device)) for value in values]
    stock = torch.optim.AdamW(reference, lr=8e-5, weight_decay=.01, foreach=False)
    portable = PortableAdamW(actual)
    for step in range(10):
        for left, right in zip(reference, actual):
            gradient = torch.randn(left.shape, generator=generator)*(1e-4 if step % 2 else .1)
            left.grad = gradient
            right.grad = gradient.to(device)
        stock.step()
        portable.step()
    error = max(float((left.detach()-right.detach().cpu()).abs().max())
                for left, right in zip(reference, actual))
    assert error < 1e-6, f'AdamW compatibility max absolute parameter error {error}'
    return {'steps': 10, 'max_abs_parameter_error_vs_stock_cpu_adamw': error, 'tolerance': 1e-6}

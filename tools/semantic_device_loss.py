"""Dense classification NLL with a validated DirectML weighted backward path.

The pinned DirectML CE(reduction='none') ignores upstream per-row weights/masks.
Targets are one-hot tensors prepared on CPU and copied to the training device.
"""
import torch


def classification_nll(logits,one_hot_targets,class_weights=None):
    target=one_hot_targets if class_weights is None else one_hot_targets*class_weights
    return -(torch.nn.functional.log_softmax(logits,dim=-1)*target).sum(-1)

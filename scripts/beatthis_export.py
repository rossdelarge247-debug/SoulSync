"""WIP (grid v6, not wired in yet). Dev-only: needs torch and beat_this (MIT), never the app.

Export Beat This! to ONNX with the long (time-directed) attention computed a few maps at a time.
usage: scripts/beatthis_export.py <torch.pt | official .ckpt> out.onnx [maps_per_group]
Same maths as scaled_dot_product_attention; only the peak memory changes."""
import os
import sys

import torch

from beat_this.model import roformer  # noqa: E402
from beat_this.model.beat_tracker import BeatThis  # noqa: E402

src, out = sys.argv[1], sys.argv[2]
MAPS = int(sys.argv[3]) if len(sys.argv) > 3 else 4
LONG = 256  # sequences longer than this (time attention) are split


def attend(self, q, k, v):
    b, h, n, d = q.shape
    if not getattr(self, "split", False):
        return torch.nn.functional.scaled_dot_product_attention(q, k, v)
    bh = int(b) * int(h)
    q2, k2, v2 = (t.reshape(bh, n, d) for t in (q, k, v))
    scale = float(int(d)) ** -0.5
    outs = []
    for s in range(0, bh, MAPS):
        e = min(bh, s + MAPS)
        w = torch.softmax(torch.matmul(q2[s:e] * scale, k2[s:e].transpose(-1, -2)), dim=-1)
        outs.append(torch.matmul(w, v2[s:e]))
    return torch.cat(outs, 0).reshape(b, h, n, d)


roformer.Attend.forward = attend

if src.endswith(".ckpt"):
    ck = torch.load(src, map_location="cpu", weights_only=True)
    import inspect
    hp = {k: v for k, v in ck["hyper_parameters"].items() if k in set(inspect.signature(BeatThis).parameters)}
    model = BeatThis(**hp)
    sd = {k.replace("model.", "", 1): v for k, v in ck["state_dict"].items()}
    model.load_state_dict(sd)
else:
    ck = torch.load(src, map_location="cpu", weights_only=True)
    model = BeatThis(**ck["hparams"])
    model.load_state_dict(ck["state_dict"])
model.eval()
for name, mod in model.named_modules():
    if name.endswith("attnT.attend"):  # the frontend's time-directed attention: (freq bins x heads) maps of time x time
        mod.split = True
        print("split", name)


class W(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        o = self.m(x)
        return o["beat"], o["downbeat"]


with torch.no_grad():
    torch.onnx.export(W(model), torch.randn(1, 1500, 128), out, dynamo=False, input_names=["mel"],
                      output_names=["beat", "downbeat"], opset_version=17,
                      dynamic_axes={"mel": {1: "time"}, "beat": {1: "time"}, "downbeat": {1: "time"}})
print("exported", out, os.path.getsize(out))

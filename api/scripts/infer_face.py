#!/usr/bin/env python3
"""
TruthShield Face Analysis - PyTorch inference sidecar.

Architecture:
  - ResNet18 backbone (pretrained ImageNet weights, frozen during training)
  - Custom FC head: nn.Linear(512, 2)  — only this head is in the checkpoint

Usage (persistent mode):
  python infer_face.py <model_path>

Protocol:
  - On startup, prints {"status": "ready"} to stdout and flushes.
  - Then reads one JSON line per request from stdin:
      {"image_b64": "<base64-encoded image bytes>"}
  - Prints one JSON line response to stdout:
      {"prediction": "real"|"fake", "scores": {"fake": 0.12, "real": 0.88}, "confidence": 0.88}
  - On error:
      {"error": "<message>"}
"""

import sys
import json
import io
import base64
import os

# ── Silence torchvision download progress bars ────────────────────────────────
os.environ.setdefault("TQDM_DISABLE", "1")

import torch
import torch.nn as nn
import torchvision.models as models
import torchvision.transforms as transforms
from PIL import Image

# ── Model path ────────────────────────────────────────────────────────────────
MODEL_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "models", "deepfake_head.pth"
)

# ── Load model ────────────────────────────────────────────────────────────────
try:
    # 1. Load pretrained ResNet18 backbone (downloads ~44 MB on first run)
    backbone = models.resnet18(weights=models.ResNet18_Weights.IMAGENET1K_V1)

    # 2. Replace FC head to match training architecture
    backbone.fc = nn.Linear(backbone.fc.in_features, 2)

    # 3. Load only the trained FC head weights from the small checkpoint
    head_state = torch.load(MODEL_PATH, map_location="cpu")
    backbone.fc.load_state_dict(head_state)

    # 4. Eval mode (disable dropout/batchnorm training behaviour)
    backbone.eval()
except FileNotFoundError:
    print(json.dumps({"error": f"Model checkpoint not found at: {MODEL_PATH}"}), flush=True)
    sys.exit(1)
except Exception as e:
    print(json.dumps({"error": f"Model load failed: {str(e)}"}), flush=True)
    sys.exit(1)

# ── Preprocessing ─────────────────────────────────────────────────────────────
transform = transforms.Compose([
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

# Class order matches ImageFolder alphabetical scan: 0 = fake, 1 = real
CLASSES = ["fake", "real"]

# ── Signal ready ──────────────────────────────────────────────────────────────
print(json.dumps({"status": "ready"}), flush=True)

# ── Inference loop ────────────────────────────────────────────────────────────
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        img_bytes = base64.b64decode(req["image_b64"])
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        tensor = transform(img).unsqueeze(0)  # shape: [1, 3, 224, 224]

        with torch.no_grad():
            logits = backbone(tensor)
            probs = torch.softmax(logits, dim=1)[0].tolist()

        pred_idx = int(torch.argmax(logits, dim=1).item())
        result = {
            "prediction": CLASSES[pred_idx],
            "scores": {
                "fake": round(probs[0], 4),
                "real": round(probs[1], 4),
            },
            "confidence": round(max(probs), 4),
        }
        print(json.dumps(result), flush=True)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), flush=True)

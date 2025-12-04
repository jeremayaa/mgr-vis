from flask import Flask, render_template, send_file, abort
import numpy as np
from io import BytesIO
from PIL import Image
import json
import os

# ---------- Paths ----------
IMG_PATH = os.path.join("images", "ct_volume.npy")
SEG_PATH = os.path.join("images", "rtstruct_labels.npy")
LABELS_PATH = os.path.join("images", "labels.json")

# ---------- Load data once ----------
img_vol = np.load(IMG_PATH).astype(np.float32)   # (953, 512, 512) CT
seg_vol = np.load(SEG_PATH).astype(np.int16)     # (953, 512, 512) mask
num_slices = img_vol.shape[0]

with open(LABELS_PATH, "r") as f:
    labels_raw = json.load(f)["labels"]  # dict with string keys

# convert keys to int for easier use
labels_dict = {int(k): v for k, v in labels_raw.items()}

# Keep only labels that actually appear in seg_vol (optional but nice)
present_labels = set(np.unique(seg_vol).tolist())
label_list = [
    {
        "id": lid,
        "name": labels_dict[lid]["name"],
        "color_rgb": labels_dict[lid]["color_rgb"],
    }
    for lid in sorted(labels_dict.keys())
    if lid in present_labels and lid != 0
]

app = Flask(__name__)


# ---------- Image creation helpers (NO matplotlib) ----------

def make_ct_png(slice_idx: int) -> BytesIO:
    """Return grayscale CT slice as PNG (PIL, no matplotlib)."""
    ct_slice = img_vol[slice_idx]  # 2D array

    # Normalize with percentiles for decent contrast
    vmin, vmax = np.percentile(ct_slice, (1, 99))
    if vmax <= vmin:  # fallback
        vmax = vmin + 1.0

    norm = (ct_slice - vmin) / (vmax - vmin)
    norm = np.clip(norm, 0.0, 1.0)
    uint8 = (norm * 255).astype(np.uint8)

    img = Image.fromarray(uint8, mode="L")  # grayscale

    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf


def make_mask_png(slice_idx: int, label_id: int) -> BytesIO:
    """
    Return transparent RGBA mask for a given label on a slice.
    Only pixels == label_id get the label color and alpha; others are transparent.
    """
    h, w = seg_vol.shape[1], seg_vol.shape[2]
    # fully transparent to start
    rgba = np.zeros((h, w, 4), dtype=np.uint8)

    if label_id in labels_dict:
        seg_slice = seg_vol[slice_idx]
        mask = (seg_slice == label_id)

        if mask.any():
            color = labels_dict[label_id]["color_rgb"]  # [R,G,B]
            rgba[..., 0] = color[0]
            rgba[..., 1] = color[1]
            rgba[..., 2] = color[2]
            # alpha: 0 where off, 120 where mask==True
            rgba[..., 3] = mask.astype(np.uint8) * 120

    img = Image.fromarray(rgba, mode="RGBA")

    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf


# ---------- Flask routes ----------

@app.route("/")
def index():
    # Pass number of slices and labels to template
    return render_template(
        "index.html",
        num_slices=num_slices,
        labels=label_list,
    )


@app.route("/slice_bg/<int:slice_idx>")
def slice_bg(slice_idx):
    if slice_idx < 0 or slice_idx >= num_slices:
        abort(404, description="Slice index out of range")
    buf = make_ct_png(slice_idx)
    return send_file(buf, mimetype="image/png")


@app.route("/slice_mask/<int:slice_idx>/<int:label_id>")
def slice_mask(slice_idx, label_id):
    if slice_idx < 0 or slice_idx >= num_slices:
        abort(404, description="Slice index out of range")
    buf = make_mask_png(slice_idx, label_id)
    return send_file(buf, mimetype="image/png")


if __name__ == "__main__":
    # http://127.0.0.1:5000
    app.run(host="127.0.0.1", port=5000, debug=True)

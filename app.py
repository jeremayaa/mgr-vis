from flask import Flask, render_template, send_file, abort, request, jsonify
import numpy as np
from io import BytesIO
from PIL import Image
import json
import os
import socket
import qrcode

# ---------- Paths ----------
IMG_PATH = os.path.join("images", "ct_volume.npy")
SEG_PATH = os.path.join("images", "rtstruct_labels.npy")
SEG_EDITED_PATH = os.path.join("images", "edited_rtstruct_labels.npy")
LABELS_PATH = os.path.join("images", "labels.json")

# ---------- Load data once ----------
img_vol = np.load(IMG_PATH).astype(np.float32)   # (953, 512, 512) CT

# Prefer edited mask if it exists, otherwise original
if os.path.exists(SEG_EDITED_PATH):
    print(f"Loading edited segmentation from {SEG_EDITED_PATH}")
    seg_vol = np.load(SEG_EDITED_PATH).astype(np.int16)
else:
    print(f"Loading original segmentation from {SEG_PATH}")
    seg_vol = np.load(SEG_PATH).astype(np.int16)

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

def apply_strokes_to_slice(seg_slice: np.ndarray, label_id: int, strokes: list) -> None:
    """
    Modify seg_slice in-place based on strokes.
    - seg_slice: 2D (H, W) view into seg_vol[slice_idx]
    - label_id: current label we are editing (for pen mode)
    - strokes: list of {mode, brushSize, points: [{x, y}, ...]}
    """
    h, w = seg_slice.shape

    def apply_brush(row: int, col: int, radius: int, mode: str):
        if row < 0 or row >= h or col < 0 or col >= w:
            return
        r0 = max(0, row - radius)
        r1 = min(h, row + radius + 1)
        c0 = max(0, col - radius)
        c1 = min(w, col + radius + 1)

        if mode == "pen":
            seg_slice[r0:r1, c0:c1] = label_id
        elif mode == "rubber":
            seg_slice[r0:r1, c0:c1] = 0

    for stroke in strokes:
        mode = stroke.get("mode", "pen")
        brush_size = int(stroke.get("brushSize", 5))
        radius = max(1, brush_size // 2)

        points = stroke.get("points", [])
        if not points:
            continue

        # Walk through consecutive point pairs and interpolate
        prev_pt = None
        for pt in points:
            x = pt.get("x")
            y = pt.get("y")
            if x is None or y is None:
                continue

            if prev_pt is None:
                # First point of stroke
                row = int(round(y))
                col = int(round(x))
                apply_brush(row, col, radius, mode)
                prev_pt = (x, y)
                continue

            x0, y0 = prev_pt
            x1, y1 = x, y

            dx = x1 - x0
            dy = y1 - y0
            # number of steps = max delta in pixels, at least 1
            steps = int(max(abs(dx), abs(dy)))
            if steps == 0:
                row = int(round(y1))
                col = int(round(x1))
                apply_brush(row, col, radius, mode)
                prev_pt = (x1, y1)
                continue

            for i in range(1, steps + 1):
                t = i / steps
                xi = x0 + t * dx
                yi = y0 + t * dy
                row = int(round(yi))
                col = int(round(xi))
                apply_brush(row, col, radius, mode)

            prev_pt = (x1, y1)

def save_segmentation() -> None:
    """
    Save the current seg_vol to the edited segmentation file.
    """
    np.save(SEG_EDITED_PATH, seg_vol)
    print(f"Saved edited segmentation to {SEG_EDITED_PATH}")

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

@app.route("/api/slice_edit/<int:slice_idx>/<int:label_id>", methods=["POST"])
def slice_edit(slice_idx, label_id):
    if slice_idx < 0 or slice_idx >= num_slices:
        abort(400, description="Slice index out of range")

    data = request.get_json(silent=True) or {}
    strokes = data.get("strokes", [])

    if not isinstance(strokes, list) or not strokes:
        return jsonify({"status": "no_strokes"}), 200

    # seg_slice is a view into seg_vol, so modifications are in-place
    seg_slice = seg_vol[slice_idx]
    apply_strokes_to_slice(seg_slice, label_id, strokes)

    return jsonify(
        {
            "status": "ok",
            "slice_idx": slice_idx,
            "label_id": label_id,
            "num_strokes": len(strokes),
            "saved_to": SEG_EDITED_PATH,
        }
    )

@app.route("/api/save_all", methods=["POST"])
def save_all():
    save_segmentation()
    return jsonify({"status": "ok", "path": SEG_EDITED_PATH})


if __name__ == "__main__":
    # Helper: get local IP visible to your LAN (not 127.0.0.1)
    def get_local_ip():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            # doesn't actually send data, just used to get the right interface
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        finally:
            s.close()
        return ip

    port = 5050
    ip = get_local_ip()
    url = f"http://{ip}:{port}/"

    print("\nOpen this URL on devices in the same network:")
    print(url)
    print("\nScan this QR code:\n")

    # Generate and print QR code in terminal
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.make(fit=True)
    # ASCII QR in terminal
    qr.print_ascii(invert=True)  # invert=True looks better on dark terminals

    # Run on all interfaces so other devices can connect
    app.run(host="0.0.0.0", port=port, debug=False)

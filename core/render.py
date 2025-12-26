import numpy as np
from io import BytesIO
from PIL import Image


def ct_slice_to_png(img_vol: np.ndarray, slice_idx: int) -> BytesIO:
    ct_slice = img_vol[slice_idx]

    vmin, vmax = np.percentile(ct_slice, (1, 99))
    if vmax <= vmin:
        vmax = vmin + 1.0

    norm = (ct_slice - vmin) / (vmax - vmin)
    norm = np.clip(norm, 0.0, 1.0)
    uint8 = (norm * 255).astype(np.uint8)

    img = Image.fromarray(uint8, mode="L")
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf


def mask_slice_to_png(seg_vol: np.ndarray, labels_dict: dict, slice_idx: int, label_id: int) -> BytesIO:
    h, w = seg_vol.shape[1], seg_vol.shape[2]
    rgba = np.zeros((h, w, 4), dtype=np.uint8)

    if label_id in labels_dict:
        seg_slice = seg_vol[slice_idx]
        mask = (seg_slice == label_id)
        if mask.any():
            color = labels_dict[label_id]["color_rgb"]
            rgba[..., 0] = color[0]
            rgba[..., 1] = color[1]
            rgba[..., 2] = color[2]
            rgba[..., 3] = mask.astype(np.uint8) * 120

    img = Image.fromarray(rgba, mode="RGBA")
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf

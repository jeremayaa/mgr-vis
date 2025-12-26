import json
import numpy as np
from pathlib import Path


def load_ct_volume(path: Path) -> np.ndarray:
    return np.load(path).astype(np.float32)


def load_segmentation(path: Path) -> np.ndarray:
    return np.load(path).astype(np.int16)


def load_labels(path: Path) -> dict:
    with open(path, "r") as f:
        labels_raw = json.load(f)["labels"]
    return {int(k): v for k, v in labels_raw.items()}


def build_label_list(labels_dict: dict, seg_vol: np.ndarray) -> list[dict]:
    present_labels = set(np.unique(seg_vol).tolist())
    label_list = []
    for lid in sorted(labels_dict.keys()):
        if lid == 0:
            continue
        if lid not in present_labels:
            continue
        label_list.append(
            {
                "id": lid,
                "name": labels_dict[lid]["name"],
                "color_rgb": labels_dict[lid]["color_rgb"],
            }
        )
    return label_list

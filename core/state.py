import numpy as np
from pathlib import Path

from core.dataset import load_ct_volume, load_segmentation, load_labels, build_label_list
from core.render import ct_slice_to_png, mask_slice_to_png
from core.editing import apply_strokes_to_slice
from core.history import EditHistory


class EditorState:
    def __init__(self, img_path: Path, seg_path: Path, labels_path: Path, edits_log_path: Path):
        self.img_path = img_path
        self.seg_path = seg_path
        self.labels_path = labels_path
        self.edits_log_path = edits_log_path

        self.img_vol = load_ct_volume(self.img_path)
        self.seg_vol = load_segmentation(self.seg_path)
        self.num_slices = int(self.img_vol.shape[0])

        self.labels_dict = load_labels(self.labels_path)
        self.label_list = build_label_list(self.labels_dict, self.seg_vol)

        self.history = EditHistory()
        n = self.history.load_and_replay(self.seg_vol, self.edits_log_path)
        if n:
            print(f"Replayed {n} ops from {self.edits_log_path}")

    def get_ct_png(self, slice_idx: int):
        return ct_slice_to_png(self.img_vol, slice_idx)

    def get_mask_png(self, slice_idx: int, label_id: int):
        return mask_slice_to_png(self.seg_vol, self.labels_dict, slice_idx, label_id)

    def apply_edit(self, slice_idx: int, label_id: int, strokes: list) -> dict:
        if slice_idx < 0 or slice_idx >= self.num_slices:
            raise ValueError("Slice index out of range")

        seg_slice = self.seg_vol[slice_idx]
        before = seg_slice.copy()

        apply_strokes_to_slice(seg_slice, label_id, strokes)

        after = seg_slice
        changed = (before != after)
        flat_idx = np.flatnonzero(changed.ravel())
        if flat_idx.size == 0:
            return {"status": "no_change"}

        old_vals = before.ravel()[flat_idx]
        new_vals = after.ravel()[flat_idx]

        op = {
            "slice_idx": int(slice_idx),
            "flat_idx": flat_idx.astype(np.int32, copy=True),
            "old_vals": old_vals.astype(np.int16, copy=True),
            "new_vals": new_vals.astype(np.int16, copy=True),
        }
        self.history.push(op)

        return {"status": "ok", "num_pixels": int(flat_idx.size)}

    def undo(self) -> dict:
        op = self.history.undo(self.seg_vol)
        if op is None:
            return {"status": "empty"}
        return {"status": "ok", "slice_idx": int(op["slice_idx"])}

    def redo(self) -> dict:
        op = self.history.redo(self.seg_vol)
        if op is None:
            return {"status": "empty"}
        return {"status": "ok", "slice_idx": int(op["slice_idx"])}

    def save_log(self) -> dict:
        self.history.save_npz(self.edits_log_path)
        return {"status": "ok", "path": str(self.edits_log_path), "num_ops": len(self.history.undo_stack)}

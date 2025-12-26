import numpy as np
from pathlib import Path


class EditHistory:
    def __init__(self):
        self.undo_stack = []
        self.redo_stack = []

    def push(self, op: dict) -> None:
        self.undo_stack.append(op)
        self.redo_stack.clear()

    def can_undo(self) -> bool:
        return len(self.undo_stack) > 0

    def can_redo(self) -> bool:
        return len(self.redo_stack) > 0

    @staticmethod
    def _apply_op(seg_vol: np.ndarray, op: dict, direction: str) -> None:
        z = int(op["slice_idx"])
        idx = op["flat_idx"]
        vals = op["old_vals"] if direction == "undo" else op["new_vals"]
        sl = seg_vol[z].ravel()
        sl[idx] = vals

    def undo(self, seg_vol: np.ndarray) -> dict | None:
        if not self.undo_stack:
            return None
        op = self.undo_stack.pop()
        self._apply_op(seg_vol, op, "undo")
        self.redo_stack.append(op)
        return op

    def redo(self, seg_vol: np.ndarray) -> dict | None:
        if not self.redo_stack:
            return None
        op = self.redo_stack.pop()
        self._apply_op(seg_vol, op, "redo")
        self.undo_stack.append(op)
        return op

    def save_npz(self, path: Path) -> None:
        ops = self.undo_stack
        n = len(ops)

        slice_idx = np.empty(n, dtype=np.int16)
        starts = np.zeros(n + 1, dtype=np.int64)

        total = 0
        for i, op in enumerate(ops):
            m = int(op["flat_idx"].size)
            slice_idx[i] = int(op["slice_idx"])
            starts[i] = total
            total += m
        starts[n] = total

        idxs = np.empty(total, dtype=np.int32)
        old = np.empty(total, dtype=np.int16)
        new = np.empty(total, dtype=np.int16)

        cursor = 0
        for op in ops:
            fi = op["flat_idx"]
            m = int(fi.size)
            idxs[cursor:cursor + m] = fi
            old[cursor:cursor + m] = op["old_vals"]
            new[cursor:cursor + m] = op["new_vals"]
            cursor += m

        np.savez_compressed(path, slice_idx=slice_idx, starts=starts, idxs=idxs, old=old, new=new)

    def load_and_replay(self, seg_vol: np.ndarray, path: Path) -> int:
        if not path.exists():
            return 0

        data = np.load(path)
        slice_idx = data["slice_idx"]
        starts = data["starts"]
        idxs = data["idxs"]
        old = data["old"]
        new = data["new"]

        self.undo_stack.clear()
        self.redo_stack.clear()

        for i in range(slice_idx.shape[0]):
            a = int(starts[i])
            b = int(starts[i + 1])

            op = {
                "slice_idx": int(slice_idx[i]),
                "flat_idx": idxs[a:b].astype(np.int32, copy=True),
                "old_vals": old[a:b].astype(np.int16, copy=True),
                "new_vals": new[a:b].astype(np.int16, copy=True),
            }
            # replay forward
            self._apply_op(seg_vol, op, "redo")
            self.undo_stack.append(op)

        return len(self.undo_stack)

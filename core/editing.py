import numpy as np
from PIL import Image, ImageDraw


def _apply_brush(seg_slice: np.ndarray, row: int, col: int, radius: int, mode: str, label_id: int):
    h, w = seg_slice.shape
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


def apply_strokes_to_slice(seg_slice: np.ndarray, label_id: int, strokes: list) -> None:
    """
    Modifies seg_slice in-place.
    Expects stroke points in IMAGE coordinates (x,y).
    Supports:
      - pen, rubber
      - lasso_pen, lasso_rubber (polygon fill)
    """
    h, w = seg_slice.shape

    for stroke in strokes:
        mode = stroke.get("mode", "pen")
        brush_size = int(stroke.get("brushSize", 5))
        radius = max(1, brush_size // 2)

        points = stroke.get("points", [])
        if not points:
            continue

        # ---- LASSO tools ----
        if mode in ("lasso_pen", "lasso_rubber"):
            if len(points) < 3:
                continue

            poly = []
            for pt in points:
                x = pt.get("x")
                y = pt.get("y")
                if x is None or y is None:
                    continue
                poly.append((float(x), float(y)))

            if len(poly) < 3:
                continue

            pil_mask = Image.new("L", (w, h), 0)  # (width, height)
            draw = ImageDraw.Draw(pil_mask)
            draw.polygon(poly, outline=1, fill=1)
            mask = (np.array(pil_mask, dtype=np.uint8) > 0)

            if mode == "lasso_pen":
                seg_slice[mask] = label_id
            else:
                seg_slice[mask] = 0
            continue

        # ---- Freehand pen/rubber ----
        prev_pt = None
        for pt in points:
            x = pt.get("x")
            y = pt.get("y")
            if x is None or y is None:
                continue

            if prev_pt is None:
                _apply_brush(seg_slice, int(round(y)), int(round(x)), radius, mode, label_id)
                prev_pt = (x, y)
                continue

            x0, y0 = prev_pt
            x1, y1 = x, y
            dx = x1 - x0
            dy = y1 - y0
            steps = int(max(abs(dx), abs(dy)))

            if steps == 0:
                _apply_brush(seg_slice, int(round(y1)), int(round(x1)), radius, mode, label_id)
                prev_pt = (x1, y1)
                continue

            for i in range(1, steps + 1):
                t = i / steps
                xi = x0 + t * dx
                yi = y0 + t * dy
                _apply_brush(seg_slice, int(round(yi)), int(round(xi)), radius, mode, label_id)

            prev_pt = (x1, y1)

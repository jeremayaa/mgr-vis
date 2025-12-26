from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]  # project root

IMG_PATH = BASE_DIR / "images" / "ct_volume.npy"
SEG_PATH = BASE_DIR / "images" / "rtstruct_labels.npy"
LABELS_PATH = BASE_DIR / "images" / "labels.json"

# Option B edit log (sparse-ish ops packed in one npz)
EDITS_LOG_PATH = BASE_DIR / "images" / "edits_log.npz"
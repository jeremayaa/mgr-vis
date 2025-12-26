from flask import Flask
from server.config import IMG_PATH, SEG_PATH, LABELS_PATH, EDITS_LOG_PATH
from core.state import EditorState
from server.routes import bp
from pathlib import Path

def create_app() -> Flask:
    root = Path(__file__).resolve().parents[1]  # project root
    app = Flask(
        __name__,
        template_folder=str(root / "templates"),
        static_folder=str(root / "static"),
    )

    # One loaded dataset / editor state (single-case app)
    app.state = EditorState(
        img_path=IMG_PATH,
        seg_path=SEG_PATH,
        labels_path=LABELS_PATH,
        edits_log_path=EDITS_LOG_PATH,
    )

    app.register_blueprint(bp)
    return app

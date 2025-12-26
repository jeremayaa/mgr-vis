from flask import Blueprint, render_template, send_file, abort, request, jsonify, current_app

bp = Blueprint("main", __name__)


@bp.route("/")
def index():
    st = current_app.state
    return render_template("index.html", num_slices=st.num_slices, labels=st.label_list)


@bp.route("/slice_bg/<int:slice_idx>")
def slice_bg(slice_idx: int):
    st = current_app.state
    if slice_idx < 0 or slice_idx >= st.num_slices:
        abort(404, description="Slice index out of range")
    buf = st.get_ct_png(slice_idx)
    return send_file(buf, mimetype="image/png")


@bp.route("/slice_mask/<int:slice_idx>/<int:label_id>")
def slice_mask(slice_idx: int, label_id: int):
    st = current_app.state
    if slice_idx < 0 or slice_idx >= st.num_slices:
        abort(404, description="Slice index out of range")
    buf = st.get_mask_png(slice_idx, label_id)
    return send_file(buf, mimetype="image/png")


@bp.route("/api/slice_edit/<int:slice_idx>/<int:label_id>", methods=["POST"])
def slice_edit(slice_idx: int, label_id: int):
    st = current_app.state
    data = request.get_json(silent=True) or {}
    strokes = data.get("strokes", [])

    if not isinstance(strokes, list) or not strokes:
        return jsonify({"status": "no_strokes"}), 200

    try:
        res = st.apply_edit(slice_idx, label_id, strokes)
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400

    return jsonify(
        {
            **res,
            "slice_idx": slice_idx,
            "label_id": label_id,
            "num_strokes": len(strokes),
        }
    ), 200


@bp.route("/api/undo", methods=["POST"])
def api_undo():
    st = current_app.state
    return jsonify(st.undo()), 200


@bp.route("/api/redo", methods=["POST"])
def api_redo():
    st = current_app.state
    return jsonify(st.redo()), 200


@bp.route("/api/save_all", methods=["POST"])
def save_all():
    st = current_app.state
    return jsonify(st.save_log()), 200

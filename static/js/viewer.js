// static/js/viewer.js

(() => {
  "use strict";

  function parseNumber(val, fallback = 0) {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function cacheBuster() {
    return `?_=${Date.now()}`;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  class ApiClient {
    async postJson(url, bodyObj) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj ?? {}),
      });
      return await res.json();
    }

    async postEmpty(url) {
      const res = await fetch(url, { method: "POST" });
      return await res.json();
    }
  }

  class ViewState {
    constructor(numSlices) {
      this.numSlices = numSlices;
      this.z = null;
      this.labelId = "";
      this.zoom = 0; // log2 scale
      this.panX = 0;
      this.panY = 0;
    }

    clampZ(z) {
      if (!Number.isFinite(z)) return 0;
      return Math.max(0, Math.min(this.numSlices - 1, z));
    }

    getScale() {
      return Math.pow(2, this.zoom);
    }

    applyPatch(patch) {
      Object.assign(this, patch);
    }
  }

  class CanvasRenderer {
    constructor(ctCanvas, ctCtx, maskCanvas, maskCtx, strokesCanvas, strokesCtx) {
      this.ctCanvas = ctCanvas;
      this.ctCtx = ctCtx;

      this.maskCanvas = maskCanvas;
      this.maskCtx = maskCtx;

      this.strokesCanvas = strokesCanvas;
      this.strokesCtx = strokesCtx;
    }

    setCanvasSize(w, h) {
      this.ctCanvas.width = w;
      this.ctCanvas.height = h;

      this.maskCanvas.width = w;
      this.maskCanvas.height = h;

      this.strokesCanvas.width = w;
      this.strokesCanvas.height = h;
    }

    imageToCanvas(viewState, xImg, yImg, imgW, imgH) {
      const s = viewState.getScale();
      const cw = this.ctCanvas.width;
      const ch = this.ctCanvas.height;

      const tx = cw / 2 + viewState.panX - (s * imgW) / 2;
      const ty = ch / 2 + viewState.panY - (s * imgH) / 2;

      return { x: s * xImg + tx, y: s * yImg + ty };
    }

    clearCt() {
      this.ctCtx.clearRect(0, 0, this.ctCanvas.width, this.ctCanvas.height);
    }

    clearMask() {
      this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    }

    // Why needed: preview is re-rendered each frame from vector buffer,
    // so we clear the layer to avoid "accumulated ink".
    clearStrokesLayer() {
      this.strokesCtx.clearRect(0, 0, this.strokesCanvas.width, this.strokesCanvas.height);
    }

    applyViewTransform(ctx, viewState, imgW, imgH) {
      const s = viewState.getScale();
      const cw = this.ctCanvas.width;
      const ch = this.ctCanvas.height;

      const tx = cw / 2 + viewState.panX - (s * imgW) / 2;
      const ty = ch / 2 + viewState.panY - (s * imgH) / 2;

      ctx.setTransform(s, 0, 0, s, tx, ty);
    }

    drawCt(viewState, ctImage) {
      if (!ctImage) return;
      this.clearCt();
      this.applyViewTransform(this.ctCtx, viewState, ctImage.width, ctImage.height);
      this.ctCtx.drawImage(ctImage, 0, 0);
      this.ctCtx.setTransform(1, 0, 0, 1, 0, 0);
    }

    drawMask(viewState, maskImage) {
      if (!maskImage || !viewState.labelId) {
        this.clearMask();
        return;
      }

      this.clearMask();
      this.applyViewTransform(this.maskCtx, viewState, maskImage.width, maskImage.height);
      this.maskCtx.drawImage(maskImage, 0, 0);
      this.maskCtx.setTransform(1, 0, 0, 1, 0, 0);

      // preserve original alpha-normalization
      const imgData = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
      const data = imgData.data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) data[i] = 255;
      }
      this.maskCtx.putImageData(imgData, 0, 0);
    }

    drawStrokePreview(viewState, strokes, imgW, imgH) {
      this.clearStrokesLayer();
      if (!strokes || strokes.length === 0) return;

      const ctx = this.strokesCtx;
      this.applyViewTransform(ctx, viewState, imgW, imgH);

      for (const stroke of strokes) {
        if (!stroke?.points || stroke.points.length < 2) continue;

        ctx.save();
        ctx.setLineDash([]);
        ctx.globalCompositeOperation = "source-over";

        if (stroke.mode === "pen") {
          ctx.strokeStyle = stroke.color || "rgb(255,0,0)";
          ctx.lineWidth = stroke.brushSize || 5;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
        } else if (stroke.mode === "rubber") {
          // Preview erase as dashed black line (backend will actually erase)
          ctx.strokeStyle = "rgb(0,0,0)";
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = stroke.brushSize || 5;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
        } else if (stroke.mode === "lasso_pen") {
          ctx.strokeStyle = stroke.color || "rgb(255,0,0)";
          ctx.lineWidth = 2;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
        } else if (stroke.mode === "lasso_rubber") {
          ctx.strokeStyle = "rgb(0,0,0)";
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 2;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
        }

        const pts = stroke.points;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);

        // Only close lasso polygon after stroke is finished
        if (stroke.closed) ctx.closePath();

        ctx.stroke();
        ctx.restore();
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    canvasToImage(viewState, xCanvasPx, yCanvasPx, imgW, imgH) {
      const s = viewState.getScale();
      const cw = this.ctCanvas.width;
      const ch = this.ctCanvas.height;

      const tx = cw / 2 + viewState.panX - (s * imgW) / 2;
      const ty = ch / 2 + viewState.panY - (s * imgH) / 2;

      return { x: (xCanvasPx - tx) / s, y: (yCanvasPx - ty) / s };
    }
  }

  class GestureController {
    constructor(app) {
      this.app = app; // ViewerApp
      this.canvas = app.strokesCanvas;

      this.pointers = new Map();  // pointerId -> {x,y} w canvas px
      this.gestureActive = false;

      this.startDist = 0;
      this.startCenter = { x: 0, y: 0 };
      this.startZoom = 0;
      this.startPanX = 0;
      this.startPanY = 0;

      // bind
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
      this._onWheel = this._onWheel.bind(this);
    }

    attach() {
      // Pointer gestures (tablet/telefon)
      this.canvas.addEventListener("pointerdown", this._onPointerDown, { passive: false });
      this.canvas.addEventListener("pointermove", this._onPointerMove, { passive: false });
      this.canvas.addEventListener("pointerup", this._onPointerUp, { passive: false });
      this.canvas.addEventListener("pointercancel", this._onPointerUp, { passive: false });

      // Touchpad / mysz
      this.canvas.addEventListener("wheel", this._onWheel, { passive: false });
    }

    _getCanvasCoords(evt) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: (evt.clientX - rect.left) * (this.canvas.width / rect.width),
        y: (evt.clientY - rect.top) * (this.canvas.height / rect.height),
      };
    }

    _distance(p1, p2) {
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      return Math.hypot(dx, dy);
    }

    _center(p1, p2) {
      return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    }

    _enterGestureMode() {
      if (this.gestureActive) return;
      this.gestureActive = true;

      // blokujemy rysowanie
      window.MaskEditor?.setBlocked?.(true);

      const pts = Array.from(this.pointers.values());
      this.startDist = this._distance(pts[0], pts[1]);
      this.startCenter = this._center(pts[0], pts[1]);

      this.startZoom = this.app.viewState.zoom;
      this.startPanX = this.app.viewState.panX;
      this.startPanY = this.app.viewState.panY;
    }

    _leaveGestureModeIfPossible() {
      if (this.pointers.size === 0) {
        this.gestureActive = false;
        window.MaskEditor?.setBlocked?.(false);
      }
    }

    _onPointerDown(evt) {
      // jeżeli to dotyk / pen – gesty bierzemy przy >=2 pointerach
      // mysz traktujemy normalnie (rysowanie), więc tu nie wchodzimy w gesty przy mouse
      if (evt.pointerType === "mouse") return;

      evt.preventDefault();
      this.canvas.setPointerCapture?.(evt.pointerId);

      const p = this._getCanvasCoords(evt);
      this.pointers.set(evt.pointerId, p);

      if (this.pointers.size === 2) {
        this._enterGestureMode();
      }
    }

    _onPointerMove(evt) {
      if (evt.pointerType === "mouse") return;
      if (!this.pointers.has(evt.pointerId)) return;

      evt.preventDefault();
      const p = this._getCanvasCoords(evt);
      this.pointers.set(evt.pointerId, p);

      if (!this.gestureActive || this.pointers.size < 2) return;

      const pts = Array.from(this.pointers.values());
      const dist = this._distance(pts[0], pts[1]);
      const center = this._center(pts[0], pts[1]);

      // Pan: przesunięcie środka dwóch palców
      const dCx = center.x - this.startCenter.x;
      const dCy = center.y - this.startCenter.y;

      // Zoom: stosunek odległości
      const ratio = dist / (this.startDist || dist);
      const zoomDelta = Math.log2(ratio); // bo zoom jest w log2

      this.app.viewState.zoom = this.startZoom + zoomDelta;
      this.app.viewState.panX = this.startPanX + dCx;
      this.app.viewState.panY = this.startPanY + dCy;

      this.app._syncViewInputsFromState();
      this.app.requestRender();
    }

    _onPointerUp(evt) {
      if (evt.pointerType === "mouse") return;

      evt.preventDefault();
      this.pointers.delete(evt.pointerId);

      // wychodzimy z gestów dopiero jak wszystkie palce puszczone
      if (this.pointers.size < 2) {
        // dalej blokujemy rysowanie aż do 0 pointerów,
        // żeby nie zaczęło rysować "w połowie" gestu
        this._leaveGestureModeIfPossible();
      }
    }

    _onWheel(evt) {
      // Touchpad: wheel służy do pan, a ctrl+wheel do zoom (pinch często generuje ctrlKey)
      evt.preventDefault();

      const x = evt.offsetX * (this.canvas.width / this.canvas.clientWidth);
      const y = evt.offsetY * (this.canvas.height / this.canvas.clientHeight);

      if (evt.ctrlKey) {
        this._zoomAroundCanvasPoint(-evt.deltaY * 0.002, x, y);  // czułość do dopasowania
      } else {
        // Pan: przesuwamy widok. Znaki mogą wymagać odwrócenia w zależności od systemu.
        this.app.viewState.panX -= evt.deltaX;
        this.app.viewState.panY -= evt.deltaY;
      }

      this.app._syncViewInputsFromState();
      this.app.requestRender();
    }

    _zoomAroundCanvasPoint(dZoom, xCanvas, yCanvas) {
      const app = this.app;
      const vs = app.viewState;

      const imgW = app.imgW || app.ctCanvas.width;
      const imgH = app.imgH || app.ctCanvas.height;

      // punkt obrazu pod kursorem przed zmianą zoom
      const pImg = app.renderer.canvasToImage(vs, xCanvas, yCanvas, imgW, imgH);

      const oldZoom = vs.zoom;
      vs.zoom = vs.zoom + dZoom;

      // gdzie ten sam punkt obrazu wyląduje po zmianie zoom?
      const pCanvasAfter = app.renderer.imageToCanvas(vs, pImg.x, pImg.y, imgW, imgH);

      // chcemy, żeby został pod kursorem => korygujemy pan
      const dx = xCanvas - pCanvasAfter.x;
      const dy = yCanvas - pCanvasAfter.y;
      vs.panX += dx;
      vs.panY += dy;

      // opcjonalnie: clamp zoom
      // vs.zoom = Math.max(-3, Math.min(4, vs.zoom));
    }
  }


  class ViewerApp {
    constructor() {
      this.numSlices = window.numSlices;

      // DOM
      this.sliceInput = document.getElementById("sliceInput");
      this.sliceError = document.getElementById("sliceError");
      this.labelSelect = document.getElementById("labelSelect");

      this.ctCanvas = document.getElementById("ctCanvas");
      this.ctCtx = this.ctCanvas.getContext("2d");

      this.maskCanvas = document.getElementById("maskCanvas");
      this.maskCtx = this.maskCanvas.getContext("2d");

      this.strokesCanvas = document.getElementById("strokesCanvas");
      this.strokesCtx = this.strokesCanvas.getContext("2d");

      this.penBtn = document.getElementById("penBtn");
      this.rubberBtn = document.getElementById("rubberBtn");
      this.lassoPenBtn = document.getElementById("lassoPenBtn");
      this.lassoRubberBtn = document.getElementById("lassoRubberBtn");
      this.modeIndicator = document.getElementById("modeIndicator");

      this.saveBtn = document.getElementById("saveBtn");
      this.saveStatus = document.getElementById("saveStatus");
      this.undoBtn = document.getElementById("undoBtn");
      this.redoBtn = document.getElementById("redoBtn");

      this.zoomInput = document.getElementById("zoomInput");
      this.panXInput = document.getElementById("panXInput");
      this.panYInput = document.getElementById("panYInput");

      this.api = new ApiClient();
      this.viewState = new ViewState(this.numSlices);

      this.renderer = new CanvasRenderer(
        this.ctCanvas, this.ctCtx,
        this.maskCanvas, this.maskCtx,
        this.strokesCanvas, this.strokesCtx
      );

      // Images + cache keys
      this.ctImage = null;
      this.ctKey = null;

      this.maskImage = null;
      this.maskKey = null;

      // Current image dims for transforms/coord mapping
      this.imgW = 0;
      this.imgH = 0;

      // Render scheduling
      this._renderScheduled = false;

      // Commit queue
      this._commitQueue = [];
      this._commitRunning = false;

      // Debounced mask refresh + preview cleanup
      this._maskRefreshScheduled = false;
      this._committedSinceLastRefresh = 0;

      this.gestures = new GestureController(this);
    }

    init() {
      this._bindEvents();
      this._initStateFromUI();
      this._initMaskEditor();

      this.requestRender();
      this._updateBrushColorFromLabel();

      this.gestures.attach();
    }

    requestRender() {
      if (this._renderScheduled) return;
      this._renderScheduled = true;

      requestAnimationFrame(async () => {
        try {
          await this.render();
        } finally {
          this._renderScheduled = false;
        }
      });
    }

    _bindEvents() {
      // slice change: commit any buffered strokes first
      this.sliceInput.addEventListener("input", async () => {
        const raw = parseInt(this.sliceInput.value, 10);
        const newZ = this.viewState.clampZ(raw);
        if (!Number.isFinite(newZ) || newZ < 0 || newZ >= this.numSlices) {
          this.sliceError.textContent = "Index out of range";
          return;
        }

        await this.flushCommits();
        this.setState({ z: newZ });
      });

      // label change: commit first, then switch
      this.labelSelect.addEventListener("change", async () => {
        const newLabelId = this.labelSelect.value || "";
        await this.flushCommits();
        this.setState({ labelId: newLabelId });
        this._updateBrushColorFromLabel();
      });

      // tools
      this.penBtn.addEventListener("click", () => window.MaskEditor?.setMode("pen"));
      this.rubberBtn.addEventListener("click", () => window.MaskEditor?.setMode("rubber"));
      this.lassoPenBtn.addEventListener("click", () => window.MaskEditor?.setMode("lasso_pen"));
      this.lassoRubberBtn.addEventListener("click", () => window.MaskEditor?.setMode("lasso_rubber"));

      // zoom/pan: smooth, no commit
      this.zoomInput.addEventListener("input", () => this.setState({ zoom: parseNumber(this.zoomInput.value, 0) }));
      this.panXInput.addEventListener("input", () => this.setState({ panX: parseNumber(this.panXInput.value, 0) }));
      this.panYInput.addEventListener("input", () => this.setState({ panY: parseNumber(this.panYInput.value, 0) }));

      // undo/redo: flush queued commits so backend state is coherent
      this.undoBtn.addEventListener("click", async () => {
        await this.flushCommits();
        const data = await this.api.postEmpty("/api/undo");
        if (data?.status === "empty") {
          this._setStatus("Nothing to undo", "black");
          return;
        }
        this._afterSegmentationChanged();
      });

      this.redoBtn.addEventListener("click", async () => {
        await this.flushCommits();
        const data = await this.api.postEmpty("/api/redo");
        if (data?.status === "empty") {
          this._setStatus("Nothing to redo", "black");
          return;
        }
        this._afterSegmentationChanged();
      });

      // save: flush commits then save
      this.saveBtn.addEventListener("click", async () => {
        const idx = this.viewState.z;
        if (idx === null || !Number.isFinite(idx) || idx < 0 || idx >= this.numSlices) {
          this.sliceError.textContent = "Index out of range";
          return;
        }

        await this.flushCommits({ showStatus: true });

        this._setStatus("Saving to disk...", "black");
        try {
          await this.api.postEmpty("/api/save_all");
          this._setStatus("Saved to disk", "green");
        } catch (err) {
          console.error(err);
          this._setStatus("Disk save failed", "red");
        }
      });
    }

    _syncViewInputsFromState() {
      this.zoomInput.value = String(this.viewState.zoom);
      this.panXInput.value = String(this.viewState.panX);
      this.panYInput.value = String(this.viewState.panY);
    }

    _initMaskEditor() {
      if (!window.MaskEditor) return;

      window.MaskEditor.init({
        canvas: this.strokesCanvas,
        modeIndicator: this.modeIndicator,

        toImageCoords: (x, y) =>
          this.renderer.canvasToImage(
            this.viewState,
            x,
            y,
            this.imgW || this.ctCanvas.width,
            this.imgH || this.ctCanvas.height
          ),

        onChange: () => this.requestRender(),

        // Commit per stroke => undo works per stroke + rubber works immediately.
        onStrokeEnd: (stroke) => this._enqueueStrokeCommit(stroke),
      });
    }

    _initStateFromUI() {
      const z = this.viewState.clampZ(parseInt(this.sliceInput.value, 10));
      this.viewState.z = z;

      this.viewState.labelId = this.labelSelect.value || "";
      this.viewState.zoom = parseNumber(this.zoomInput.value, 0);
      this.viewState.panX = parseNumber(this.panXInput.value, 0);
      this.viewState.panY = parseNumber(this.panYInput.value, 0);
    }

    setState(patch) {
      this.viewState.applyPatch(patch);
      this.requestRender();
    }

    async render() {
      const z = this.viewState.z;
      if (z === null || !Number.isFinite(z) || z < 0 || z >= this.numSlices) return;

      // sync UI
      this.sliceInput.value = String(z);
      this.zoomInput.value = String(this.viewState.zoom);
      this.panXInput.value = String(this.viewState.panX);
      this.panYInput.value = String(this.viewState.panY);
      this.sliceError.textContent = "";

      // CT
      if (this.ctKey !== z) {
        await this._loadCtSlice(z);
      } else {
        this.renderer.drawCt(this.viewState, this.ctImage);
      }

      // Mask
      await this._loadMaskSlice(z);

      // Preview strokes: include currentStroke so lasso curve shows while drawing
      const strokes =
        window.MaskEditor?.getPreviewStrokes?.() ||
        window.MaskEditor?.getStrokes?.() ||
        [];

      this.renderer.drawStrokePreview(
        this.viewState,
        strokes,
        this.imgW || this.ctCanvas.width,
        this.imgH || this.ctCanvas.height
      );
    }

    async _loadCtSlice(z) {
      const url = `/slice_bg/${z}${cacheBuster()}`;
      const img = await loadImage(url);

      this.ctImage = img;
      this.ctKey = z;

      this.imgW = img.width;
      this.imgH = img.height;

      this.renderer.setCanvasSize(img.width, img.height);
      this.renderer.drawCt(this.viewState, this.ctImage);
      this.renderer.drawMask(this.viewState, this.maskImage);
    }

    async _loadMaskSlice(z) {
      if (!this.viewState.labelId) {
        this.maskCanvas.style.display = "none";
        this._invalidateMaskCache();
        this.renderer.clearMask();
        return;
      }

      this.maskCanvas.style.display = "block";

      const key = `${z}:${this.viewState.labelId}`;
      if (this.maskKey === key && this.maskImage) {
        this.renderer.drawMask(this.viewState, this.maskImage);
        return;
      }

      const url = `/slice_mask/${z}/${this.viewState.labelId}${cacheBuster()}`;
      const img = await loadImage(url);

      this.maskImage = img;
      this.maskKey = key;

      if (this.maskCanvas.width !== img.width || this.maskCanvas.height !== img.height) {
        this.imgW = img.width;
        this.imgH = img.height;
        this.renderer.setCanvasSize(img.width, img.height);
      }

      this.renderer.drawMask(this.viewState, this.maskImage);
    }

    // -------- Commit queue (per-stroke) --------

    _enqueueStrokeCommit(stroke) {
      // If no label selected, we cannot apply (backend endpoint needs label).
      // Drop the stroke to avoid misleading preview.
      if (!this.viewState.labelId) {
        // Remove the last stroke from buffer (it was just pushed by MaskEditor)
        // Simpler: flush full buffer
        window.MaskEditor?.clearStrokes?.();
        return;
      }

      this._commitQueue.push(stroke);
      this._runCommitQueue(); // async fire-and-forget
    }

    async _runCommitQueue() {
      if (this._commitRunning) return;
      this._commitRunning = true;

      try {
        while (this._commitQueue.length > 0) {
          const idx = this.viewState.z;
          const labelVal = this.viewState.labelId;

          if (idx === null || !labelVal) {
            this._commitQueue.length = 0;
            break;
          }

          const stroke = this._commitQueue.shift();

          // Commit ONE stroke -> ONE backend history op -> Undo per stroke
          await this.api.postJson(`/api/slice_edit/${idx}/${labelVal}`, { strokes: [stroke] });
          this._committedSinceLastRefresh += 1;

          // Debounced PNG refresh
          this._scheduleMaskRefresh();
        }
      } catch (err) {
        console.error(err);
        this._setStatus("Update failed", "red");
      } finally {
        this._commitRunning = false;
      }
    }

    _scheduleMaskRefresh() {
      if (this._maskRefreshScheduled) return;
      this._maskRefreshScheduled = true;

      setTimeout(async () => {
        this._maskRefreshScheduled = false;

        const n = this._committedSinceLastRefresh;
        if (n <= 0) return;
        this._committedSinceLastRefresh = 0;

        // Refresh backend mask PNG
        this._invalidateMaskCache();
        await this._loadMaskSlice(this.viewState.z);

        // Remove only the strokes that we know got committed
        window.MaskEditor?.dropFirst?.(n);

        this.requestRender();
      }, 120);
    }

    // Flush: wait until queue drains and mask refresh completes once.
    async flushCommits(opts = {}) {
      const showStatus = !!opts.showStatus;
      if (showStatus) this._setStatus("Updating mask in memory...", "black");

      // Wait for queue to drain
      while (this._commitRunning || this._commitQueue.length > 0 || this._maskRefreshScheduled) {
        await new Promise((r) => setTimeout(r, 30));
      }

      // If any strokes remain in buffer (e.g. label changed mid-commit), clear preview
      // but only if you want strict behavior. We'll keep it conservative:
      // window.MaskEditor?.clearStrokes?.();

      if (showStatus) {
        this._setStatus("Updated in memory", "green");
        setTimeout(() => this._setStatus("", "black"), 800);
      }
    }

    _afterSegmentationChanged() {
      this._invalidateMaskCache();
      this.requestRender();
    }

    _invalidateMaskCache() {
      this.maskImage = null;
      this.maskKey = null;
    }

    _setStatus(text, color) {
      if (!this.saveStatus) return;
      this.saveStatus.style.color = color || "black";
      this.saveStatus.textContent = text || "";
    }

    _updateBrushColorFromLabel() {
      if (!window.MaskEditor) return;

      const opt = this.labelSelect.selectedOptions?.[0];
      if (!opt) return;

      const raw = opt.dataset?.color;
      if (!raw) return;

      const parts = raw.split(",").map((x) => parseInt(x.trim(), 10));
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return;

      window.MaskEditor.setColorFromRgb(parts[0], parts[1], parts[2]);
    }
  }

  window.addEventListener("load", () => {
    const app = new ViewerApp();
    app.init();
  });
})();

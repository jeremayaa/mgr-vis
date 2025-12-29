// static/js/viewer.js
// App/controller layer that:
// - owns view state (slice/label/zoom/pan)
// - fetches PNGs from backend endpoints
// - commits strokes to backend edit endpoint
// - drives render loop for the 2 canvases

(() => {
  "use strict";

  // -------------------- Small helpers --------------------

  function parseNumber(val, fallback = 0) {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function cacheBuster() {
    return `?_=${Date.now()}`;
  }

  function loadImage(url) {
    // Promise wrapper around Image loading
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  // -------------------- API client --------------------

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

  // -------------------- View state --------------------

  class ViewState {
    constructor(numSlices) {
      this.numSlices = numSlices;

      /** @type {number|null} */
      this.z = null;
      /** @type {string} */
      this.labelId = "";

      // zoom is log2(scale): 0 => 1x, 1 => 2x, -1 => 0.5x
      this.zoom = 0;
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

  // -------------------- Renderer --------------------

  class CanvasRenderer {
    /**
     * @param {HTMLCanvasElement} ctCanvas
     * @param {CanvasRenderingContext2D} ctCtx
     * @param {HTMLCanvasElement} maskCanvas
     * @param {CanvasRenderingContext2D} maskCtx
     */
    constructor(ctCanvas, ctCtx, maskCanvas, maskCtx) {
      this.ctCanvas = ctCanvas;
      this.ctCtx = ctCtx;
      this.maskCanvas = maskCanvas;
      this.maskCtx = maskCtx;
    }

    setCanvasSize(w, h) {
      this.ctCanvas.width = w;
      this.ctCanvas.height = h;
      this.maskCanvas.width = w;
      this.maskCanvas.height = h;
    }

    clearCt() {
      this.ctCtx.clearRect(0, 0, this.ctCanvas.width, this.ctCanvas.height);
    }

    clearMask() {
      this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
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
      // If no label selected, hide mask layer externally.
      if (!maskImage || !viewState.labelId) {
        this.clearMask();
        return;
      }

      this.clearMask();
      this.applyViewTransform(this.maskCtx, viewState, maskImage.width, maskImage.height);
      this.maskCtx.drawImage(maskImage, 0, 0);
      this.maskCtx.setTransform(1, 0, 0, 1, 0, 0);

      // Your original logic: force alpha=255 for any non-transparent pixel.
      // (Opacity is controlled by CSS on #maskCanvas.)
      const imgData = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
      const data = imgData.data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) data[i] = 255;
      }
      this.maskCtx.putImageData(imgData, 0, 0);
    }

    /**
     * Convert canvas pixel coords -> image pixel coords, accounting for zoom/pan.
     * This must match the transform math used in drawCt/drawMask.
     */
    canvasToImage(viewState, xCanvasPx, yCanvasPx) {
      const s = viewState.getScale();
      const cw = this.ctCanvas.width;
      const ch = this.ctCanvas.height;

      // Undo tx/ty used in applyViewTransform:
      // tx = cw/2 + panX - (s*imgW)/2
      // We don't have imgW/imgH here, but because we size canvases to match the image
      // (see loadCtSlice), imgW == cw and imgH == ch in your current app.
      //
      // With that assumption, -(s*imgW)/2 becomes -(s*cw)/2.
      // This mirrors your existing implementation’s assumption.
      const tx = cw / 2 + viewState.panX - (s * cw) / 2;
      const ty = ch / 2 + viewState.panY - (s * ch) / 2;

      const xImg = (xCanvasPx - tx) / s;
      const yImg = (yCanvasPx - ty) / s;
      return { x: xImg, y: yImg };
    }
  }

  // -------------------- Main app/controller --------------------

  class ViewerApp {
    constructor() {
      this.numSlices = window.numSlices;

      // DOM refs
      this.sliceInput = document.getElementById("sliceInput");
      this.sliceError = document.getElementById("sliceError");
      this.labelSelect = document.getElementById("labelSelect");

      this.ctCanvas = document.getElementById("ctCanvas");
      this.ctCtx = this.ctCanvas.getContext("2d");

      this.maskCanvas = document.getElementById("maskCanvas");
      this.maskCtx = this.maskCanvas.getContext("2d");

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

      // backend client + state + renderer
      this.api = new ApiClient();
      this.viewState = new ViewState(this.numSlices);
      this.renderer = new CanvasRenderer(this.ctCanvas, this.ctCtx, this.maskCanvas, this.maskCtx);

      // image caches
      this.ctImage = null;
      this.ctKey = null; // slice index

      this.maskImage = null;
      this.maskKey = null; // `${z}:${labelId}`
    }

    init() {
      this._bindEvents();
      this._initMaskEditor();

      this._initStateFromUI();
      this.render();
      this._updateBrushColorFromLabel();
    }

    // ---------- UI bindings ----------

    _bindEvents() {
      // slice change
      this.sliceInput.addEventListener("input", async () => {
        const raw = parseInt(this.sliceInput.value, 10);
        const newZ = this.viewState.clampZ(raw);

        if (!Number.isFinite(newZ) || newZ < 0 || newZ >= this.numSlices) {
          this.sliceError.textContent = "Index out of range";
          return;
        }

        await this._commitStrokes({ quiet: true });
        this.setState({ z: newZ });
      });

      // label change
      this.labelSelect.addEventListener("change", async () => {
        const newLabelId = this.labelSelect.value || "";

        // commit for previous label first (important)
        await this._commitStrokes({ quiet: true });

        this.setState({ labelId: newLabelId });
        this._updateBrushColorFromLabel();
      });

      // tools
      this.penBtn.addEventListener("click", () => window.MaskEditor?.setMode("pen"));
      this.rubberBtn.addEventListener("click", () => window.MaskEditor?.setMode("rubber"));
      this.lassoPenBtn.addEventListener("click", () => window.MaskEditor?.setMode("lasso_pen"));
      this.lassoRubberBtn.addEventListener("click", () => window.MaskEditor?.setMode("lasso_rubber"));

      // zoom/pan inputs
      const onViewChange = async (patch) => {
        await this._commitStrokes({ quiet: true });
        this.setState(patch);
      };

      this.zoomInput.addEventListener("input", () =>
        onViewChange({ zoom: parseNumber(this.zoomInput.value, 0) })
      );
      this.panXInput.addEventListener("input", () =>
        onViewChange({ panX: parseNumber(this.panXInput.value, 0) })
      );
      this.panYInput.addEventListener("input", () =>
        onViewChange({ panY: parseNumber(this.panYInput.value, 0) })
      );

      // undo/redo
      this.undoBtn.addEventListener("click", async () => {
        await this._commitStrokes({ quiet: true });
        const data = await this.api.postEmpty("/api/undo");
        if (data?.status === "empty") {
          this._setStatus("Nothing to undo", "black");
          return;
        }
        this._afterSegmentationChanged();
      });

      this.redoBtn.addEventListener("click", async () => {
        await this._commitStrokes({ quiet: true });
        const data = await this.api.postEmpty("/api/redo");
        if (data?.status === "empty") {
          this._setStatus("Nothing to redo", "black");
          return;
        }
        this._afterSegmentationChanged();
      });

      // save
      this.saveBtn.addEventListener("click", async () => {
        const idx = this.viewState.z;
        if (idx === null || !Number.isFinite(idx) || idx < 0 || idx >= this.numSlices) {
          this.sliceError.textContent = "Index out of range";
          return;
        }

        await this._commitStrokes({ quiet: false });

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

    _initMaskEditor() {
      if (!window.MaskEditor) return;

      window.MaskEditor.init({
        canvas: this.maskCanvas,
        modeIndicator: this.modeIndicator,

        // Provide coordinate mapping and scale from THIS app instance
        toImageCoords: (x, y) => this.renderer.canvasToImage(this.viewState, x, y),
        getScale: () => this.viewState.getScale(),

        onLassoCommit: async () => {
          // commit immediately so outline doesn't "disappear"
          await this._commitStrokes({ quiet: true });
          this._invalidateMaskCache();
          this.render();
        },
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
      this.render();
    }

    // ---------- Rendering / loading ----------

    async render() {
      const z = this.viewState.z;
      if (z === null || !Number.isFinite(z) || z < 0 || z >= this.numSlices) return;

      // keep UI synced
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
    }

    async _loadCtSlice(z) {
      const url = `/slice_bg/${z}${cacheBuster()}`;
      const img = await loadImage(url);

      this.ctImage = img;
      this.ctKey = z;

      // Your app assumes CT image size defines canvas size.
      this.renderer.setCanvasSize(img.width, img.height);
      this.renderer.drawCt(this.viewState, this.ctImage);
      this.renderer.drawMask(this.viewState, this.maskImage);
    }

    async _loadMaskSlice(z) {
      if (!this.viewState.labelId) {
        this.maskCanvas.style.display = "none";
        this.renderer.clearMask();
        this._invalidateMaskCache();
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

      // Ensure canvas sizes are aligned if something changes unexpectedly.
      if (this.maskCanvas.width !== img.width || this.maskCanvas.height !== img.height) {
        this.renderer.setCanvasSize(img.width, img.height);
      }

      this.renderer.drawMask(this.viewState, this.maskImage);
    }

    // ---------- Backend commit boundary ----------

    async _commitStrokes({ quiet }) {
      if (!window.MaskEditor) return;

      const strokes = window.MaskEditor.getStrokes();
      if (!strokes || strokes.length === 0) return;

      const idx = this.viewState.z;
      const labelVal = this.viewState.labelId;

      // invalid context: drop strokes
      if (
        idx === null ||
        !Number.isFinite(idx) ||
        idx < 0 ||
        idx >= this.numSlices ||
        !labelVal
      ) {
        window.MaskEditor.clearStrokes();
        return;
      }

      if (!quiet) this._setStatus("Updating mask in memory...", "black");

      try {
        await this.api.postJson(`/api/slice_edit/${idx}/${labelVal}`, { strokes });

        window.MaskEditor.clearStrokes();
        this._invalidateMaskCache();

        if (!quiet) {
          this._setStatus("Updated in memory", "green");
          setTimeout(() => this._setStatus("", "black"), 1000);
        }

        // After commit, re-fetch current mask PNG so backend is truth.
        await this._loadMaskSlice(this.viewState.z);
      } catch (err) {
        console.error(err);
        if (!quiet) this._setStatus("Update failed", "red");
      }
    }

    _afterSegmentationChanged() {
      this._invalidateMaskCache();
      this.render();
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

  // Boot
  window.addEventListener("load", () => {
    const app = new ViewerApp();
    app.init();
  });
})();

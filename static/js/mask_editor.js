// static/js/mask_editor.js
// A small "module" that owns:
// - local preview drawing on the mask canvas
// - buffering stroke vectors to be sent to backend by viewer.js

(() => {
  "use strict";

  /**
   * @typedef {{x:number, y:number}} Point
   * @typedef {{
   *   mode: "pen"|"rubber"|"lasso_pen"|"lasso_rubber",
   *   brushSize: number,
   *   color: string,
   *   points: Point[]
   * }} Stroke
   */

  class MaskEditor {
    constructor() {
      // canvas / context
      /** @type {HTMLCanvasElement|null} */
      this.canvas = null;
      /** @type {CanvasRenderingContext2D|null} */
      this.ctx = null;

      // settings
      /** @type {"pen"|"rubber"|"lasso_pen"|"lasso_rubber"} */
      this.mode = "pen";
      this.brushSize = 5;
      this.strokeColor = "rgb(255, 0, 0)";

      // injected functions/callbacks from viewer.js
      /** @type {(x:number, y:number) => Point} */
      this.toImageCoords = (x, y) => ({ x, y });
      /** @type {() => number} */
      this.getViewScale = () => 1;
      /** @type {(() => void)|null} */
      this.onLassoCommit = null;

      /** @type {HTMLElement|null} */
      this.modeIndicatorElem = null;

      // drawing state
      this.isDrawing = false;
      this.lastX = 0;
      this.lastY = 0;

      /** @type {Stroke[]} */
      this.strokes = [];
      /** @type {Stroke|null} */
      this.currentStroke = null;

      // bound handlers (so add/removeEventListener works reliably)
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
    }

    // ---------- Public API (used by viewer.js) ----------

    /**
     * @param {{
     *  canvas: HTMLCanvasElement,
     *  modeIndicator?: HTMLElement|null,
     *  toImageCoords?: (x:number, y:number)=>Point,
     *  getScale?: ()=>number,
     *  onLassoCommit?: ()=>void
     * }} opts
     */
    init(opts) {
      if (!opts || !opts.canvas) throw new Error("MaskEditor.init: canvas is required");

      this.canvas = opts.canvas;
      this.ctx = this.canvas.getContext("2d");
      if (!this.ctx) throw new Error("MaskEditor.init: failed to get 2d context");

      this.modeIndicatorElem = opts.modeIndicator || null;
      if (typeof opts.toImageCoords === "function") this.toImageCoords = opts.toImageCoords;
      if (typeof opts.getScale === "function") this.getViewScale = opts.getScale;
      this.onLassoCommit = typeof opts.onLassoCommit === "function" ? opts.onLassoCommit : null;

      this.setMode("pen");
      this._attachEvents();
    }

    /** @param {"pen"|"rubber"|"lasso_pen"|"lasso_rubber"} newMode */
    setMode(newMode) {
      const allowed = new Set(["pen", "rubber", "lasso_pen", "lasso_rubber"]);
      if (!allowed.has(newMode)) return;

      this.mode = newMode;
      if (!this.modeIndicatorElem) return;

      const pretty =
        newMode === "pen"
          ? "Pen"
          : newMode === "rubber"
          ? "Rubber"
          : newMode === "lasso_pen"
          ? "Lasso Pen"
          : "Lasso Rubber";
      this.modeIndicatorElem.textContent = `Mode: ${pretty}`;
    }

    /** Set preview stroke color (opacity is handled by CSS on the canvas). */
    setColorFromRgb(r, g, b) {
      this.strokeColor = `rgb(${r}, ${g}, ${b})`;
    }

    setBrushSize(size) {
      const n = Number(size);
      if (!Number.isFinite(n) || n <= 0) return;
      this.brushSize = n;
    }

    /** @returns {Stroke[]} */
    getStrokes() {
      return this.strokes;
    }

    clearStrokes() {
      this.strokes.length = 0;
      this.currentStroke = null;
    }

    // ---------- Internals ----------

    _attachEvents() {
      if (!this.canvas) return;

      // Pointer events unify mouse + touch and are widely supported
      this.canvas.addEventListener("pointerdown", this._onPointerDown, { passive: false });
      this.canvas.addEventListener("pointermove", this._onPointerMove, { passive: false });
      this.canvas.addEventListener("pointerup", this._onPointerUp, { passive: false });
      this.canvas.addEventListener("pointercancel", this._onPointerUp, { passive: false });

      // Improves drawing on touch devices: prevent browser from panning/zooming on touch
      this.canvas.style.touchAction = "none";
    }

    _applyPreviewStyle() {
      const ctx = this.ctx;
      if (!ctx) return;

      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.globalCompositeOperation = "source-over";

      const scale = this.getViewScale();

      if (this.mode === "pen") {
        ctx.lineWidth = this.brushSize * scale;
        ctx.strokeStyle = this.strokeColor;
      } else if (this.mode === "rubber") {
        ctx.lineWidth = this.brushSize * scale;
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
      } else if (this.mode === "lasso_pen") {
        ctx.lineWidth = 2 * scale;
        ctx.strokeStyle = this.strokeColor;
      } else if (this.mode === "lasso_rubber") {
        ctx.lineWidth = 2 * scale;
        ctx.strokeStyle = "rgb(0,0,0)";
      }
    }

    /** @param {PointerEvent} evt */
    _getCanvasCoords(evt) {
      if (!this.canvas) return { x: 0, y: 0 };
      const rect = this.canvas.getBoundingClientRect();

      // Convert CSS pixels -> actual canvas pixels
      const x = (evt.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (evt.clientY - rect.top) * (this.canvas.height / rect.height);
      return { x, y };
    }

    /** @param {PointerEvent} evt */
    _onPointerDown(evt) {
      if (!this.canvas || !this.ctx) return;
      evt.preventDefault();

      this.isDrawing = true;
      try {
        // Capture the pointer so we keep receiving move/up even if pointer leaves canvas
        this.canvas.setPointerCapture(evt.pointerId);
      } catch (_) {
        // ok if unsupported
      }

      const { x, y } = this._getCanvasCoords(evt);
      this.lastX = x;
      this.lastY = y;

      this._applyPreviewStyle();

      const pImg = this.toImageCoords(x, y);
      this.currentStroke = {
        mode: this.mode,
        brushSize: this.brushSize,
        color: this.strokeColor,
        points: [{ x: pImg.x, y: pImg.y }],
      };
    }

    /** @param {PointerEvent} evt */
    _onPointerMove(evt) {
      if (!this.isDrawing || !this.canvas || !this.ctx) return;
      evt.preventDefault();

      const { x, y } = this._getCanvasCoords(evt);

      // Preview drawing: draw directly to the canvas
      this.ctx.beginPath();
      this.ctx.moveTo(this.lastX, this.lastY);
      this.ctx.lineTo(x, y);
      this.ctx.stroke();

      this.lastX = x;
      this.lastY = y;

      // Buffer stroke points in image coordinates (backend expects that)
      if (this.currentStroke) {
        const pImg = this.toImageCoords(x, y);
        this.currentStroke.points.push({ x: pImg.x, y: pImg.y });
      }
    }

    /** @param {PointerEvent} evt */
    _onPointerUp(evt) {
      if (!this.isDrawing) return;
      evt.preventDefault();
      this.isDrawing = false;

      if (!this.currentStroke) return;

      const finishedMode = this.currentStroke.mode;
      this.strokes.push(this.currentStroke);
      this.currentStroke = null;

      // Auto-commit lasso strokes (viewer.js decides what "commit" means)
      if (
        (finishedMode === "lasso_pen" || finishedMode === "lasso_rubber") &&
        typeof this.onLassoCommit === "function"
      ) {
        this.onLassoCommit();
      }
    }
  }

  // Keep same global name the rest of the app expects.
  window.MaskEditor = new MaskEditor();
})();

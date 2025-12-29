// static/js/mask_editor.js
// Buffer-only editor that collects strokes in image coordinates.
// ViewerApp renders preview strokes on strokesCanvas.
// On each finished stroke, calls onStrokeEnd(stroke) so Viewer can commit per-stroke.

(() => {
  "use strict";

  /**
   * @typedef {{x:number, y:number}} Point
   * @typedef {{
   *   mode: "pen"|"rubber"|"lasso_pen"|"lasso_rubber",
   *   brushSize: number,
   *   color: string,
   *   closed: boolean,
   *   points: Point[]
   * }} Stroke
   */

  class MaskEditor {
    constructor() {
      /** @type {HTMLCanvasElement|null} */
      this.canvas = null;

      /** @type {"pen"|"rubber"|"lasso_pen"|"lasso_rubber"} */
      this.mode = "pen";
      this.brushSize = 5;
      this.strokeColor = "rgb(255, 0, 0)";

      /** @type {(x:number, y:number)=>Point} */
      this.toImageCoords = (x, y) => ({ x, y });

      /** @type {HTMLElement|null} */
      this.modeIndicatorElem = null;

      /** @type {(() => void)|null} */
      this.onChange = null;

      /** @type {((stroke: any) => void)|null} */
      this.onStrokeEnd = null;

      this.isDrawing = false;

      /** @type {Stroke[]} */
      this.strokes = [];
      /** @type {Stroke|null} */
      this.currentStroke = null;

      // bind
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);

      // block drawing on simultaneous click
      this.blocked = false;
      this.activePointerId = null;
    }

    /**
     * @param {{
     *  canvas: HTMLCanvasElement,
     *  modeIndicator?: HTMLElement|null,
     *  toImageCoords?: (x:number, y:number)=>Point,
     *  onChange?: ()=>void,
     *  onStrokeEnd?: (stroke:any)=>void
     * }} opts
     */
    init(opts) {
      if (!opts || !opts.canvas) throw new Error("MaskEditor.init: canvas is required");

      this.canvas = opts.canvas;
      this.modeIndicatorElem = opts.modeIndicator || null;

      if (typeof opts.toImageCoords === "function") this.toImageCoords = opts.toImageCoords;
      this.onChange = typeof opts.onChange === "function" ? opts.onChange : null;
      this.onStrokeEnd = typeof opts.onStrokeEnd === "function" ? opts.onStrokeEnd : null;

      this.setMode("pen");
      this._attachEvents();
    }

    setBlocked(flag) {
      this.blocked = !!flag;
      if (this.blocked) {
        // anuluj ewentualny stroke w trakcie
        this.isDrawing = false;
        this.currentStroke = null;
        this.activePointerId = null;
        this._notifyChange();
      }
    }


    /** @param {"pen"|"rubber"|"lasso_pen"|"lasso_rubber"} newMode */
    setMode(newMode) {
      const allowed = new Set(["pen", "rubber", "lasso_pen", "lasso_rubber"]);
      if (!allowed.has(newMode)) return;

      this.mode = newMode;

      if (this.modeIndicatorElem) {
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
    }

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

    /** @returns {Stroke[]} */
    getPreviewStrokes() {
      if (this.currentStroke) return [...this.strokes, this.currentStroke];
      return this.strokes;
    }

    clearStrokes() {
      this.strokes.length = 0;
      this.currentStroke = null;
      this._notifyChange();
    }

    /** drop first n finished strokes (used after commits) */
    dropFirst(n) {
      const k = Number(n);
      if (!Number.isFinite(k) || k <= 0) return;
      this.strokes.splice(0, Math.min(k, this.strokes.length));
      this._notifyChange();
    }

    // ---- internals ----

    _attachEvents() {
      if (!this.canvas) return;

      this.canvas.addEventListener("pointerdown", this._onPointerDown, { passive: false });
      this.canvas.addEventListener("pointermove", this._onPointerMove, { passive: false });
      this.canvas.addEventListener("pointerup", this._onPointerUp, { passive: false });
      this.canvas.addEventListener("pointercancel", this._onPointerUp, { passive: false });

      // disable native touch gestures while drawing
      this.canvas.style.touchAction = "none";
    }

    _notifyChange() {
      if (typeof this.onChange === "function") this.onChange();
    }

    /** @param {PointerEvent} evt */
    _getCanvasCoords(evt) {
      if (!this.canvas) return { x: 0, y: 0 };
      const rect = this.canvas.getBoundingClientRect();
      const x = (evt.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (evt.clientY - rect.top) * (this.canvas.height / rect.height);
      return { x, y };
    }

    /** @param {PointerEvent} evt */
    _onPointerDown(evt) {
      if (this.blocked) return;

      if (this.activePointerId !== null) return;   // drugi palec ignorujemy
      this.activePointerId = evt.pointerId;

      if (!this.canvas) return;
      evt.preventDefault();

      this.isDrawing = true;
      try {
        this.canvas.setPointerCapture(evt.pointerId);
      } catch (_) {}

      const { x, y } = this._getCanvasCoords(evt);
      const pImg = this.toImageCoords(x, y);

      this.currentStroke = {
        mode: this.mode,
        brushSize: this.brushSize,
        color: this.strokeColor,
        closed: false,
        points: [{ x: pImg.x, y: pImg.y }],
      };

      this._notifyChange();
    }

    /** @param {PointerEvent} evt */
    _onPointerMove(evt) {
      if (this.blocked) return;
      if (!this.isDrawing || !this.currentStroke) return;
      evt.preventDefault();

      const { x, y } = this._getCanvasCoords(evt);
      const pImg = this.toImageCoords(x, y);
      this.currentStroke.points.push({ x: pImg.x, y: pImg.y });

      this._notifyChange();
    }

    /** @param {PointerEvent} evt */
    _onPointerUp(evt) {
      if (this.blocked) return;
      if (!this.isDrawing) return;
      evt.preventDefault();
      this.isDrawing = false;

      if (!this.currentStroke) return;

      const finished = this.currentStroke;
      this.currentStroke = null;

      if (finished.mode === "lasso_pen" || finished.mode === "lasso_rubber") {
        finished.closed = true;
      }

      this.strokes.push(finished);
      this._notifyChange();

      if (typeof this.onStrokeEnd === "function") {
        this.onStrokeEnd(finished);
      }

      this.activePointerId = null;
    }
  }

  window.MaskEditor = new MaskEditor();
})();

// static/js/mask_editor.js

window.MaskEditor = (function () {
  let canvas = null;
  let ctx = null;
  let mode = "pen"; // "pen" or "rubber"
  let brushSize = 5;
  const MASK_ALPHA = 120 / 255;; // default red
  let strokeColor = "rgb(255, 0, 0)";; 
  let isDrawing = false;
  let lastX = 0;
  let lastY = 0;

  let toImageCoords = (x, y) => ({ x, y });
  let getViewScale = () => 1;

  // For future backend use: keep strokes
  const strokes = [];
  let currentStroke = null;

  let modeIndicatorElem = null;

  function setMode(newMode) {
    if (newMode !== "pen" && newMode !== "rubber") return;
    mode = newMode;

    if (modeIndicatorElem) {
      modeIndicatorElem.textContent =
        mode === "pen" ? "Mode: Pen" : "Mode: Rubber";
    }
  }
  
  function setColorFromRgb(r, g, b) {
    // opaque color; transparency handled by canvas CSS opacity
    strokeColor = `rgb(${r}, ${g}, ${b})`;
  }

  function setBrushSize(size) {
    brushSize = size;
  }

  function updateDrawingStyle() {
    if (!ctx) return;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = brushSize * getViewScale();

    if (mode === "pen") {
      // Normal drawing, no special compositing
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = strokeColor;
    } else if (mode === "rubber") {
      // Erase from the canvas
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    }
  }

  function getCanvasCoords(evt) {
    const rect = canvas.getBoundingClientRect();
    const clientX = evt.clientX ?? (evt.touches && evt.touches[0].clientX);
    const clientY = evt.clientY ?? (evt.touches && evt.touches[0].clientY);

    // Convert from CSS pixels -> actual canvas pixel coordinates
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const y = (clientY - rect.top) * (canvas.height / rect.height);

    return { x, y };
  }

  function handlePointerDown(evt) {
    if (!canvas) return;
    evt.preventDefault();
    isDrawing = true;

    const { x, y } = getCanvasCoords(evt);
    lastX = x;
    lastY = y;

    updateDrawingStyle();

    const pImg = toImageCoords(x, y);

    currentStroke = {
      mode,
      brushSize,
      color: strokeColor,
      points: [{ x: pImg.x, y: pImg.y }],
    };
  }

  function handlePointerMove(evt) {
    if (!isDrawing || !canvas) return;
    evt.preventDefault();

    const { x, y } = getCanvasCoords(evt);

    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();

    lastX = x;
    lastY = y;

    if (currentStroke) {
      const pImg = toImageCoords(x, y);
      currentStroke.points.push({ x: pImg.x, y: pImg.y });
    }
  }

  function finishStroke() {
    if (!isDrawing) return;
    isDrawing = false;

    if (currentStroke) {
      strokes.push(currentStroke);
      currentStroke = null;
    }
  }

  function attachEvents() {
    canvas.addEventListener("mousedown", handlePointerDown);
    canvas.addEventListener("mousemove", handlePointerMove);
    canvas.addEventListener("mouseup", finishStroke);
    canvas.addEventListener("mouseleave", finishStroke);

    // Basic touch support (optional)
    canvas.addEventListener("touchstart", handlePointerDown, { passive: false });
    canvas.addEventListener("touchmove", handlePointerMove, { passive: false });
    canvas.addEventListener("touchend", finishStroke);
    canvas.addEventListener("touchcancel", finishStroke);
  }

  function init({ canvas: canvasElem, modeIndicator, toImageCoords: toFn, getScale: getScaleFn }) {
    canvas = canvasElem;
    ctx = canvas.getContext("2d");
    modeIndicatorElem = modeIndicator || null;

    if (typeof toFn === "function") toImageCoords = toFn;
    if (typeof getScaleFn === "function") getViewScale = getScaleFn;
    
    setMode("pen"); // default mode
    attachEvents();
  }

  // For future commits: allow viewer.js to clear strokes or read them
  function getStrokes() {
    return strokes;
  }

  function clearStrokes() {
    strokes.length = 0;
    currentStroke = null;
  }

  return {
    init,
    setMode,
    setColorFromRgb,
    setBrushSize,
    getStrokes,
    clearStrokes,
  };
})();

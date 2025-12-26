// static/js/viewer.js

(function () {
  // numSlices is injected from the template as window.numSlices
  const numSlices = window.numSlices;

  const sliceInput = document.getElementById("sliceInput");
  const sliceError = document.getElementById("sliceError");
  const labelSelect = document.getElementById("labelSelect");
  const ctCanvas = document.getElementById("ctCanvas");
  const ctCtx = ctCanvas.getContext("2d");
  const maskCanvas = document.getElementById("maskCanvas");
  const maskCtx = maskCanvas.getContext("2d");

  const penBtn = document.getElementById("penBtn");
  const rubberBtn = document.getElementById("rubberBtn");
  const modeIndicator = document.getElementById("modeIndicator");

  const saveBtn = document.getElementById("saveBtn");
  const saveStatus = document.getElementById("saveStatus");

  const zoomInput = document.getElementById("zoomInput");
  const panXInput = document.getElementById("panXInput");
  const panYInput = document.getElementById("panYInput");

  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");

  let ctImage = null;
  let ctKey = null; // slice index

  let maskImage = null;
  let maskKey = null; // `${z}:${labelId}`


  // ---- View state (single source of truth) ----
  const viewState = {
    z: null,          // slice index
    labelId: "",      // selected label (string, "" means none)
    zoom: 0,   // 0 => 1x, 1 => 2x, -1 => 0.5x
    panX: 0,   // pixels in canvas space
    panY: 0,
  };

  function clampZ(z) {
    if (isNaN(z)) return 0;
    return Math.max(0, Math.min(numSlices - 1, z));
  }

  function setState(patch) {
    Object.assign(viewState, patch);
    render();
  }
  
  function getScale() {
    // zoom is log2 scale: 0=>1x, 1=>2x, -1=>0.5x
    return Math.pow(2, viewState.zoom);
  }

  function applyViewTransform(ctx, imgW, imgH) {
    const s = getScale();
    const cw = ctCanvas.width;
    const ch = ctCanvas.height;

    const tx = cw / 2 + viewState.panX - (s * imgW) / 2;
    const ty = ch / 2 + viewState.panY - (s * imgH) / 2;

    ctx.setTransform(s, 0, 0, s, tx, ty);
  }

  function canvasToImage(xCanvasPx, yCanvasPx) {
    const s = getScale();
    const cw = ctCanvas.width;
    const ch = ctCanvas.height;

    // assume image is drawn with its natural pixel size equal to canvas base size
    const imgW = ctCanvas.width;
    const imgH = ctCanvas.height;

    const xImg = imgW / 2 + (xCanvasPx - cw / 2 - viewState.panX) / s;
    const yImg = imgH / 2 + (yCanvasPx - ch / 2 - viewState.panY) / s;

    return { x: xImg, y: yImg };
  }


  // let currentSliceIdx = null;
  // NOTE: z is stored in viewState.z now

    function sendStrokesToBackend(quiet, afterFn) {
    if (!window.MaskEditor) {
      if (afterFn) afterFn();
      return;
    }

    const strokes = window.MaskEditor.getStrokes();
    if (!strokes || !strokes.length) {
      if (afterFn) afterFn();
      return;
    }

    const idx = viewState.z;
    const labelVal = viewState.labelId;

    if (
      idx === null ||
      isNaN(idx) ||
      idx < 0 ||
      idx >= numSlices ||
      !labelVal
    ) {
      // Invalid context for strokes; just drop them
      window.MaskEditor.clearStrokes();
      if (afterFn) afterFn();
      return;
    }

    if (!quiet && saveStatus) {
      saveStatus.style.color = "black";
      saveStatus.textContent = "Updating mask in memory...";
    }

    fetch(`/api/slice_edit/${idx}/${labelVal}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ strokes }),
    })
      .then((res) => res.json())
      .then((data) => {
        window.MaskEditor.clearStrokes();

        // IMPORTANT: segmentation changed on backend for same (z,label),
        // so cached mask PNG is now stale. Force a refetch on next render.
        maskImage = null;
        maskKey = null;

        if (!quiet && saveStatus) {
          saveStatus.style.color = "green";
          saveStatus.textContent = "Updated in memory";
          setTimeout(() => {
            saveStatus.textContent = "";
          }, 1000);
        }

        if (afterFn) afterFn();
        loadMaskSlice(viewState.z);
      })
      .catch((err) => {
        console.error(err);
        if (!quiet && saveStatus) {
          saveStatus.style.color = "red";
          saveStatus.textContent = "Update failed";
        }
        if (afterFn) afterFn();
      });
  }

  function clearMaskCanvas() {
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  }

  function drawMask() {
    if (!maskImage || !viewState.labelId) {
      clearMaskCanvas();
      return;
    }

    const imgW = maskImage.width;
    const imgH = maskImage.height;

    clearMaskCanvas();
    applyViewTransform(maskCtx, imgW, imgH);
    maskCtx.drawImage(maskImage, 0, 0);

    // Make mask pixels fully opaque (keep CSS opacity controlling transparency)
    maskCtx.setTransform(1, 0, 0, 1, 0, 0);
    const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const data = imageData.data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) data[i] = 255;
    }
    maskCtx.putImageData(imageData, 0, 0);
  }

  function loadMaskSlice(idx) {
    const labelVal = viewState.labelId;

    if (!labelVal) {
      maskCanvas.style.display = "none";
      maskImage = null;
      maskKey = null;
      clearMaskCanvas();
      return;
    }

    maskCanvas.style.display = "block";

    const key = `${idx}:${labelVal}`;
    if (maskKey === key && maskImage) {
      drawMask();
      return;
    }

    const url = "/slice_mask/" + idx + "/" + labelVal + "?_=" + Date.now();
    const img = new Image();

    img.onload = function () {
      maskImage = img;
      maskKey = key;

      // canvases already sized by CT load, but safe to keep aligned
      if (maskCanvas.width !== img.width || maskCanvas.height !== img.height) {
        maskCanvas.width = img.width;
        maskCanvas.height = img.height;
      }

      drawMask();
    };

    img.src = url;
  }

  function clearCtCanvas() {
    ctCtx.setTransform(1, 0, 0, 1, 0, 0);
    ctCtx.clearRect(0, 0, ctCanvas.width, ctCanvas.height);
  }

  function drawCt() {
    if (!ctImage) return;

    const imgW = ctImage.width;
    const imgH = ctImage.height;

    clearCtCanvas();
    applyViewTransform(ctCtx, imgW, imgH);
    ctCtx.drawImage(ctImage, 0, 0);

    // reset for safety
    ctCtx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function loadCtSlice(idx) {
    const url = "/slice_bg/" + idx + "?_=" + Date.now();
    const img = new Image();

    img.onload = function () {
      ctImage = img;
      ctKey = idx;

      // Keep canvases same size and aligned
      ctCanvas.width = img.width;
      ctCanvas.height = img.height;

      maskCanvas.width = img.width;
      maskCanvas.height = img.height;

      drawCt();
      // If mask already loaded for this z/label, redraw it too under new sizes
      drawMask();
    };

    img.src = url;
  }

  function render() {
    const idx = viewState.z;
    if (idx === null) return;

    if (isNaN(idx) || idx < 0 || idx >= numSlices) {
      sliceError.textContent = "Index out of range";
      return;
    }
    sliceError.textContent = "";

    // Keep UI in sync with state
    sliceInput.value = idx;
    if (zoomInput) zoomInput.value = viewState.zoom;
    if (panXInput) panXInput.value = viewState.panX;
    if (panYInput) panYInput.value = viewState.panY;

    // CT: only fetch if slice changed, otherwise just redraw (for zoom/pan)
    if (ctKey !== idx || !ctImage) {
      loadCtSlice(idx);
    } else {
      drawCt();
    }

    // Mask: fetch only if (z,label) changed, otherwise redraw
    loadMaskSlice(idx);
  }

  // undo/redo handlers
  function afterSegmentationChanged() {
    // mask PNG is now stale
    maskImage = null;
    maskKey = null;
    render();
  }

  undoBtn.addEventListener("click", function () {
    // Commit any pending strokes first
    sendStrokesToBackend(true, function () {
      fetch("/api/undo", { method: "POST" })
        .then((res) => res.json())
        .then((data) => {
          if (data.status === "empty") {
            saveStatus.style.color = "black";
            saveStatus.textContent = "Nothing to undo";
            setTimeout(() => (saveStatus.textContent = ""), 800);
            return;
          }
          afterSegmentationChanged();
        })
        .catch((err) => {
          console.error(err);
          saveStatus.style.color = "red";
          saveStatus.textContent = "Undo failed";
        });
    });
  });

  redoBtn.addEventListener("click", function () {
    sendStrokesToBackend(true, function () {
      fetch("/api/redo", { method: "POST" })
        .then((res) => res.json())
        .then((data) => {
          if (data.status === "empty") {
            saveStatus.style.color = "black";
            saveStatus.textContent = "Nothing to redo";
            setTimeout(() => (saveStatus.textContent = ""), 800);
            return;
          }
          afterSegmentationChanged();
        })
        .catch((err) => {
          console.error(err);
          saveStatus.style.color = "red";
          saveStatus.textContent = "Redo failed";
        });
    });
  });



  function initStateFromUI() {
    const initialZ = clampZ(parseInt(sliceInput.value, 10) || 0);
    viewState.z = initialZ;
    viewState.labelId = labelSelect.value || "";
    viewState.zoom = parseNum(zoomInput?.value, 0);
    viewState.panX = parseNum(panXInput?.value, 0);
    viewState.panY = parseNum(panYInput?.value, 0);
  }

  function updateBrushColorFromLabel() {
    const labelVal = viewState.labelId;
    if (!labelVal) {
      return;
    }

    const opt = labelSelect.options[labelSelect.selectedIndex];
    const rgbStr = opt.dataset.color;
    if (!rgbStr) {
      return;
    }

    const [r, g, b] = rgbStr.split(",").map(Number);
    if (window.MaskEditor && typeof window.MaskEditor.setColorFromRgb === "function") {
      window.MaskEditor.setColorFromRgb(r, g, b);
    }
  }

  // Update on slice index change
  sliceInput.addEventListener("input", function () {
    const newZ = clampZ(parseInt(sliceInput.value, 10));

    if (isNaN(newZ) || newZ < 0 || newZ >= numSlices) {
      sliceError.textContent = "Index out of range";
      return;
    }

    // First sync strokes for current slice, then change z
    sendStrokesToBackend(true, function () {
      setState({ z: newZ });
    });
  });

  // Update on label selection change
  labelSelect.addEventListener("change", function () {
    const newLabelId = labelSelect.value || "";

    // Commit strokes for the *previous* label before switching.
    // IMPORTANT: sendStrokesToBackend uses viewState.labelId (old one),
    // so do NOT setState(labelId) until after sync is done.
    sendStrokesToBackend(true, function () {
      setState({ labelId: newLabelId });
      updateBrushColorFromLabel();
    });
  });


  // Init MaskEditor
  if (window.MaskEditor) {
    window.MaskEditor.init({
      canvas: maskCanvas,
      modeIndicator: modeIndicator,
      toImageCoords: canvasToImage,
      getScale: getScale,
    });
  }

  // Wire Pen / Rubber buttons
  penBtn.addEventListener("click", function () {
    if (window.MaskEditor) {
      window.MaskEditor.setMode("pen");
    }
  });

  rubberBtn.addEventListener("click", function () {
    if (window.MaskEditor) {
      window.MaskEditor.setMode("rubber");
    }
  });

  // Wire Save button
  saveBtn.addEventListener("click", function () {
    const idx = viewState.z;
    if (
      idx === null ||
      isNaN(idx) ||
      idx < 0 ||
      idx >= numSlices
    ) {
      sliceError.textContent = "Index out of range";
      return;
    }

    // First: push any pending strokes for current slice/label into seg_vol
    const syncThenSave = function () {
      saveStatus.style.color = "black";
      saveStatus.textContent = "Saving to disk...";

      fetch("/api/save_all", {
        method: "POST",
      })
        .then((res) => res.json())
        .then((data) => {
          saveStatus.style.color = "green";
          saveStatus.textContent = "Saved to disk";
          setTimeout(() => {
            saveStatus.textContent = "";
          }, 1500);
        })
        .catch((err) => {
          console.error(err);
          saveStatus.style.color = "red";
          saveStatus.textContent = "Disk save failed";
        });
    };

    // sync strokes (non-quiet so user knows something is happening),
    // then export to .npy
    sendStrokesToBackend(false, syncThenSave);
    
  });

  function parseNum(val, fallback = 0) {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function onViewChange(patch) {
    // Important: if user drew something, commit it before changing view
    sendStrokesToBackend(true, function () {
      setState(patch);
    });
  }

  zoomInput.addEventListener("input", function () {
    onViewChange({ zoom: parseNum(zoomInput.value, 0) });
  });

  panXInput.addEventListener("input", function () {
    onViewChange({ panX: parseNum(panXInput.value, 0) });
  });

  panYInput.addEventListener("input", function () {
    onViewChange({ panY: parseNum(panYInput.value, 0) });
  });


  // Initial load (middle slice, no mask)
  window.addEventListener("load", function () {
    initStateFromUI();
    render();
    updateBrushColorFromLabel();
  });
})();

// static/js/viewer.js

(function () {
  // numSlices is injected from the template as window.numSlices
  const numSlices = window.numSlices;

  const sliceInput = document.getElementById("sliceInput");
  const sliceError = document.getElementById("sliceError");
  const labelSelect = document.getElementById("labelSelect");
  const ctImg = document.getElementById("ctImg");
  const maskCanvas = document.getElementById("maskCanvas");
  const maskCtx = maskCanvas.getContext("2d");

  const penBtn = document.getElementById("penBtn");
  const rubberBtn = document.getElementById("rubberBtn");
  const modeIndicator = document.getElementById("modeIndicator");

  const saveBtn = document.getElementById("saveBtn");
  const saveStatus = document.getElementById("saveStatus");

  let currentSliceIdx = null;

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

    const idx = currentSliceIdx;
    const labelVal = labelSelect.value;

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

        if (!quiet && saveStatus) {
          saveStatus.style.color = "green";
          saveStatus.textContent = "Updated in memory";
          setTimeout(() => {
            saveStatus.textContent = "";
          }, 1000);
        }

        if (afterFn) afterFn();
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

  function loadMaskSlice(idx, labelVal, cacheBust) {
    if (!labelVal) {
      maskCanvas.style.display = "none";
      clearMaskCanvas();
      return;
    }

    maskCanvas.style.display = "block";

    const url = "/slice_mask/" + idx + "/" + labelVal + "?_=" + cacheBust;
    const img = new Image();

    img.onload = function () {
      // Match canvas size to mask image size
      maskCanvas.width = img.width;
      maskCanvas.height = img.height;

      clearMaskCanvas();
      maskCtx.drawImage(img, 0, 0);

      // Remove per-pixel alpha: make all non-transparent mask pixels fully opaque
      const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
      const data = imageData.data; // [R,G,B,A,...]

      for (let i = 3; i < data.length; i += 4) {
        // if pixel is part of the mask (alpha > 0), set alpha to 255
        if (data[i] !== 0) {
          data[i] = 255;
        }
      }

      maskCtx.putImageData(imageData, 0, 0);
    };

    img.src = url;
  }
  function loadImagesFor(idx) {
    if (isNaN(idx) || idx < 0 || idx >= numSlices) {
      sliceError.textContent = "Index out of range";
      return;
    }
    sliceError.textContent = "";

    const cacheBust = Date.now();

    // Keep input in sync with current slice
    sliceInput.value = idx;

    // Background CT slice
    ctImg.src = "/slice_bg/" + idx + "?_=" + cacheBust;

    // Mask overlay
    const labelVal = labelSelect.value;
    loadMaskSlice(idx, labelVal, cacheBust);
  }

  function loadImages() {
    if (currentSliceIdx === null) {
      const initialIdx = parseInt(sliceInput.value, 10) || 0;
      currentSliceIdx = initialIdx;
    }
    loadImagesFor(currentSliceIdx);
  }

  function updateBrushColorFromLabel() {
    const labelVal = labelSelect.value;
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
    const newIdx = parseInt(sliceInput.value, 10);

    if (isNaN(newIdx) || newIdx < 0 || newIdx >= numSlices) {
      sliceError.textContent = "Index out of range";
      return;
    }

    // First sync strokes for currentSliceIdx, then update and load new slice
    sendStrokesToBackend(true, function () {
      currentSliceIdx = newIdx;
      loadImagesFor(newIdx);
    });
  });

  // Update on label selection change
  labelSelect.addEventListener("change", function () {
    // When changing label, drop unsaved strokes from previous label
    if (window.MaskEditor) {
      window.MaskEditor.clearStrokes();
    }
    updateBrushColorFromLabel();
    loadImages();
  });

  // Init MaskEditor
  if (window.MaskEditor) {
    window.MaskEditor.init({
      canvas: maskCanvas,
      modeIndicator: modeIndicator,
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
    const idx = currentSliceIdx;
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

  // Initial load (middle slice, no mask)
  window.addEventListener("load", function () {
    loadImages();
    // If a label is already selected (rare, but just in case), sync color
    updateBrushColorFromLabel();
  });
})();

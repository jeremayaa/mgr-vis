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


  function loadImages() {
    const idx = parseInt(sliceInput.value, 10);
    if (isNaN(idx) || idx < 0 || idx >= numSlices) {
      sliceError.textContent = "Index out of range";
      return;
    }
    sliceError.textContent = "";

    const cacheBust = Date.now();

    // Background CT slice
    ctImg.src = "/slice_bg/" + idx + "?_=" + cacheBust;

    // Mask overlay
    const labelVal = labelSelect.value;
    loadMaskSlice(idx, labelVal, cacheBust);
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
  sliceInput.addEventListener("input", loadImages);

  // Update on label selection change
  labelSelect.addEventListener("change", function () {
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

  // Initial load (middle slice, no mask)
  window.addEventListener("load", function () {
    loadImages();
    // If a label is already selected (rare, but just in case), sync color
    updateBrushColorFromLabel();
  });
})();

// static/js/viewer.js

(function () {
  // numSlices is injected from the template as window.numSlices
  const numSlices = window.numSlices;

  const sliceInput = document.getElementById("sliceInput");
  const sliceError = document.getElementById("sliceError");
  const labelSelect = document.getElementById("labelSelect");
  const ctImg = document.getElementById("ctImg");
  const maskImg = document.getElementById("maskImg");

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

    // Mask overlay (only if label selected)
    const labelVal = labelSelect.value;
    if (labelVal) {
      maskImg.style.display = "block";
      maskImg.src = "/slice_mask/" + idx + "/" + labelVal + "?_=" + cacheBust;
    } else {
      maskImg.style.display = "none";
    }
  }

  // Update on slice index change
  sliceInput.addEventListener("input", loadImages);

  // Update on label selection change
  labelSelect.addEventListener("change", loadImages);

  // Initial load (middle slice, no mask)
  window.addEventListener("load", loadImages);
})();

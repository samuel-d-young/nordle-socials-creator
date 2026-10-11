// Runs before the page paints, so the chosen theme never flashes. "system" (nothing stored) follows the computer.
(function () {
  try {
    var t = localStorage.getItem('nordle-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* storage can be blocked; the system theme is used */ }
})();

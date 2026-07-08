// Runs synchronously before first paint so light-theme users never see a dark
// flash. Kept as an external file so the CSP needs no inline-script exception.
;(function () {
  try {
    var theme = localStorage.getItem('bettertts-theme')
    if (theme !== 'light' && theme !== 'dark') {
      theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    }
    document.documentElement.dataset.theme = theme
  } catch (e) {
    /* storage blocked — App applies the theme post-mount */
  }
})()

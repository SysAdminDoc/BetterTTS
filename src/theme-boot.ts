// Runs before the React entrypoint paints so light-theme users never see a
// dark flash. This is a module entry rather than a public classic script so
// Vite can verify it and the build budget can count it as initial shell bytes.
try {
  let theme = window.localStorage.getItem('bettertts-theme')
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  document.documentElement.dataset.theme = theme
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#05070a' : '#fbfcfe')
} catch {
  // Storage can be blocked; AppShell applies the theme after it mounts.
}

export {}

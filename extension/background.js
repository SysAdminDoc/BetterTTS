const BETTERTTS_URL = 'https://sysadmindoc.github.io/BetterTTS/'
const MAX_TEXT_CHARS = 5000
const SELECTION_MENU_ID = 'bettertts-listen-selection'
const PAGE_MENU_ID = 'bettertts-listen-page'

function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: SELECTION_MENU_ID,
      title: 'Listen in BetterTTS',
      contexts: ['selection'],
    })
    chrome.contextMenus.create({
      id: PAGE_MENU_ID,
      title: 'Listen in BetterTTS',
      contexts: ['page'],
    })
  })
}

function normalizeText(text) {
  return typeof text === 'string' ? text.trim().slice(0, MAX_TEXT_CHARS) : ''
}

function openBetterTTS(text) {
  const normalized = normalizeText(text)
  if (!normalized) return
  const target = new URL(BETTERTTS_URL)
  target.searchParams.set('source', 'extension')
  target.searchParams.set('text', normalized)
  void chrome.tabs.create({ url: target.toString() })
}

async function readPageText(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const content = document.querySelector('article, main') ?? document.body
      return content?.innerText ?? ''
    },
  })
  return results[0]?.result ?? ''
}

async function handleRequest(info, tab) {
  if (!tab?.id) return
  if (typeof info.selectionText === 'string' && info.selectionText.trim()) {
    openBetterTTS(info.selectionText)
    return
  }
  try {
    openBetterTTS(await readPageText(tab.id))
  } catch {
    // Chrome internal pages and protected documents reject activeTab scripting.
  }
}

chrome.runtime.onInstalled.addListener(registerContextMenus)
chrome.runtime.onStartup.addListener(registerContextMenus)
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleRequest(info, tab)
})
chrome.action.onClicked.addListener((tab) => {
  void handleRequest({}, tab)
})
registerContextMenus()

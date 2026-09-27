// Only handles the toolbar button. File bytes never pass through the worker.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  if (tab.url?.startsWith('https://drive.google.com/')) {
    try {
      await chrome.tabs.sendMessage(tab.id, {type: 'DIP_OPEN_SELECTED'});
      return;
    } catch { /* A pre-install tab must be reloaded before injection. */ }
  }
  await chrome.tabs.create({url: chrome.runtime.getURL('viewer.html')});
});

// background.js — service worker
// Opens the side panel on action click. The side panel itself owns the analysis flow.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[serm-snapshot] setPanelBehavior failed', err));

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.error('[serm-snapshot] sidePanel.open failed', err);
  }
});

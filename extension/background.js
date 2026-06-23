/**
 * background.js — Service worker for Rob's Job Scout (MV3)
 *
 * Responsibilities:
 *   - On install: configure the side panel to open automatically when the
 *     toolbar icon is clicked (setPanelBehavior).
 *   - On action click: open the side panel for the current tab as a fallback
 *     (covers edge cases where the panel behaviour hasn't propagated yet).
 */

// Open the side panel whenever the toolbar icon is clicked.
// chrome.sidePanel.open() requires a user gesture — the action click
// qualifies, so this is the correct place to call it.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Tell Chrome to open the side panel automatically on every action click.
// This is the preferred MV3 pattern; the onClicked listener above is a
// belt-and-suspenders fallback.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

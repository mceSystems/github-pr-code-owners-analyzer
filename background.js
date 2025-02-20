// Initialize extension state
chrome.runtime.onInstalled.addListener(() => {
    console.log('GitHub PR Code Owners Analyzer installed');
    chrome.storage.local.set({ enabled: true });
});

// Handle extension icon clicks
chrome.action.onClicked.addListener(async () => {
    const { enabled } = await chrome.storage.local.get(['enabled']);
    const newState = !enabled;
    
    await chrome.storage.local.set({ enabled: newState });
    updateExtensionIcon(newState);
    
    // Send message to all GitHub tabs about the state change
    const tabs = await chrome.tabs.query({ url: '*://github.com/*' });
    tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { action: 'stateChanged', enabled: newState });
    });
});

// Function to update extension icon
function updateExtensionIcon(enabled) {
    chrome.action.setIcon({
        path: {
            16: `icons/icon16${enabled ? '' : '_disabled'}.png`,
            48: `icons/icon48${enabled ? '' : '_disabled'}.png`,
            128: `icons/icon128${enabled ? '' : '_disabled'}.png`
        }
    });
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'updateIcon') {
        updateExtensionIcon(message.enabled);
    }
}); 
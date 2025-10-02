// Log when extension is installed
chrome.runtime.onInstalled.addListener(() => {
    console.log('GitHub PR Code Owners Analyzer installed');
}); 
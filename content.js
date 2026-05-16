// Content script — intentionally empty.
//
// This extension does NOT inject any logic into Salesforce pages.
// All Salesforce API calls are made from the service worker (background.js)
// using the session cookie read via chrome.cookies (HttpOnly-safe).
// The popup communicates with the service worker via chrome.runtime.sendMessage.
//
// No content script is registered in manifest.json — this file is kept
// only for reference and is not loaded into any page.

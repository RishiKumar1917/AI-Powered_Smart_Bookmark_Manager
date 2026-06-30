document.addEventListener('DOMContentLoaded', () => {
  const urlDisplay = document.getElementById('urlDisplay');
  const saveBtn = document.getElementById('saveBtn');
  const status = document.getElementById('status');
  
  let currentTabId = null;

  // Grab the current tab's URL
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      currentTabId = tabs[0].id;
      urlDisplay.value = tabs[0].url;
    }
  });

  saveBtn.addEventListener('click', async () => {
    const url = urlDisplay.value;
    if (!url || !currentTabId) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    status.textContent = 'Reading page...';

    // 1. Ask Chrome to run a tiny script in the user's active tab to grab the text!
    chrome.scripting.executeScript(
      {
        target: { tabId: currentTabId },
        func: () => {
          // This runs INSIDE the webpage, so it has access to private content!
          return document.body.innerText.replace(/\s+/g, ' ').substring(0, 3000);
        },
      },
      async (injectionResults) => {
        let pageText = '';
        if (injectionResults && injectionResults[0].result) {
          pageText = injectionResults[0].result;
        }

        status.textContent = 'Sending to local server (AI is analyzing)...';

        try {
          // 2. Send both the URL AND the text to our backend
          const response = await fetch('https://ai-poweredsmartbookmarkmanager-production.up.railway.app/api/bookmarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url, pageText: pageText })
          });

          if (response.ok) {
            status.textContent = '✅ Bookmark saved & analyzed!';
            status.style.color = 'green';
            saveBtn.textContent = 'Saved!';
          } else {
            throw new Error('Server returned an error');
          }
        } catch (error) {
          status.textContent = '❌ Failed to save. Is your cloud server running?';
          status.style.color = 'red';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Try Again';
        }
      }
    );
  });
});

document.addEventListener('DOMContentLoaded', async () => {
  const urlDisplay = document.getElementById('urlDisplay');
  const saveBtn = document.getElementById('saveBtn');
  const status = document.getElementById('status');
  
  let currentTabId = null;
  let authToken = null;

  // 1. Check if the user is logged into our web app by reading the cookie!
  try {
    const cookie = await chrome.cookies.get({
      url: 'https://ai-poweredsmartbookmarkmanager-production.up.railway.app',
      name: 'token'
    });
    if (cookie && cookie.value) {
      authToken = cookie.value;
    } else {
      status.textContent = '❌ Please log into the web app first.';
      status.style.color = 'red';
      saveBtn.disabled = true;
      return;
    }
  } catch(e) {
    status.textContent = '❌ Error checking login status.';
    return;
  }

  // Grab the current tab's URL
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      currentTabId = tabs[0].id;
      urlDisplay.value = tabs[0].url;
    }
  });

  saveBtn.addEventListener('click', async () => {
    const url = urlDisplay.value;
    if (!url || !currentTabId || !authToken) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    status.textContent = 'Reading page...';

    // Ask Chrome to run a tiny script in the user's active tab to grab the text!
    chrome.scripting.executeScript(
      {
        target: { tabId: currentTabId },
        func: () => {
          return document.body.innerText.replace(/\s+/g, ' ').substring(0, 3000);
        },
      },
      async (injectionResults) => {
        let pageText = '';
        if (injectionResults && injectionResults[0].result) {
          pageText = injectionResults[0].result;
        }

        status.textContent = 'Sending to AI for analysis...';

        try {
          // Send the URL, Text, AND AUTH TOKEN to our backend
          const response = await fetch('https://ai-poweredsmartbookmarkmanager-production.up.railway.app/api/bookmarks', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ url: url, pageText: pageText })
          });

          if (response.ok) {
            status.textContent = '✅ Bookmark saved securely!';
            status.style.color = 'green';
            saveBtn.textContent = 'Saved!';
          } else {
            throw new Error('Server returned an error. Are you logged in?');
          }
        } catch (error) {
          status.textContent = '❌ Failed to save. Ensure you are logged in.';
          status.style.color = 'red';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Try Again';
        }
      }
    );
  });
});

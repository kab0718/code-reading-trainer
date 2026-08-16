chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GET_PAGE_CONTEXT") {
    return;
  }

  sendResponse({
    url: window.location.href,
    title: document.title,
    selectedText: window.getSelection()?.toString().trim() ?? "",
  });
});

const statusElement = document.querySelector("#status");
const selectionButton = document.querySelector("#selection-button");
const selectionSection = document.querySelector("#selection");
const selectedCodeElement = document.querySelector("#selected-code");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getPageContext() {
  const tab = await getActiveTab();

  if (!tab?.id || !tab.url?.startsWith("https://github.com/")) {
    throw new Error("GitHubのページを開いてください。");
  }

  return chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_CONTEXT" });
}

async function updateStatus() {
  try {
    await getPageContext();
    statusElement.textContent =
      "GitHub上のコードを選択して、トレーニングを始められます。";
  } catch (error) {
    statusElement.textContent = error.message;
  }
}

selectionButton.addEventListener("click", async () => {
  try {
    const context = await getPageContext();

    if (!context.selectedText) {
      statusElement.textContent =
        "GitHub上で説明したいコードを選択してください。";
      return;
    }

    selectedCodeElement.textContent = context.selectedText;
    selectionSection.hidden = false;
    statusElement.textContent =
      "選択したコードを読み、自分の言葉で説明してみましょう。";
  } catch (error) {
    statusElement.textContent = error.message;
  }
});

updateStatus();

const { PAGE_STATUS, analyzeGitHubPage } =
  globalThis.CodeReadingTrainerPageContext;

function readMetaContent(name) {
  return document.querySelector(`meta[name="${name}"]`)?.content;
}

function readEmbeddedData() {
  const element = document.querySelector(
    'react-app[app-name="react-code-view"] script[data-target="react-app.embeddedData"]',
  );

  if (!element?.textContent) {
    return undefined;
  }

  try {
    return JSON.parse(element.textContent);
  } catch {
    return undefined;
  }
}

function getPageContext() {
  const page = analyzeGitHubPage({
    url: window.location.href,
    repositoryNwo: readMetaContent("octolytics-dimension-repository_nwo"),
    repositoryPublic: readMetaContent("octolytics-dimension-repository_public"),
    embeddedData: readEmbeddedData(),
  });

  return {
    ...page,
    title: document.title,
    selectedText:
      page.status === PAGE_STATUS.ELIGIBLE
        ? (window.getSelection()?.toString() ?? "")
        : "",
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GET_PAGE_CONTEXT") {
    return;
  }

  sendResponse(getPageContext());
});

let scheduledReport;

function pageContextSignature(context) {
  return JSON.stringify([
    context.url,
    context.status,
    context.reason,
    context.repository,
    context.ref,
    context.path,
  ]);
}

let lastReportedContext = pageContextSignature(getPageContext());

function reportPageChange() {
  window.clearTimeout(scheduledReport);
  scheduledReport = undefined;

  const context = getPageContext();
  const signature = pageContextSignature(context);
  if (signature === lastReportedContext) {
    return;
  }

  lastReportedContext = signature;
  chrome.runtime
    .sendMessage({ type: "PAGE_CONTEXT_CHANGED" })
    .catch(() => undefined);
}

function schedulePageChangeReport() {
  if (scheduledReport) {
    return;
  }

  scheduledReport = window.setTimeout(reportPageChange, 100);
}

document.addEventListener("turbo:load", reportPageChange);
window.addEventListener("popstate", schedulePageChangeReport);

const navigationObserver = new MutationObserver(schedulePageChangeReport);
navigationObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

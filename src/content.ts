(() => {
  const { PAGE_STATUS, analyzeGitHubPage } =
    globalThis.CodeReadingTrainerPageContext;

  function readMetaContent(name: string): string | undefined {
    return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
      ?.content;
  }

  function readEmbeddedData(): unknown {
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

  function getPageContext(): PageContext {
    const page = analyzeGitHubPage({
      url: window.location.href,
      repositoryNwo: readMetaContent("octolytics-dimension-repository_nwo"),
      repositoryPublic: readMetaContent(
        "octolytics-dimension-repository_public",
      ),
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

  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "GET_PAGE_CONTEXT"
      ) {
        return;
      }

      sendResponse(getPageContext());
    },
  );

  let scheduledReport: number | undefined;

  function pageContextSignature(context: PageContext): string {
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

  function reportPageChange(): void {
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

  function schedulePageChangeReport(): void {
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
})();

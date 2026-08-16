(() => {
  function requireElement<T extends Element>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) {
      throw new Error(`Required element was not found: ${selector}`);
    }
    return element;
  }

  const statusElement = requireElement<HTMLElement>("#status");
  const selectionButton =
    requireElement<HTMLButtonElement>("#selection-button");
  const selectionSection = requireElement<HTMLFormElement>("#selection");
  const selectedCodeElement = requireElement<HTMLElement>("#selected-code");
  const explanationElement =
    requireElement<HTMLTextAreaElement>("#explanation");
  const explanationCountElement =
    requireElement<HTMLElement>("#explanation-count");
  const inputErrorElement = requireElement<HTMLElement>("#input-error");
  const evaluationButton =
    requireElement<HTMLButtonElement>("#evaluation-button");

  const inputValidation = globalThis.CodeReadingTrainerInputValidation;

  const PAGE_STATUS = Object.freeze({
    ELIGIBLE: "eligible",
    UNSUPPORTED: "unsupported",
  });

  const unsupportedMessages: Readonly<Record<UnsupportedReason, string>> =
    Object.freeze({
      "not-github": "GitHubのページを開いてください。",
      "not-code-view": "GitHubでファイルのコード表示ページを開いてください。",
      "not-python": "拡張子が.pyのPythonファイルを開いてください。",
      "private-repository": "public repositoryのPythonファイルだけが対象です。",
      "visibility-unknown":
        "repositoryがpublicか確認できません。ページを再読み込みしてください。",
      "page-data-unavailable":
        "ページ情報を取得できませんでした。読み込み完了後にもう一度お試しください。",
      "invalid-url": "現在のページURLを確認できませんでした。",
    });
  let activePageKey: string | null = null;

  async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab;
  }

  async function getPageContext(): Promise<PageContext> {
    const tab = await getActiveTab();

    if (!tab?.id || !tab.url?.startsWith("https://github.com/")) {
      return {
        status: PAGE_STATUS.UNSUPPORTED,
        reason: "not-github",
        url: tab?.url ?? "",
        repository: null,
        ref: null,
        path: null,
      };
    }

    return chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_CONTEXT" });
  }

  function resetSelection(): void {
    selectedCodeElement.textContent = "";
    explanationElement.value = "";
    explanationElement.setAttribute("aria-invalid", "false");
    explanationCountElement.textContent = `0 / ${inputValidation.INPUT_LIMITS.explanation.toLocaleString("ja-JP")}文字`;
    inputErrorElement.textContent = "";
    evaluationButton.disabled = true;
    selectionSection.hidden = true;
  }

  function updateInputValidation(): TrainingInputValidation {
    const validation = inputValidation.validateTrainingInput(
      selectedCodeElement.textContent,
      explanationElement.value,
    );

    explanationCountElement.textContent = `${validation.explanationCharacterCount.toLocaleString("ja-JP")} / ${inputValidation.INPUT_LIMITS.explanation.toLocaleString("ja-JP")}文字`;
    explanationElement.setAttribute(
      "aria-invalid",
      validation.explanationError ? "true" : "false",
    );
    inputErrorElement.textContent =
      validation.codeError ?? validation.explanationError ?? "";
    evaluationButton.disabled = !validation.valid;

    return validation;
  }

  function applyPageContext(context: PageContext): void {
    const isEligible = context.status === PAGE_STATUS.ELIGIBLE;
    const nextPageKey = isEligible
      ? JSON.stringify([context.repository, context.ref, context.path])
      : null;
    selectionButton.disabled = !isEligible;

    if (isEligible) {
      if (activePageKey && activePageKey !== nextPageKey) {
        resetSelection();
      }
      activePageKey = nextPageKey;
      statusElement.textContent = `${context.repository} の ${context.path}（${context.ref}）でトレーニングできます。`;
      return;
    }

    resetSelection();
    activePageKey = null;
    statusElement.textContent =
      unsupportedMessages[context.reason] ??
      "このページはトレーニング対象外です。";
  }

  function getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.startsWith("GitHub")) {
      return error.message;
    }

    return "ページ情報を取得できませんでした。GitHubページを再読み込みしてください。";
  }

  async function updateStatus(): Promise<void> {
    try {
      applyPageContext(await getPageContext());
    } catch (error) {
      selectionButton.disabled = true;
      resetSelection();
      statusElement.textContent = getErrorMessage(error);
    }
  }

  selectionButton.addEventListener("click", async () => {
    try {
      const context = await getPageContext();

      if (context.status !== PAGE_STATUS.ELIGIBLE) {
        applyPageContext(context);
        return;
      }

      applyPageContext(context);

      if (!context.selectedText) {
        resetSelection();
        statusElement.textContent =
          "GitHub上で説明したいコードを選択してください。";
        return;
      }

      const validation = inputValidation.validateTrainingInput(
        context.selectedText,
        "",
      );
      if (validation.codeError) {
        resetSelection();
        statusElement.textContent = validation.codeError;
        return;
      }

      resetSelection();
      selectedCodeElement.textContent = context.selectedText;
      selectionSection.hidden = false;
      statusElement.textContent =
        "選択したコードを読み、自分の言葉で説明してみましょう。";
      updateInputValidation();
    } catch (error) {
      statusElement.textContent = getErrorMessage(error);
    }
  });

  explanationElement.addEventListener("input", updateInputValidation);

  selectionSection.addEventListener("submit", (event: SubmitEvent) => {
    event.preventDefault();

    if (!updateInputValidation().valid) {
      return;
    }

    statusElement.textContent =
      "入力内容を確認しました。評価機能は準備中です。";
  });

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "PAGE_CONTEXT_CHANGED"
    ) {
      updateStatus();
    }
  });

  chrome.tabs.onActivated.addListener(updateStatus);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) {
      updateStatus();
    }
  });

  updateStatus();
})();

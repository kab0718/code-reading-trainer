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
  const evaluationResultElement =
    requireElement<HTMLElement>("#evaluation-result");
  const totalScoreElement = requireElement<HTMLElement>("#total-score-value");
  const criteriaListElement =
    requireElement<HTMLUListElement>("#criteria-list");
  const strengthsListElement =
    requireElement<HTMLUListElement>("#strengths-list");
  const gapsListElement = requireElement<HTMLUListElement>("#gaps-list");

  const inputValidation = globalThis.CodeReadingTrainerInputValidation;
  const evaluationContract = globalThis.CodeReadingTrainerEvaluationContract;

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
  let selectedSourceUrl: string | null = null;
  let evaluationState: EvaluationUiState = { status: "editing" };
  let evaluationAttempt = 0;
  let pageContextAttempt = 0;
  let retryAfterUntil: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetryAfterCooldown(deadline: number): void {
    if (retryAfterUntil === deadline && retryTimer !== null) return;

    clearRetryTimer();
    retryAfterUntil = deadline;
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        if (retryAfterUntil === deadline) {
          retryAfterUntil = null;
          if (evaluationState.status === "error") {
            evaluationState = { ...evaluationState, retryAfterUntil: null };
          }
          updateInputValidation();
        }
      },
      Math.max(0, deadline - Date.now()),
    );
    updateInputValidation();
  }

  function isEvaluationLocked(): boolean {
    return (
      evaluationState.status === "submitting" ||
      evaluationState.status === "completed"
    );
  }

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
    evaluationAttempt += 1;
    evaluationState = { status: "editing" };
    selectedSourceUrl = null;
    selectedCodeElement.textContent = "";
    explanationElement.value = "";
    explanationElement.readOnly = false;
    explanationElement.setAttribute("aria-invalid", "false");
    explanationCountElement.textContent = `0 / ${inputValidation.INPUT_LIMITS.explanation.toLocaleString("ja-JP")}文字`;
    inputErrorElement.textContent = "";
    evaluationButton.disabled = true;
    evaluationButton.textContent = "評価する";
    selectionSection.hidden = true;
    evaluationResultElement.hidden = true;
    totalScoreElement.textContent = "";
    criteriaListElement.replaceChildren();
    strengthsListElement.replaceChildren();
    gapsListElement.replaceChildren();
  }

  function appendFeedbackItems(
    list: HTMLUListElement,
    items: readonly string[],
    emptyMessage: string,
  ): void {
    list.replaceChildren();

    if (items.length === 0) {
      const emptyItem = document.createElement("li");
      emptyItem.className = "feedback-empty";
      emptyItem.textContent = emptyMessage;
      list.append(emptyItem);
      return;
    }

    for (const item of items) {
      const listItem = document.createElement("li");
      listItem.textContent = item;
      list.append(listItem);
    }
  }

  function renderEvaluationResult(response: EvaluationResponse): void {
    totalScoreElement.textContent = response.totalScore.toLocaleString("ja-JP");
    criteriaListElement.replaceChildren();

    for (const criterion of response.criteria) {
      if (!criterion.applicable) continue;

      const listItem = document.createElement("li");
      listItem.className = "criterion";

      const heading = document.createElement("div");
      heading.className = "criterion-heading";

      const label = document.createElement("span");
      label.className = "criterion-label";
      label.textContent = criterion.label;

      const score = document.createElement("span");
      score.className = "criterion-score";
      score.textContent = `${criterion.score} / ${criterion.maxScore}点`;

      const feedback = document.createElement("p");
      feedback.className = "criterion-feedback";
      feedback.textContent = criterion.feedback;

      heading.append(label, score);
      listItem.append(heading, feedback);
      criteriaListElement.append(listItem);
    }

    appendFeedbackItems(
      strengthsListElement,
      response.strengths,
      "特に挙げられた点はありません。",
    );
    appendFeedbackItems(
      gapsListElement,
      response.gaps,
      "不足点は挙げられていません。",
    );
    evaluationResultElement.hidden = false;
  }

  function updateInputValidation(): TrainingInputValidation {
    const validation = inputValidation.validateTrainingInput(
      selectedCodeElement.textContent,
      explanationElement.value,
    );

    explanationCountElement.textContent = `${validation.explanationCharacterCount.toLocaleString("ja-JP")} / ${inputValidation.INPUT_LIMITS.explanation.toLocaleString("ja-JP")}文字`;
    const apiInputError =
      evaluationState.status === "error" ? evaluationState.inputError : null;
    const explanationInvalid =
      validation.explanationError !== null ||
      (evaluationState.status === "error" &&
        evaluationState.explanationInvalid);
    explanationElement.setAttribute(
      "aria-invalid",
      explanationInvalid ? "true" : "false",
    );
    inputErrorElement.textContent =
      validation.codeError ??
      validation.explanationError ??
      apiInputError ??
      "";
    const retryWaiting =
      retryAfterUntil !== null && retryAfterUntil > Date.now();
    evaluationButton.disabled =
      !validation.valid ||
      isEvaluationLocked() ||
      (evaluationState.status === "error" && !evaluationState.retryable) ||
      retryWaiting;

    return validation;
  }

  function applyEvaluationState(nextState: EvaluationUiState): void {
    evaluationState = nextState;

    if (nextState.status === "editing") {
      explanationElement.readOnly = false;
      selectionButton.disabled = activePageKey === null;
      evaluationButton.textContent = "評価する";
    } else if (nextState.status === "submitting") {
      explanationElement.readOnly = true;
      selectionButton.disabled = true;
      evaluationButton.textContent = "評価中…";
      statusElement.textContent =
        "回答を評価しています。このまましばらくお待ちください。";
    } else if (nextState.status === "completed") {
      explanationElement.readOnly = true;
      selectionButton.disabled = true;
      evaluationButton.textContent = "評価済み";
      statusElement.textContent = `採点が完了しました（${nextState.response.totalScore} / 100点）。`;
      renderEvaluationResult(nextState.response);
    } else {
      if (
        nextState.retryAfterUntil !== null &&
        nextState.retryAfterUntil > Date.now()
      ) {
        scheduleRetryAfterCooldown(nextState.retryAfterUntil);
      }
      explanationElement.readOnly = false;
      selectionButton.disabled = activePageKey === null;
      evaluationButton.textContent = nextState.retryable
        ? "もう一度評価する"
        : "評価できません";
      statusElement.textContent = nextState.message;
    }

    updateInputValidation();
  }

  function applyPageContext(context: PageContext): void {
    const isEligible = context.status === PAGE_STATUS.ELIGIBLE;
    const nextPageKey = isEligible
      ? JSON.stringify([context.repository, context.ref, context.path])
      : null;
    selectionButton.disabled = !isEligible || isEvaluationLocked();

    if (isEligible) {
      if (activePageKey && activePageKey !== nextPageKey) {
        resetSelection();
      }
      activePageKey = nextPageKey;
      selectionButton.disabled = isEvaluationLocked();
      if (evaluationState.status === "editing") {
        statusElement.textContent = `${context.repository} の ${context.path}（${context.ref}）でトレーニングできます。`;
      }
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
    const attempt = ++pageContextAttempt;
    try {
      const context = await getPageContext();
      if (attempt !== pageContextAttempt) return;
      applyPageContext(context);
    } catch (error) {
      if (attempt !== pageContextAttempt) return;
      selectionButton.disabled = true;
      resetSelection();
      statusElement.textContent = getErrorMessage(error);
    }
  }

  selectionButton.addEventListener("click", async () => {
    if (isEvaluationLocked()) return;

    const attempt = ++pageContextAttempt;
    try {
      const context = await getPageContext();
      if (attempt !== pageContextAttempt) return;

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
      selectedSourceUrl = context.url;
      selectionSection.hidden = false;
      statusElement.textContent =
        "選択したコードを読み、自分の言葉で説明してみましょう。";
      updateInputValidation();
    } catch (error) {
      if (attempt !== pageContextAttempt) return;
      statusElement.textContent = getErrorMessage(error);
    }
  });

  explanationElement.addEventListener("input", () => {
    if (evaluationState.status === "error") {
      if (retryAfterUntil !== null && retryAfterUntil > Date.now()) {
        evaluationState = {
          ...evaluationState,
          explanationInvalid: false,
          inputError: null,
        };
        updateInputValidation();
        return;
      }
      applyEvaluationState({ status: "editing" });
      return;
    }
    updateInputValidation();
  });

  selectionSection.addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();

    if (
      isEvaluationLocked() ||
      (retryAfterUntil !== null && retryAfterUntil > Date.now()) ||
      !selectedSourceUrl ||
      !updateInputValidation().valid
    ) {
      return;
    }

    const request: EvaluationRequest = {
      code: selectedCodeElement.textContent ?? "",
      explanation: explanationElement.value,
      language: "python",
      sourceUrl: selectedSourceUrl,
    };
    const attempt = ++evaluationAttempt;
    applyEvaluationState({ status: "submitting" });

    try {
      const permissionOrigin =
        CodeReadingTrainerEvaluationConfig.getEvaluationApiPermissionOrigin();
      if (permissionOrigin) {
        const granted = await chrome.permissions.request({
          origins: [permissionOrigin],
        });
        if (attempt !== evaluationAttempt) return;
        if (!granted) {
          applyEvaluationState({
            explanationInvalid: false,
            inputError: null,
            message:
              "評価APIへの接続が許可されませんでした。回答は保持されています。もう一度お試しください。",
            retryAfterUntil: null,
            retryable: true,
            status: "error",
          });
          return;
        }
      }

      const result = (await chrome.runtime.sendMessage({
        request,
        type: "EVALUATE_ANSWER",
      })) as EvaluationWorkerResult | undefined;

      if (!result) {
        throw new Error("Background Workerから応答がありませんでした。");
      }

      const resultRetryAfterUntil =
        "error" in result &&
        result.error.code === "RATE_LIMITED" &&
        typeof result.error.retryAfterSeconds === "number"
          ? Date.now() + result.error.retryAfterSeconds * 1_000
          : null;
      if (resultRetryAfterUntil !== null) {
        scheduleRetryAfterCooldown(resultRetryAfterUntil);
      }

      if (attempt !== evaluationAttempt) return;

      if ("response" in result) {
        const response = evaluationContract.parseResponse(result.response);
        if (!response) {
          applyEvaluationState({
            explanationInvalid: false,
            inputError: null,
            message:
              "採点結果を正しく読み取れませんでした。回答は保持されています。もう一度お試しください。",
            retryAfterUntil: null,
            retryable: true,
            status: "error",
          });
          return;
        }
        applyEvaluationState({
          response,
          status: "completed",
        });
        return;
      }

      applyEvaluationState({
        explanationInvalid:
          result.error.details?.some(
            (detail) => detail.field === "explanation",
          ) ?? false,
        inputError:
          result.error.details && result.error.details.length > 0
            ? result.error.details
                .map((detail) => `${detail.field}: ${detail.reason}`)
                .join("\n")
            : null,
        message: result.error.message,
        retryAfterUntil: resultRetryAfterUntil,
        retryable: result.error.retryable,
        status: "error",
      });
    } catch {
      if (attempt !== evaluationAttempt) return;
      applyEvaluationState({
        explanationInvalid: false,
        inputError: null,
        message:
          "評価処理を開始できませんでした。回答は保持されています。もう一度お試しください。",
        retryAfterUntil: null,
        retryable: true,
        status: "error",
      });
    }
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

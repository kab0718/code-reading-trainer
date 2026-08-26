(() => {
  function requireElement<T extends Element>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) {
      throw new Error(`Required element was not found: ${selector}`);
    }
    return element;
  }

  const statusElement = requireElement<HTMLElement>("#status");
  const trainingMethodsElement =
    requireElement<HTMLElement>("#training-methods");
  const candidateRetryButton = requireElement<HTMLButtonElement>(
    "#candidate-retry-button",
  );
  const candidateSection = requireElement<HTMLElement>("#candidate-section");
  const candidateStatus = requireElement<HTMLElement>("#candidate-status");
  const candidateList = requireElement<HTMLElement>("#candidate-list");
  const sessionSection = requireElement<HTMLFormElement>("#training-session");
  const changeCandidateButton = requireElement<HTMLButtonElement>(
    "#change-candidate-button",
  );
  const selectedCodeElement = requireElement<HTMLElement>("#selected-code");
  const trainingInputElement = requireElement<HTMLElement>("#training-input");
  const readingInputElement = requireElement<HTMLElement>("#reading-input");
  const trainingModeButton = requireElement<HTMLButtonElement>(
    "#training-mode-button",
  );
  const readingModeButton = requireElement<HTMLButtonElement>(
    "#reading-mode-button",
  );
  const explanationElement =
    requireElement<HTMLTextAreaElement>("#explanation");
  const explanationCountElement =
    requireElement<HTMLElement>("#explanation-count");
  const inputErrorElement = requireElement<HTMLElement>("#input-error");
  const evaluationButton =
    requireElement<HTMLButtonElement>("#evaluation-button");
  const evaluationStatusElement =
    requireElement<HTMLElement>("#evaluation-status");
  const evaluationResultElement =
    requireElement<HTMLElement>("#evaluation-result");
  const evaluationResultTitle = requireElement<HTMLElement>(
    "#evaluation-result-title",
  );
  const evaluationResultStatus = requireElement<HTMLElement>(
    "#evaluation-result-status",
  );
  const totalScoreElement = requireElement<HTMLElement>("#total-score-value");
  const criteriaListElement =
    requireElement<HTMLUListElement>("#criteria-list");
  const strengthsListElement =
    requireElement<HTMLUListElement>("#strengths-list");
  const gapsListElement = requireElement<HTMLUListElement>("#gaps-list");
  const userAnswerElement = requireElement<HTMLElement>("#user-answer");
  const modelAnswerElement = requireElement<HTMLElement>("#model-answer");
  const newTrainingButton = requireElement<HTMLButtonElement>(
    "#new-training-button",
  );
  const readingInputErrorElement = requireElement<HTMLElement>(
    "#reading-input-error",
  );
  const readingStatusElement = requireElement<HTMLElement>("#reading-status");
  const readingRetryButton = requireElement<HTMLButtonElement>(
    "#reading-retry-button",
  );
  const readingResultElement = requireElement<HTMLElement>("#reading-result");
  const readingResultTitle = requireElement<HTMLElement>(
    "#reading-result-title",
  );
  const readingResultStatus = requireElement<HTMLElement>(
    "#reading-result-status",
  );
  const readingGuideContentElement = requireElement<HTMLElement>(
    "#reading-guide-content",
  );
  const focusPointsListElement =
    requireElement<HTMLUListElement>("#focus-points-list");
  const checksListElement = requireElement<HTMLUListElement>("#checks-list");
  const readingQuestionsListElement = requireElement<HTMLUListElement>(
    "#reading-questions-list",
  );
  const hintsListElement = requireElement<HTMLOListElement>("#hints-list");
  const nextCandidatesBlockElement = requireElement<HTMLElement>(
    "#next-candidates-block",
  );
  const nextCandidatesListElement = requireElement<HTMLUListElement>(
    "#next-candidates-list",
  );
  const readingResultErrorElement = requireElement<HTMLElement>(
    "#reading-result-error",
  );
  const detailButton = requireElement<HTMLButtonElement>("#detail-button");
  const detailStatusElement = requireElement<HTMLElement>("#detail-status");
  const detailErrorElement = requireElement<HTMLElement>("#detail-error");
  const detailedExplanationBlockElement = requireElement<HTMLElement>(
    "#detailed-explanation-block",
  );
  const detailedExplanationElement = requireElement<HTMLElement>(
    "#detailed-explanation",
  );
  const completeReadingButton = requireElement<HTMLButtonElement>(
    "#complete-reading-button",
  );
  const readingChangeCandidateButton = requireElement<HTMLButtonElement>(
    "#reading-change-candidate-button",
  );

  const inputValidation = globalThis.CodeReadingTrainerInputValidation;
  const evaluationContract = globalThis.CodeReadingTrainerEvaluationContract;
  const readingSupportContract =
    globalThis.CodeReadingTrainerReadingSupportContract;
  const analytics = globalThis.CodeReadingTrainerAnalytics;

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
  let activeCandidateContextKey: string | null = null;
  const CANDIDATE_CACHE_LIMIT = 12;
  const candidateCache = new Map<string, TrainingCandidate[]>();
  let candidateLoadingRequest: {
    contextKey: string;
    requestAttempt: number;
  } | null = null;
  let candidateRequestAttempt = 0;
  let selectedSourceUrl: string | null = null;
  let selectedCandidateId: string | null = null;
  let evaluationState: EvaluationUiState = { status: "editing" };
  let explanationTouched = false;
  let evaluationAttempt = 0;
  let pageContextAttempt = 0;
  let retryAfterUntil: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let newTrainingStarting = false;
  let selectedMode: "training" | "reading_support" = "training";
  let readingAttempt = 0;
  let readingSubmitting = false;
  let readingGuide: ReadingSupportResponse | null = null;
  let readingDetailedExplanation: string | null = null;
  let readingScreenVisible = false;
  let readingStartedRecorded = false;
  let readingGuideDisplayedRecorded = false;
  let readingDetailDisplayedRecorded = false;
  let readingApiInputError: string | null = null;
  let readingRetryable = true;
  let readingStatusMessage: string | null = null;

  function recordReadingEvent(
    name:
      | "reading_support_started"
      | "reading_support_guide_displayed"
      | "reading_support_detail_displayed"
      | "reading_support_completed",
    stage?: ReadingSupportStage,
  ): void {
    void analytics.record(name, stage).catch(() => undefined);
  }

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
          updateReadingInputValidation();
          if (
            readingGuide &&
            !detailedExplanationElement.textContent &&
            readingRetryable
          ) {
            detailButton.disabled = false;
            detailButton.textContent = "詳しい説明をもう一度取得する";
          }
        }
      },
      Math.max(0, deadline - Date.now()),
    );
    updateInputValidation();
    updateReadingInputValidation();
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

    const context = (await chrome.tabs.sendMessage(tab.id, {
      type: "GET_PAGE_CONTEXT",
    })) as PageContext;
    return { ...context, tabId: tab.id };
  }

  function resetSession(): void {
    evaluationAttempt += 1;
    readingAttempt += 1;
    evaluationState = { status: "editing" };
    readingSubmitting = false;
    readingGuide = null;
    readingDetailedExplanation = null;
    readingScreenVisible = false;
    readingStartedRecorded = false;
    readingGuideDisplayedRecorded = false;
    readingDetailDisplayedRecorded = false;
    readingApiInputError = null;
    readingRetryable = true;
    readingStatusMessage = null;
    selectedMode = "training";
    selectedSourceUrl = null;
    selectedCandidateId = null;
    candidateRequestAttempt += 1;
    activeCandidateContextKey = null;
    candidateSection.hidden = true;
    candidateStatus.textContent = "";
    candidateList.replaceChildren();
    candidateRetryButton.hidden = true;
    candidateRetryButton.disabled = activePageKey === null;
    selectedCodeElement.textContent = "";
    explanationElement.value = "";
    explanationTouched = false;
    explanationElement.readOnly = false;
    explanationElement.setAttribute("aria-invalid", "false");
    explanationCountElement.textContent = `0 / ${inputValidation.INPUT_LIMITS.explanation.toLocaleString("ja-JP")}文字`;
    inputErrorElement.textContent = "";
    readingInputErrorElement.textContent = "";
    evaluationStatusElement.textContent = "";
    evaluationResultStatus.textContent = "";
    readingStatusElement.textContent = "";
    readingResultStatus.textContent = "";
    detailStatusElement.textContent = "";
    detailErrorElement.textContent = "";
    readingRetryButton.hidden = true;
    readingRetryButton.disabled = true;
    readingModeButton.disabled = false;
    trainingInputElement.setAttribute("aria-busy", "false");
    readingInputElement.setAttribute("aria-busy", "false");
    readingResultElement.setAttribute("aria-busy", "false");
    trainingInputElement.hidden = false;
    readingInputElement.hidden = true;
    trainingModeButton.className = "mode-button is-selected";
    trainingModeButton.setAttribute("aria-pressed", "true");
    readingModeButton.className = "mode-button";
    readingModeButton.setAttribute("aria-pressed", "false");
    evaluationButton.disabled = true;
    evaluationButton.textContent = "評価する";
    trainingMethodsElement.hidden = false;
    sessionSection.hidden = true;
    evaluationResultElement.hidden = true;
    readingResultElement.hidden = true;
    readingGuideContentElement.hidden = true;
    totalScoreElement.textContent = "";
    criteriaListElement.replaceChildren();
    strengthsListElement.replaceChildren();
    gapsListElement.replaceChildren();
    userAnswerElement.textContent = "";
    modelAnswerElement.textContent = "";
    focusPointsListElement.replaceChildren();
    checksListElement.replaceChildren();
    readingQuestionsListElement.replaceChildren();
    hintsListElement.replaceChildren();
    nextCandidatesListElement.replaceChildren();
    readingResultErrorElement.textContent = "";
    readingRetryButton.hidden = true;
    detailedExplanationBlockElement.hidden = true;
    detailedExplanationElement.textContent = "";
    detailButton.disabled = false;
    detailButton.textContent = "詳しい説明を見る";
    completeReadingButton.disabled = false;
    readingChangeCandidateButton.disabled = false;
    newTrainingButton.disabled = false;
  }

  function setMode(mode: "training" | "reading_support"): void {
    if (isEvaluationLocked()) return;
    selectedMode = mode;
    const training = mode === "training";
    readingScreenVisible = !training;
    trainingInputElement.hidden = !training;
    readingInputElement.hidden = true;
    evaluationResultElement.hidden = true;
    readingResultElement.hidden = true;
    trainingModeButton.className = training
      ? "mode-button is-selected"
      : "mode-button";
    readingModeButton.className = training
      ? "mode-button"
      : "mode-button is-selected";
    trainingModeButton.setAttribute("aria-pressed", String(training));
    readingModeButton.setAttribute("aria-pressed", String(!training));
    if (!training && !readingStartedRecorded) {
      readingStartedRecorded = true;
      recordReadingEvent("reading_support_started");
    }
    if (training) {
      readingStatusElement.textContent = "";
      trainingMethodsElement.hidden = true;
      candidateSection.hidden = true;
      sessionSection.hidden = false;
      explanationElement.focus();
    } else if (readingGuide) {
      renderReadingGuide(readingGuide);
    } else if (readingSubmitting) {
      showReadingGuideLoading();
    } else if (readingStatusMessage) {
      showReadingGuideError(readingStatusMessage);
    }
    updateInputValidation();
    updateReadingInputValidation();
    if (
      !training &&
      readingGuide === null &&
      !readingSubmitting &&
      readingStatusMessage === null
    ) {
      void requestReadingSupport("guide");
    }
  }

  function updateReadingInputValidation(): ReadingSupportInputValidation {
    const validation = inputValidation.validateReadingSupportInput(
      selectedCodeElement.textContent,
    );
    readingInputErrorElement.textContent =
      validation.codeError ?? readingApiInputError ?? "";
    const retryWaiting =
      retryAfterUntil !== null && retryAfterUntil > Date.now();
    readingRetryButton.disabled =
      !validation.valid ||
      readingSubmitting ||
      retryWaiting ||
      !readingRetryable;
    return validation;
  }

  function appendReadingItems(
    list: HTMLUListElement | HTMLOListElement,
    items: readonly string[],
  ): void {
    list.replaceChildren();
    for (const item of items) {
      const listItem = document.createElement("li");
      listItem.textContent = item;
      list.append(listItem);
    }
  }

  function showReadingGuideScreen(): void {
    readingScreenVisible = true;
    trainingMethodsElement.hidden = true;
    candidateSection.hidden = true;
    sessionSection.hidden = true;
    evaluationResultElement.hidden = true;
    readingResultElement.hidden = false;
  }

  function showReadingGuideLoading(): void {
    showReadingGuideScreen();
    readingGuideContentElement.hidden = true;
    readingResultErrorElement.textContent = "";
    readingResultStatus.textContent = "読むためのガイドを作成しています…";
    readingRetryButton.hidden = true;
    readingChangeCandidateButton.disabled = false;
    readingResultElement.setAttribute("aria-busy", "true");
    readingResultTitle.focus();
    readingResultTitle.scrollIntoView({ block: "start" });
  }

  function showReadingGuideError(message: string): void {
    showReadingGuideScreen();
    readingGuideContentElement.hidden = true;
    readingResultStatus.textContent = "ガイドを作成できませんでした。";
    readingResultErrorElement.textContent = message;
    readingRetryButton.hidden = !readingRetryable;
    readingChangeCandidateButton.disabled = false;
  }

  function renderReadingGuide(response: ReadingSupportResponse): void {
    appendReadingItems(focusPointsListElement, response.focusPoints);
    appendReadingItems(checksListElement, response.checks);
    appendReadingItems(readingQuestionsListElement, response.questions);
    appendReadingItems(hintsListElement, response.hints);
    nextCandidatesListElement.replaceChildren();
    nextCandidatesBlockElement.hidden = response.nextCandidates.length === 0;
    for (const candidate of response.nextCandidates) {
      const item = document.createElement("li");
      item.textContent = `${candidate.symbol}: ${candidate.reason}`;
      nextCandidatesListElement.append(item);
    }
    readingResultErrorElement.textContent = "";
    detailErrorElement.textContent = "";
    readingStatusElement.textContent = "";
    readingResultStatus.textContent = "ガイドを作成しました。";
    readingRetryButton.hidden = true;
    readingGuideContentElement.hidden = false;
    detailedExplanationElement.textContent = readingDetailedExplanation ?? "";
    detailedExplanationBlockElement.hidden =
      readingDetailedExplanation === null;
    detailButton.disabled = readingDetailedExplanation !== null;
    detailButton.textContent = readingDetailedExplanation
      ? "詳しい説明を表示済み"
      : "詳しい説明を見る";
    readingChangeCandidateButton.disabled = false;
    readingResultElement.setAttribute("aria-busy", "false");
    showReadingGuideScreen();
    if (!readingGuideDisplayedRecorded) {
      readingGuideDisplayedRecorded = true;
      recordReadingEvent("reading_support_guide_displayed", "guide");
    }
    if (readingDetailedExplanation && !readingDetailDisplayedRecorded) {
      readingDetailDisplayedRecorded = true;
      recordReadingEvent(
        "reading_support_detail_displayed",
        "detailed_explanation",
      );
    }
    readingResultTitle.focus();
    readingResultTitle.scrollIntoView({ block: "start" });
  }

  async function requestReadingSupport(
    stage: ReadingSupportStage,
  ): Promise<void> {
    if (
      readingSubmitting ||
      !selectedSourceUrl ||
      !readingRetryable ||
      (retryAfterUntil !== null && retryAfterUntil > Date.now()) ||
      !updateReadingInputValidation().valid
    ) {
      return;
    }
    const request: ReadingSupportRequest = {
      code: selectedCodeElement.textContent ?? "",
      language: "python",
      sourceUrl: selectedSourceUrl,
      stage,
    };
    const attempt = ++readingAttempt;
    readingSubmitting = true;
    readingApiInputError = null;
    readingRetryable = true;
    if (stage === "guide") {
      readingStatusMessage = null;
      readingResultErrorElement.textContent = "";
    } else {
      detailErrorElement.textContent = "";
    }
    if (stage === "guide") {
      showReadingGuideLoading();
      readingModeButton.disabled = true;
    } else {
      detailButton.disabled = true;
      detailButton.textContent = "詳しい説明を作成中…";
      detailStatusElement.textContent =
        "対象コードの詳しい説明を作成しています…";
      readingResultElement.setAttribute("aria-busy", "true");
    }
    updateReadingInputValidation();

    try {
      const permissionOrigin =
        CodeReadingTrainerEvaluationConfig.getEvaluationApiPermissionOrigin();
      if (permissionOrigin) {
        const granted = await chrome.permissions.request({
          origins: [permissionOrigin],
        });
        if (attempt !== readingAttempt) return;
        if (!granted) throw new Error("permission denied");
      }
      const result = (await chrome.runtime.sendMessage({
        request,
        type: "REQUEST_READING_SUPPORT",
      })) as EvaluationWorkerResult | undefined;
      if (!result) throw new Error("missing response");
      if (
        "error" in result &&
        result.error.code === "RATE_LIMITED" &&
        typeof result.error.retryAfterSeconds === "number"
      ) {
        scheduleRetryAfterCooldown(
          Date.now() + result.error.retryAfterSeconds * 1_000,
        );
      }
      if (attempt !== readingAttempt) return;
      if ("error" in result) {
        if (stage !== "guide") {
          detailErrorElement.textContent = result.error.message;
        }
        readingStatusMessage = `${result.error.message} 対象コードは保持されています。`;
        if (stage === "guide") {
          const detailsMessage =
            result.error.details
              ?.map((detail) => `${detail.field}: ${detail.reason}`)
              .join("\n") ?? "";
          readingApiInputError = detailsMessage || result.error.message;
          readingRetryable = result.error.retryable;
          if (readingScreenVisible) {
            showReadingGuideError(result.error.message);
          }
        } else if (!result.error.retryable) {
          readingRetryable = false;
          detailButton.disabled = true;
          detailButton.textContent = "詳しい説明を取得できません";
        } else if (result.error.code === "RATE_LIMITED") {
          detailButton.textContent = "再試行できるまで待機中…";
        }
        if (stage === "detailed_explanation") {
          detailStatusElement.textContent = "";
        }
        return;
      }
      const response = readingSupportContract.parseResponse(result.response);
      if (!response || response.stage !== stage) {
        throw new Error("invalid response");
      }
      if (stage === "guide") {
        readingApiInputError = null;
        readingStatusMessage = null;
        readingGuide = response;
        if (readingScreenVisible) renderReadingGuide(response);
      } else {
        readingDetailedExplanation = response.detailedExplanation;
        if (readingScreenVisible) {
          detailedExplanationElement.textContent = readingDetailedExplanation;
          detailedExplanationBlockElement.hidden = false;
          detailButton.disabled = true;
          detailButton.textContent = "詳しい説明を表示済み";
          if (!readingDetailDisplayedRecorded) {
            readingDetailDisplayedRecorded = true;
            recordReadingEvent(
              "reading_support_detail_displayed",
              "detailed_explanation",
            );
          }
          detailStatusElement.textContent = "詳しい説明を表示しました。";
          detailedExplanationBlockElement.scrollIntoView({ block: "start" });
        }
      }
    } catch {
      const message =
        stage === "guide"
          ? "読解サポートを開始できませんでした。対象コードは保持されています。もう一度お試しください。"
          : "詳しい説明を取得できませんでした。もう一度お試しください。";
      if (stage !== "guide") {
        detailErrorElement.textContent = message;
      }
      if (stage === "guide") readingApiInputError = message;
      readingStatusMessage = message;
      if (stage === "guide") {
        if (readingScreenVisible) showReadingGuideError(message);
      } else {
        detailStatusElement.textContent = "";
      }
    } finally {
      if (attempt === readingAttempt) {
        readingSubmitting = false;
        readingModeButton.disabled = false;
        readingInputElement.setAttribute("aria-busy", "false");
        readingResultElement.setAttribute("aria-busy", "false");
        readingChangeCandidateButton.disabled = false;
        if (
          stage === "detailed_explanation" &&
          !detailedExplanationElement.textContent &&
          readingRetryable &&
          !(retryAfterUntil !== null && retryAfterUntil > Date.now())
        ) {
          detailButton.disabled = false;
          detailButton.textContent = "詳しい説明をもう一度取得する";
        }
        updateReadingInputValidation();
      }
    }
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

  function renderEvaluationResult(
    response: EvaluationResponse,
    answer: string,
  ): void {
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
    userAnswerElement.textContent = answer;
    modelAnswerElement.textContent = response.modelAnswer;
    trainingMethodsElement.hidden = true;
    sessionSection.hidden = true;
    evaluationResultElement.hidden = false;
    evaluationResultTitle.focus();
    evaluationResultTitle.scrollIntoView({ block: "start" });
  }

  function updateInputValidation(): TrainingInputValidation {
    const validation = inputValidation.validateTrainingInput(
      selectedCodeElement.textContent,
      explanationElement.value,
    );

    explanationCountElement.textContent = `${validation.explanationCharacterCount.toLocaleString("ja-JP")} / ${inputValidation.INPUT_LIMITS.explanation.toLocaleString("ja-JP")}文字`;
    const apiInputError =
      evaluationState.status === "error"
        ? (evaluationState.inputError ?? evaluationState.message)
        : null;
    const visibleExplanationError = explanationTouched
      ? validation.explanationError
      : null;
    const explanationInvalid =
      visibleExplanationError !== null ||
      (evaluationState.status === "error" &&
        evaluationState.explanationInvalid);
    explanationElement.setAttribute(
      "aria-invalid",
      explanationInvalid ? "true" : "false",
    );
    inputErrorElement.textContent =
      validation.codeError ?? visibleExplanationError ?? apiInputError ?? "";
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
      evaluationButton.textContent = "評価する";
      evaluationStatusElement.textContent = "";
      trainingInputElement.setAttribute("aria-busy", "false");
    } else if (nextState.status === "submitting") {
      explanationElement.readOnly = true;
      evaluationButton.textContent = "評価中…";
      evaluationStatusElement.textContent =
        "回答を評価しています。このまましばらくお待ちください。";
      trainingInputElement.setAttribute("aria-busy", "true");
    } else if (nextState.status === "completed") {
      explanationElement.readOnly = true;
      evaluationButton.textContent = "評価済み";
      newTrainingButton.disabled = false;
      evaluationStatusElement.textContent = "";
      evaluationResultStatus.textContent = `採点が完了しました（${nextState.response.totalScore} / 100点）。`;
      trainingInputElement.setAttribute("aria-busy", "false");
      renderEvaluationResult(nextState.response, nextState.answer);
    } else {
      if (
        nextState.retryAfterUntil !== null &&
        nextState.retryAfterUntil > Date.now()
      ) {
        scheduleRetryAfterCooldown(nextState.retryAfterUntil);
      }
      explanationElement.readOnly = false;
      evaluationButton.textContent = nextState.retryable
        ? "もう一度評価する"
        : "評価できません";
      evaluationStatusElement.textContent = "";
      trainingInputElement.setAttribute("aria-busy", "false");
    }

    updateInputValidation();
  }

  function applyPageContext(
    context: PageContext,
    sessionAlreadyReset = false,
  ): void {
    const isEligible = context.status === PAGE_STATUS.ELIGIBLE;
    const nextPageKey = isEligible
      ? JSON.stringify([
          context.repository,
          context.commitOid ?? null,
          context.ref,
          context.path,
        ])
      : null;
    if (isEligible) {
      if (
        !sessionAlreadyReset &&
        activePageKey &&
        activePageKey !== nextPageKey
      ) {
        resetSession();
      }
      activePageKey = nextPageKey;
      activeCandidateContextKey = context.commitOid
        ? JSON.stringify([context.repository, context.commitOid, context.path])
        : null;
      candidateRetryButton.disabled = !context.commitOid;
      statusElement.textContent = `${context.repository} の ${context.path}（${context.ref}）を表示しています。`;
      return;
    }

    if (!sessionAlreadyReset) {
      resetSession();
    }
    activePageKey = null;
    activeCandidateContextKey = null;
    candidateRetryButton.disabled = true;
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

  async function updateStatus(sessionAlreadyReset = false): Promise<void> {
    const attempt = ++pageContextAttempt;
    try {
      const context = await getPageContext();
      if (attempt !== pageContextAttempt) return;
      applyPageContext(context, sessionAlreadyReset);
      if (
        context.status === PAGE_STATUS.ELIGIBLE &&
        context.commitOid &&
        !selectedCodeElement.textContent
      ) {
        await loadCandidates(context);
      }
    } catch (error) {
      if (attempt !== pageContextAttempt) return;
      if (!sessionAlreadyReset) {
        resetSession();
      }
      activePageKey = null;
      activeCandidateContextKey = null;
      candidateRetryButton.disabled = true;
      statusElement.textContent = getErrorMessage(error);
    }
  }

  newTrainingButton.addEventListener("click", async () => {
    if (evaluationState.status !== "completed" || newTrainingStarting) return;

    newTrainingStarting = true;
    resetSession();
    newTrainingButton.disabled = true;
    statusElement.textContent = "現在のGitHubページを確認しています…";

    try {
      await updateStatus(true);
    } finally {
      newTrainingStarting = false;
      newTrainingButton.disabled = false;
    }
  });

  trainingModeButton.addEventListener("click", () => setMode("training"));
  readingModeButton.addEventListener("click", () => setMode("reading_support"));

  function startTrainingWithCode(
    candidateId: string,
    code: string,
    sourceUrl: string,
  ): void {
    if (selectedCandidateId === candidateId) {
      setMode("training");
      trainingMethodsElement.hidden = true;
      candidateSection.hidden = true;
      sessionSection.hidden = false;
      readingResultElement.hidden = true;
      return;
    }
    if (
      selectedCodeElement.textContent &&
      explanationElement.value.trim() &&
      !globalThis.confirm(
        "別の候補へ移ると、現在の回答下書きは破棄されます。続けますか？",
      )
    ) {
      return;
    }
    resetSession();
    selectedCandidateId = candidateId;
    selectedCodeElement.textContent = code;
    selectedSourceUrl = sourceUrl;
    sessionSection.hidden = false;
    trainingMethodsElement.hidden = true;
    candidateSection.hidden = true;
    updateInputValidation();
    updateReadingInputValidation();
  }

  function renderCandidates(candidates: TrainingCandidate[]): void {
    candidateList.replaceChildren();
    const levelLabels: Record<TrainingCandidateLevel, string> = {
      warmup: "ウォームアップ",
      recommended: "おすすめ",
      challenge: "チャレンジ",
    };
    for (const candidate of candidates) {
      const article = document.createElement("article");
      article.className = "candidate-card";
      const title = document.createElement("h3");
      title.textContent = `${levelLabels[candidate.level]}: ${candidate.name}`;
      const metadata = document.createElement("p");
      metadata.className = "candidate-metadata";
      metadata.textContent = `${candidate.difficulty} · 約${candidate.estimatedMinutes}分 · ${candidate.kind === "method" ? "メソッド" : "関数"} · ${candidate.startLine}〜${candidate.endLine}行`;
      const reason = document.createElement("p");
      reason.textContent = candidate.reason;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "この候補を読む";
      button.addEventListener("click", () =>
        startTrainingWithCode(
          candidate.id,
          candidate.code,
          candidate.sourceUrl,
        ),
      );
      article.append(title, metadata, reason, button);
      candidateList.append(article);
    }
  }

  async function loadCandidates(context?: PageContext): Promise<void> {
    if (isEvaluationLocked()) return;
    let requestAttempt: number | null = null;
    let loadingContextKey: string | null = null;
    const pageContextGeneration = pageContextAttempt;
    const shouldVerifyPageContext = context === undefined;
    try {
      context ??= await getPageContext();
      if (
        shouldVerifyPageContext &&
        pageContextGeneration !== pageContextAttempt
      )
        return;
      if (context.status !== PAGE_STATUS.ELIGIBLE || !context.commitOid) {
        candidateStatus.textContent =
          "表示中のcommitを確認できません。ページを再読み込みするか、別のpublic Pythonファイルを開いてください。";
        candidateRetryButton.hidden = false;
        return;
      }
      applyPageContext(context);
      const contextKey = activeCandidateContextKey;
      if (!contextKey) return;
      if (
        candidateLoadingRequest?.contextKey === contextKey &&
        candidateLoadingRequest.requestAttempt === candidateRequestAttempt
      )
        return;
      const cachedCandidates = candidateCache.get(contextKey);
      if (cachedCandidates) {
        candidateCache.delete(contextKey);
        candidateCache.set(contextKey, cachedCandidates);
        candidateStatus.textContent = `${cachedCandidates.length}件の候補が見つかりました。`;
        renderCandidates(cachedCandidates);
        return;
      }
      requestAttempt = ++candidateRequestAttempt;
      loadingContextKey = contextKey;
      candidateLoadingRequest = { contextKey, requestAttempt };
      candidateRetryButton.disabled = true;
      candidateRetryButton.hidden = true;
      candidateSection.hidden = false;
      candidateList.replaceChildren();
      candidateStatus.textContent = "現在のファイルから候補を探しています…";
      const requestId = `${Date.now()}-${requestAttempt}`;
      const response = (await chrome.runtime.sendMessage({
        context,
        requestId,
        tabId: context.tabId,
        type: "REQUEST_TRAINING_CANDIDATES",
      })) as TrainingCandidatesWorkerResult;
      if (
        requestAttempt !== candidateRequestAttempt ||
        response.requestId !== requestId ||
        response.contextKey !== activeCandidateContextKey
      )
        return;
      if (response.ok === false) {
        candidateStatus.textContent = response.error.message;
        candidateRetryButton.hidden = !response.error.retryable;
        return;
      }
      if (response.candidates.length === 0) {
        candidateStatus.textContent =
          "このファイルには学習向きの候補が見つかりませんでした。別のpublic Pythonファイルを開いて、もう一度お試しください。";
        candidateRetryButton.hidden = false;
        return;
      }
      candidateCache.set(contextKey, response.candidates);
      if (candidateCache.size > CANDIDATE_CACHE_LIMIT) {
        const oldestKey = candidateCache.keys().next().value;
        if (oldestKey) candidateCache.delete(oldestKey);
      }
      candidateStatus.textContent = `${response.candidates.length}件の候補が見つかりました。`;
      renderCandidates(response.candidates);
    } catch {
      if (requestAttempt === null) {
        if (pageContextGeneration !== pageContextAttempt) return;
      } else if (requestAttempt !== candidateRequestAttempt) return;
      candidateStatus.textContent = "候補を取得できませんでした。";
      candidateRetryButton.hidden = false;
    } finally {
      if (
        loadingContextKey !== null &&
        candidateLoadingRequest?.contextKey === loadingContextKey &&
        candidateLoadingRequest.requestAttempt === requestAttempt
      ) {
        candidateLoadingRequest = null;
      }
      candidateRetryButton.disabled = activePageKey === null;
    }
  }

  candidateRetryButton.addEventListener("click", () => {
    if (activeCandidateContextKey)
      candidateCache.delete(activeCandidateContextKey);
    void loadCandidates();
  });

  function showCandidatePicker(): void {
    readingScreenVisible = false;
    trainingMethodsElement.hidden = false;
    candidateSection.hidden = false;
    sessionSection.hidden = true;
    readingResultElement.hidden = true;
    evaluationResultElement.hidden = true;
    candidateStatus.textContent = "候補一覧を読み込んでいます…";
    candidateRetryButton.hidden = true;
    void loadCandidates();
    candidateSection.scrollIntoView({ block: "start" });
  }

  changeCandidateButton.addEventListener("click", showCandidatePicker);
  readingChangeCandidateButton.addEventListener("click", showCandidatePicker);

  readingRetryButton.addEventListener("click", () => {
    if (selectedMode === "reading_support") void requestReadingSupport("guide");
  });

  detailButton.addEventListener("click", () => {
    if (readingGuide) void requestReadingSupport("detailed_explanation");
  });

  completeReadingButton.addEventListener("click", () => {
    if (!readingGuide || readingSubmitting) return;
    recordReadingEvent("reading_support_completed");
    setMode("training");
    sessionSection.hidden = false;
    readingResultElement.hidden = true;
    trainingMethodsElement.hidden = true;
    candidateSection.hidden = true;
    explanationElement.focus();
    explanationElement.scrollIntoView({ block: "center" });
  });

  explanationElement.addEventListener("input", () => {
    explanationTouched = true;
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

  explanationElement.addEventListener("blur", () => {
    explanationTouched = true;
    updateInputValidation();
  });

  sessionSection.addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();
    explanationTouched = true;

    if (
      selectedMode !== "training" ||
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
          answer: request.explanation,
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
        inputError: result.error.details?.length
          ? `${result.error.message}\n${result.error.details
              .map((detail) => `${detail.field}: ${detail.reason}`)
              .join("\n")}`
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

  chrome.tabs.onActivated.addListener(() => updateStatus());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) {
      updateStatus();
    }
  });

  updateStatus();
})();

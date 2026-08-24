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
  const recommendationButton = requireElement<HTMLButtonElement>(
    "#recommendation-button",
  );
  const candidateSection = requireElement<HTMLElement>("#candidate-section");
  const candidateStatus = requireElement<HTMLElement>("#candidate-status");
  const candidateList = requireElement<HTMLElement>("#candidate-list");
  const sessionSection = requireElement<HTMLFormElement>("#training-session");
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
  const evaluationResultElement =
    requireElement<HTMLElement>("#evaluation-result");
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
  const readingQuestionElement =
    requireElement<HTMLTextAreaElement>("#reading-question");
  const readingQuestionCountElement = requireElement<HTMLElement>(
    "#reading-question-count",
  );
  const readingInputErrorElement = requireElement<HTMLElement>(
    "#reading-input-error",
  );
  const readingSubmitButton = requireElement<HTMLButtonElement>(
    "#reading-submit-button",
  );
  const readingResultElement = requireElement<HTMLElement>("#reading-result");
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
  const detailedExplanationBlockElement = requireElement<HTMLElement>(
    "#detailed-explanation-block",
  );
  const detailedExplanationElement = requireElement<HTMLElement>(
    "#detailed-explanation",
  );
  const completeReadingButton = requireElement<HTMLButtonElement>(
    "#complete-reading-button",
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
  let candidateRequestAttempt = 0;
  let selectedSourceUrl: string | null = null;
  let evaluationState: EvaluationUiState = { status: "editing" };
  let evaluationAttempt = 0;
  let pageContextAttempt = 0;
  let retryAfterUntil: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let newTrainingStarting = false;
  let selectedMode: "training" | "reading_support" = "training";
  let readingAttempt = 0;
  let readingSubmitting = false;
  let readingGuide: ReadingSupportResponse | null = null;
  let readingStartedRecorded = false;
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
    readingStartedRecorded = false;
    readingApiInputError = null;
    readingRetryable = true;
    readingStatusMessage = null;
    selectedMode = "training";
    selectedSourceUrl = null;
    candidateRequestAttempt += 1;
    activeCandidateContextKey = null;
    candidateSection.hidden = true;
    candidateStatus.textContent = "";
    candidateList.replaceChildren();
    recommendationButton.disabled = activePageKey === null;
    selectedCodeElement.textContent = "";
    explanationElement.value = "";
    explanationElement.readOnly = false;
    explanationElement.setAttribute("aria-invalid", "false");
    explanationCountElement.textContent = `0 / ${inputValidation.INPUT_LIMITS.explanation.toLocaleString("ja-JP")}文字`;
    inputErrorElement.textContent = "";
    readingQuestionElement.value = "";
    readingQuestionElement.readOnly = false;
    readingQuestionElement.setAttribute("aria-invalid", "false");
    readingQuestionCountElement.textContent = `0 / ${inputValidation.INPUT_LIMITS.question.toLocaleString("ja-JP")}文字`;
    readingInputErrorElement.textContent = "";
    readingSubmitButton.disabled = true;
    readingSubmitButton.textContent = "読むためのガイドを受け取る";
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
    detailedExplanationBlockElement.hidden = true;
    detailedExplanationElement.textContent = "";
    detailButton.disabled = false;
    detailButton.textContent = "詳しい説明を見る";
    completeReadingButton.disabled = false;
    newTrainingButton.disabled = false;
  }

  function setMode(mode: "training" | "reading_support"): void {
    if (readingSubmitting || isEvaluationLocked()) return;
    selectedMode = mode;
    const training = mode === "training";
    trainingInputElement.hidden = !training;
    readingInputElement.hidden = training;
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
    statusElement.textContent = training
      ? evaluationState.status === "error"
        ? evaluationState.message
        : "対象コードを読み、自分の言葉で説明してみましょう。"
      : (readingStatusMessage ??
        "分からない点や調査目的を書き、まず読むためのガイドを受け取りましょう。");
    updateInputValidation();
    updateReadingInputValidation();
  }

  function updateReadingInputValidation(): ReadingSupportInputValidation {
    const validation = inputValidation.validateReadingSupportInput(
      selectedCodeElement.textContent,
      readingQuestionElement.value,
    );
    readingQuestionCountElement.textContent = `${validation.questionCharacterCount.toLocaleString("ja-JP")} / ${inputValidation.INPUT_LIMITS.question.toLocaleString("ja-JP")}文字`;
    readingQuestionElement.setAttribute(
      "aria-invalid",
      validation.questionError ? "true" : "false",
    );
    readingInputErrorElement.textContent =
      validation.codeError ??
      validation.questionError ??
      readingApiInputError ??
      "";
    const retryWaiting =
      retryAfterUntil !== null && retryAfterUntil > Date.now();
    readingSubmitButton.disabled =
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
    detailedExplanationBlockElement.hidden = true;
    detailedExplanationElement.textContent = "";
    detailButton.disabled = false;
    detailButton.textContent = "詳しい説明を見る";
    trainingMethodsElement.hidden = true;
    sessionSection.hidden = true;
    evaluationResultElement.hidden = true;
    readingResultElement.hidden = false;
  }

  async function requestReadingSupport(
    stage: ReadingSupportStage,
  ): Promise<void> {
    if (
      readingSubmitting ||
      !selectedSourceUrl ||
      (retryAfterUntil !== null && retryAfterUntil > Date.now()) ||
      !updateReadingInputValidation().valid
    ) {
      return;
    }
    const request: ReadingSupportRequest = {
      code: selectedCodeElement.textContent ?? "",
      language: "python",
      question: readingQuestionElement.value,
      sourceUrl: selectedSourceUrl,
      stage,
    };
    const attempt = ++readingAttempt;
    readingSubmitting = true;
    readingQuestionElement.readOnly = true;
    readingApiInputError = null;
    readingRetryable = true;
    readingResultErrorElement.textContent = "";
    if (stage === "guide") {
      readingSubmitButton.textContent = "ガイドを作成中…";
      statusElement.textContent = "読むためのガイドを作成しています…";
    } else {
      detailButton.disabled = true;
      detailButton.textContent = "詳しい説明を作成中…";
      statusElement.textContent = "対象コードの詳しい説明を作成しています…";
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
        readingResultErrorElement.textContent = result.error.message;
        readingStatusMessage = `${result.error.message} 入力は保持されています。`;
        statusElement.textContent = readingStatusMessage;
        if (stage === "guide") {
          readingApiInputError =
            result.error.details
              ?.map((detail) => `${detail.field}: ${detail.reason}`)
              .join("\n") ?? "";
          readingRetryable = result.error.retryable;
        } else if (!result.error.retryable) {
          readingRetryable = false;
          detailButton.disabled = true;
          detailButton.textContent = "詳しい説明を取得できません";
        } else if (result.error.code === "RATE_LIMITED") {
          detailButton.textContent = "再試行できるまで待機中…";
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
        renderReadingGuide(response);
        recordReadingEvent("reading_support_guide_displayed", "guide");
        statusElement.textContent =
          "まず着眼点とヒントを使って、自分でコードを読み進めてみましょう。";
      } else {
        detailedExplanationElement.textContent = response.detailedExplanation;
        detailedExplanationBlockElement.hidden = false;
        detailButton.disabled = true;
        detailButton.textContent = "詳しい説明を表示済み";
        recordReadingEvent(
          "reading_support_detail_displayed",
          "detailed_explanation",
        );
        statusElement.textContent = "詳しい説明を表示しました。";
      }
    } catch {
      const message =
        stage === "guide"
          ? "読解サポートを開始できませんでした。入力は保持されています。もう一度お試しください。"
          : "詳しい説明を取得できませんでした。もう一度お試しください。";
      readingResultErrorElement.textContent = message;
      readingStatusMessage = message;
      statusElement.textContent = message;
    } finally {
      if (attempt === readingAttempt) {
        readingSubmitting = false;
        readingQuestionElement.readOnly = false;
        readingSubmitButton.textContent = "読むためのガイドを受け取る";
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
      evaluationButton.textContent = "評価する";
    } else if (nextState.status === "submitting") {
      explanationElement.readOnly = true;
      evaluationButton.textContent = "評価中…";
      statusElement.textContent =
        "回答を評価しています。このまましばらくお待ちください。";
    } else if (nextState.status === "completed") {
      explanationElement.readOnly = true;
      evaluationButton.textContent = "評価済み";
      newTrainingButton.disabled = false;
      statusElement.textContent = `採点が完了しました（${nextState.response.totalScore} / 100点）。`;
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
      statusElement.textContent = nextState.message;
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
    recommendationButton.disabled = !isEligible || !context.commitOid;

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
      if (
        evaluationState.status === "editing" &&
        !readingSubmitting &&
        readingGuide === null
      ) {
        statusElement.textContent =
          selectedMode === "reading_support" && readingStatusMessage
            ? readingStatusMessage
            : `${context.repository} の ${context.path}（${context.ref}）でトレーニングできます。`;
      }
      return;
    }

    if (!sessionAlreadyReset) {
      resetSession();
    }
    activePageKey = null;
    activeCandidateContextKey = null;
    recommendationButton.disabled = true;
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
    candidateRequestAttempt += 1;
    activeCandidateContextKey = null;
    candidateSection.hidden = true;
    candidateStatus.textContent = "";
    candidateList.replaceChildren();
    try {
      const context = await getPageContext();
      if (attempt !== pageContextAttempt) return;
      applyPageContext(context, sessionAlreadyReset);
    } catch (error) {
      if (attempt !== pageContextAttempt) return;
      if (!sessionAlreadyReset) {
        resetSession();
      }
      activePageKey = null;
      activeCandidateContextKey = null;
      recommendationButton.disabled = true;
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

  readingQuestionElement.addEventListener("input", () => {
    readingApiInputError = null;
    readingRetryable = true;
    readingStatusMessage = null;
    readingInputErrorElement.textContent = "";
    readingResultErrorElement.textContent = "";
    updateReadingInputValidation();
  });

  readingSubmitButton.addEventListener("click", () => {
    if (selectedMode === "reading_support") {
      void requestReadingSupport("guide");
    }
  });

  function startTrainingWithCode(code: string, sourceUrl: string): void {
    resetSession();
    selectedCodeElement.textContent = code;
    selectedSourceUrl = sourceUrl;
    sessionSection.hidden = false;
    statusElement.textContent =
      "選んだ候補を読み、自分の言葉で説明してみましょう。";
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
      button.textContent = "この候補でトレーニングする";
      button.addEventListener("click", () =>
        startTrainingWithCode(candidate.code, candidate.sourceUrl),
      );
      article.append(title, metadata, reason, button);
      candidateList.append(article);
    }
  }

  recommendationButton.addEventListener("click", async () => {
    if (isEvaluationLocked() || readingSubmitting) return;
    const requestAttempt = ++candidateRequestAttempt;
    recommendationButton.disabled = true;
    candidateSection.hidden = false;
    candidateList.replaceChildren();
    candidateStatus.textContent = "現在のファイルから候補を探しています…";
    try {
      const context = await getPageContext();
      if (requestAttempt !== candidateRequestAttempt) return;
      if (context.status !== PAGE_STATUS.ELIGIBLE || !context.commitOid) {
        candidateStatus.textContent =
          "表示中のcommitを確認できません。ページを再読み込みするか、別のpublic Pythonファイルを開いてください。";
        return;
      }
      applyPageContext(context);
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
        candidateStatus.textContent = `${response.error.message} もう一度試すか、別のpublic Pythonファイルを開いてください。`;
        return;
      }
      if (response.candidates.length === 0) {
        candidateStatus.textContent =
          "このファイルには学習向きの候補が見つかりませんでした。別のpublic Pythonファイルを開いて、もう一度お試しください。";
        return;
      }
      candidateStatus.textContent = `${response.candidates.length}件の候補が見つかりました。`;
      renderCandidates(response.candidates);
    } catch {
      if (requestAttempt !== candidateRequestAttempt) return;
      candidateStatus.textContent =
        "候補を取得できませんでした。もう一度試すか、別のpublic Pythonファイルを開いてください。";
    } finally {
      if (requestAttempt === candidateRequestAttempt) {
        recommendationButton.disabled = activePageKey === null;
      }
    }
  });

  detailButton.addEventListener("click", () => {
    if (readingGuide) void requestReadingSupport("detailed_explanation");
  });

  completeReadingButton.addEventListener("click", async () => {
    if (!readingGuide || readingSubmitting) return;
    recordReadingEvent("reading_support_completed");
    resetSession();
    statusElement.textContent = "現在のGitHubページを確認しています…";
    await updateStatus(true);
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

  sessionSection.addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();

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

  chrome.tabs.onActivated.addListener(() => updateStatus());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) {
      updateStatus();
    }
  });

  updateStatus();
})();

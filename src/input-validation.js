(() => {
  const INPUT_LIMITS = Object.freeze({
    code: 30_000,
    explanation: 5_000,
  });

  function countCharacters(value) {
    return Array.from(value).length;
  }

  function validateTrainingInput(code, explanation) {
    const codeCharacterCount = countCharacters(code);
    const explanationCharacterCount = countCharacters(explanation);
    let codeError = null;
    let explanationError = null;

    if (!code.trim()) {
      codeError = "GitHub上で説明したいPythonコードを選択してください。";
    } else if (codeCharacterCount > INPUT_LIMITS.code) {
      codeError = `選択コードは${INPUT_LIMITS.code.toLocaleString("ja-JP")}文字以内にしてください（現在${codeCharacterCount.toLocaleString("ja-JP")}文字）。選択範囲を短くして、もう一度取り込んでください。`;
    }

    if (!explanation.trim()) {
      explanationError =
        "回答を入力してください。目的や主要な処理を1文字以上で説明してください。";
    } else if (explanationCharacterCount > INPUT_LIMITS.explanation) {
      explanationError = `回答は${INPUT_LIMITS.explanation.toLocaleString("ja-JP")}文字以内にしてください（現在${explanationCharacterCount.toLocaleString("ja-JP")}文字）。内容を短くしてから評価してください。`;
    }

    return {
      valid: codeError === null && explanationError === null,
      codeCharacterCount,
      explanationCharacterCount,
      codeError,
      explanationError,
    };
  }

  globalThis.CodeReadingTrainerInputValidation = Object.freeze({
    INPUT_LIMITS,
    countCharacters,
    validateTrainingInput,
  });
})();

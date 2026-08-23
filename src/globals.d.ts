type PageStatus = "eligible" | "unsupported";

type UnsupportedReason =
  | "invalid-url"
  | "not-github"
  | "not-code-view"
  | "not-python"
  | "private-repository"
  | "visibility-unknown"
  | "page-data-unavailable";

interface PageDetails {
  path: string | null;
  ref: string | null;
  repository: string | null;
}

interface EligiblePageContext extends PageDetails {
  path: string;
  reason: null;
  ref: string;
  repository: string;
  status: "eligible";
  url: string;
}

interface UnsupportedPageContext extends PageDetails {
  reason: UnsupportedReason;
  status: "unsupported";
  url: string;
}

type AnalyzedPageContext = EligiblePageContext | UnsupportedPageContext;

type PageContext = AnalyzedPageContext & {
  selectedText?: string;
  title?: string;
};

interface AnalyzeGitHubPageInput {
  embeddedData?: unknown;
  repositoryNwo?: string;
  repositoryPublic?: boolean | string;
  url: string;
}

interface PageContextApi {
  PAGE_STATUS: Readonly<{
    ELIGIBLE: "eligible";
    UNSUPPORTED: "unsupported";
  }>;
  UNSUPPORTED_REASON: Readonly<Record<string, UnsupportedReason>>;
  analyzeGitHubPage(input: AnalyzeGitHubPageInput): AnalyzedPageContext;
  readEmbeddedDetails(embeddedData: unknown): EmbeddedDetails;
}

interface EmbeddedDetails {
  path?: string;
  ref?: string;
  repository?: string;
  repositoryPublic?: boolean;
}

interface TrainingInputValidation {
  codeCharacterCount: number;
  codeError: string | null;
  explanationCharacterCount: number;
  explanationError: string | null;
  valid: boolean;
}

interface ReadingSupportInputValidation {
  codeCharacterCount: number;
  codeError: string | null;
  questionCharacterCount: number;
  questionError: string | null;
  valid: boolean;
}

interface InputValidationApi {
  INPUT_LIMITS: Readonly<{
    code: number;
    explanation: number;
    question: number;
  }>;
  countCharacters(value: string): number;
  validateTrainingInput(
    code: string,
    explanation: string,
  ): TrainingInputValidation;
  validateReadingSupportInput(
    code: string,
    question: string,
  ): ReadingSupportInputValidation;
}

interface EvaluationRequest {
  code: string;
  explanation: string;
  language: "python";
  sourceUrl: string;
}

type ReadingSupportStage = "guide" | "detailed_explanation";

interface ReadingSupportRequest {
  code: string;
  language: "python";
  question: string;
  sourceUrl: string;
  stage: ReadingSupportStage;
}

interface ReadingSupportResponse {
  checks: string[];
  contractVersion: "1.0";
  detailedExplanation: string | null;
  focusPoints: string[];
  generatedAt: string;
  hints: string[];
  nextCandidates: Array<{ reason: string; symbol: string }>;
  questions: string[];
  requestId: string;
  stage: ReadingSupportStage;
}

interface EvaluationConfigApi {
  getEvaluationApiPermissionOrigin(): string | null;
  getEvaluationApiUrl(): string | null;
  getReadingSupportApiUrl(): string | null;
}

interface ReadingSupportContractApi {
  parseError(value: unknown): EvaluationWorkerError | null;
  parseResponse(value: unknown): ReadingSupportResponse | null;
}

interface AnalyticsApi {
  record(
    name:
      | "reading_support_started"
      | "reading_support_guide_displayed"
      | "reading_support_detail_displayed"
      | "reading_support_completed",
    stage?: ReadingSupportStage,
  ): Promise<void>;
}

interface EvaluationResponse {
  contractVersion: "1.0";
  criteria: Array<{
    applicable: boolean;
    baseWeight: number;
    exclusionReason: string | null;
    feedback: string | null;
    id: string;
    label: string;
    maxScore: number;
    score: number | null;
  }>;
  evaluatedAt: string;
  gaps: string[];
  modelAnswer: string;
  requestId: string;
  strengths: string[];
  totalScore: number;
}

type EvaluationWorkerResult =
  | { ok: true; response: EvaluationResponse | ReadingSupportResponse }
  | {
      error: {
        code: string;
        details?: Array<{ field: string; reason: string }>;
        message: string;
        retryAfterSeconds?: number;
        retryable: boolean;
      };
      ok: false;
    };

type EvaluationWorkerError = Extract<
  EvaluationWorkerResult,
  { ok: false }
>["error"];

interface EvaluationContractApi {
  parseError(value: unknown): EvaluationWorkerError | null;
  parseResponse(value: unknown): EvaluationResponse | null;
}

type EvaluationUiState =
  | { status: "editing" }
  | { status: "submitting" }
  | {
      explanationInvalid: boolean;
      inputError: string | null;
      message: string;
      retryAfterUntil: number | null;
      retryable: boolean;
      status: "error";
    }
  | { answer: string; response: EvaluationResponse; status: "completed" };

declare var CodeReadingTrainerInputValidation: InputValidationApi;
declare var CodeReadingTrainerEvaluationConfig: EvaluationConfigApi;
declare var CodeReadingTrainerEvaluationContract: EvaluationContractApi;
declare var CodeReadingTrainerReadingSupportContract: ReadingSupportContractApi;
declare var CodeReadingTrainerAnalytics: AnalyticsApi;
declare var CodeReadingTrainerPageContext: PageContextApi;

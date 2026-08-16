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

interface InputValidationApi {
  INPUT_LIMITS: Readonly<{ code: number; explanation: number }>;
  countCharacters(value: string): number;
  validateTrainingInput(
    code: string,
    explanation: string,
  ): TrainingInputValidation;
}

declare var CodeReadingTrainerInputValidation: InputValidationApi;
declare var CodeReadingTrainerPageContext: PageContextApi;

(function initializePageContext(globalObject: typeof globalThis) {
  const PAGE_STATUS = Object.freeze({
    ELIGIBLE: "eligible",
    REPOSITORY: "repository",
    UNSUPPORTED: "unsupported",
  });

  const UNSUPPORTED_REASON = Object.freeze({
    INVALID_URL: "invalid-url",
    NOT_GITHUB: "not-github",
    NOT_CODE_VIEW: "not-code-view",
    NOT_PYTHON: "not-python",
    PRIVATE_REPOSITORY: "private-repository",
    VISIBILITY_UNKNOWN: "visibility-unknown",
    PAGE_DATA_UNAVAILABLE: "page-data-unavailable",
  });

  function unsupported(
    url: string,
    reason: UnsupportedReason,
    details: Partial<PageDetails> = {},
  ): UnsupportedPageContext {
    return {
      status: PAGE_STATUS.UNSUPPORTED,
      reason,
      url,
      repository: details.repository ?? null,
      ref: details.ref ?? null,
      path: details.path ?? null,
    };
  }

  function decodePathSegments(pathname: string): string[] | null {
    try {
      return pathname
        .split("/")
        .slice(1)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      return null;
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
  }

  function readEmbeddedDetails(embeddedData: unknown): EmbeddedDetails {
    if (!isRecord(embeddedData) || !isRecord(embeddedData.payload)) {
      return {};
    }

    const payload = embeddedData.payload;
    const blobRoute = isRecord(payload.codeViewBlobLayoutRoute)
      ? payload.codeViewBlobLayoutRoute
      : undefined;
    const layoutRoute = isRecord(payload.codeViewLayoutRoute)
      ? payload.codeViewLayoutRoute
      : undefined;
    const blobRefInfo = isRecord(blobRoute?.refInfo)
      ? blobRoute.refInfo
      : undefined;
    const layoutRefInfo = isRecord(layoutRoute?.refInfo)
      ? layoutRoute.refInfo
      : undefined;
    const rootRouteCandidates = [
      payload.repoOverviewRoute,
      payload.repositoryRoute,
      payload.repo,
      payload.repository,
    ];
    const rootRoute = rootRouteCandidates.find(isRecord);
    const rootRefInfo = isRecord(payload.refInfo)
      ? payload.refInfo
      : isRecord(rootRoute?.refInfo)
        ? rootRoute.refInfo
        : undefined;
    const repoCandidates = [layoutRoute?.repo, rootRoute?.repo, rootRoute];
    const repo = repoCandidates.find(isRecord);
    const path = blobRoute?.path ?? layoutRoute?.path;
    const ref = blobRefInfo?.name ?? layoutRefInfo?.name;
    const repository =
      typeof repo?.ownerLogin === "string" && typeof repo.name === "string"
        ? `${repo.ownerLogin}/${repo.name}`
        : undefined;
    const repositoryPublic =
      repo?.public ??
      repo?.isPublic ??
      (typeof repo?.isPrivate === "boolean" ? !repo.isPrivate : undefined);
    const commitOidCandidates = [
      blobRoute?.commitOid,
      blobRoute?.oid,
      isRecord(blobRoute?.commit) ? blobRoute.commit.oid : undefined,
      layoutRoute?.commitOid,
      isRecord(blobRefInfo) ? blobRefInfo.oid : undefined,
      isRecord(blobRefInfo) ? blobRefInfo.currentOid : undefined,
      isRecord(layoutRefInfo) ? layoutRefInfo.oid : undefined,
      isRecord(layoutRefInfo) ? layoutRefInfo.currentOid : undefined,
      payload.commitOid,
      payload.currentOid,
      rootRoute?.commitOid,
      rootRoute?.oid,
      isRecord(rootRoute?.commit) ? rootRoute.commit.oid : undefined,
      isRecord(rootRoute?.refInfo) ? rootRoute.refInfo.oid : undefined,
      isRecord(rootRoute?.refInfo) ? rootRoute.refInfo.currentOid : undefined,
      rootRefInfo?.oid,
      rootRefInfo?.currentOid,
    ];
    const commitOid = commitOidCandidates.find(
      (value): value is string =>
        typeof value === "string" &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value),
    );

    return {
      commitOid,
      path: typeof path === "string" ? path : undefined,
      ref:
        typeof ref === "string"
          ? ref
          : typeof rootRoute?.refName === "string"
            ? rootRoute.refName
            : typeof rootRefInfo?.name === "string"
              ? rootRefInfo.name
              : undefined,
      repository,
      repositoryPublic:
        typeof repositoryPublic === "boolean" ? repositoryPublic : undefined,
    };
  }

  function normalizeVisibility(
    repositoryPublic: boolean | string | undefined,
    embeddedDetails: EmbeddedDetails,
  ) {
    const metaVisibility =
      repositoryPublic === "true" || repositoryPublic === true
        ? true
        : repositoryPublic === "false" || repositoryPublic === false
          ? false
          : undefined;
    const embeddedVisibility = embeddedDetails.repositoryPublic;

    return {
      conflicts:
        metaVisibility !== undefined &&
        embeddedVisibility !== undefined &&
        metaVisibility !== embeddedVisibility,
      embeddedVisibility,
      metaVisibility,
    };
  }

  function resolveRefAndPath(
    blobSegments: string[],
    embeddedDetails: EmbeddedDetails,
  ): { path: string; ref: string } | null {
    if (!embeddedDetails.ref || !embeddedDetails.path) {
      return null;
    }

    const expectedBlobPath = `${embeddedDetails.ref}/${embeddedDetails.path}`;
    if (blobSegments.join("/") !== expectedBlobPath) {
      return null;
    }

    return {
      ref: embeddedDetails.ref,
      path: embeddedDetails.path,
    };
  }

  function analyzeGitHubPage({
    url,
    repositoryNwo,
    repositoryPublic,
    embeddedData,
  }: AnalyzeGitHubPageInput): AnalyzedPageContext {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return unsupported(url, UNSUPPORTED_REASON.INVALID_URL);
    }

    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== "github.com"
    ) {
      return unsupported(parsedUrl.href, UNSUPPORTED_REASON.NOT_GITHUB);
    }

    const segments = decodePathSegments(parsedUrl.pathname);
    if (!segments || !segments[0] || !segments[1]) {
      return unsupported(parsedUrl.href, UNSUPPORTED_REASON.NOT_CODE_VIEW);
    }

    const isRepositoryRoot =
      segments.length === 2 || (segments.length === 3 && segments[2] === "");
    const isBlob = segments.length >= 5 && segments[2] === "blob";
    if (!isRepositoryRoot && !isBlob) {
      return unsupported(parsedUrl.href, UNSUPPORTED_REASON.NOT_CODE_VIEW);
    }

    const repository = `${segments[0]}/${segments[1]}`;
    if (
      !repositoryNwo ||
      repositoryNwo.toLocaleLowerCase("en-US") !==
        repository.toLocaleLowerCase("en-US")
    ) {
      return unsupported(
        parsedUrl.href,
        UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE,
        { repository },
      );
    }

    const embeddedDetails = readEmbeddedDetails(embeddedData);
    if (
      !embeddedDetails.repository ||
      embeddedDetails.repository.toLocaleLowerCase("en-US") !==
        repository.toLocaleLowerCase("en-US")
    ) {
      return unsupported(
        parsedUrl.href,
        UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE,
        { repository },
      );
    }

    const refAndPath = isBlob
      ? resolveRefAndPath(segments.slice(3), embeddedDetails)
      : embeddedDetails.ref
        ? { ref: embeddedDetails.ref, path: null }
        : null;
    if (!refAndPath?.ref || (isBlob && !refAndPath.path)) {
      return unsupported(
        parsedUrl.href,
        UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE,
        { repository },
      );
    }

    const details = { repository, ...refAndPath };
    const visibility = normalizeVisibility(repositoryPublic, embeddedDetails);
    if (visibility.embeddedVisibility === undefined) {
      return unsupported(
        parsedUrl.href,
        UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE,
        details,
      );
    }

    if (visibility.conflicts) {
      return unsupported(
        parsedUrl.href,
        UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE,
        details,
      );
    }

    if (visibility.embeddedVisibility === false) {
      return unsupported(
        parsedUrl.href,
        UNSUPPORTED_REASON.PRIVATE_REPOSITORY,
        details,
      );
    }

    if (visibility.metaVisibility !== true) {
      return unsupported(
        parsedUrl.href,
        UNSUPPORTED_REASON.VISIBILITY_UNKNOWN,
        details,
      );
    }

    if (isRepositoryRoot) {
      if (!embeddedDetails.commitOid) {
        return unsupported(
          parsedUrl.href,
          UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE,
          details,
        );
      }
      return {
        commitOid: embeddedDetails.commitOid,
        status: PAGE_STATUS.REPOSITORY,
        reason: null,
        url: parsedUrl.href,
        repository,
        ref: refAndPath.ref,
        path: null,
      };
    }

    if (!refAndPath.path?.endsWith(".py")) {
      return unsupported(
        parsedUrl.href,
        UNSUPPORTED_REASON.NOT_PYTHON,
        details,
      );
    }

    return {
      ...(embeddedDetails.commitOid
        ? { commitOid: embeddedDetails.commitOid }
        : {}),
      status: PAGE_STATUS.ELIGIBLE,
      reason: null,
      url: parsedUrl.href,
      repository,
      ref: refAndPath.ref,
      path: refAndPath.path,
    };
  }

  globalObject.CodeReadingTrainerPageContext = Object.freeze({
    PAGE_STATUS,
    UNSUPPORTED_REASON,
    analyzeGitHubPage,
    readEmbeddedDetails,
  });
})(globalThis);

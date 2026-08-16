(function initializePageContext(globalObject) {
  const PAGE_STATUS = Object.freeze({
    ELIGIBLE: "eligible",
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

  function unsupported(url, reason, details = {}) {
    return {
      status: PAGE_STATUS.UNSUPPORTED,
      reason,
      url,
      repository: details.repository ?? null,
      ref: details.ref ?? null,
      path: details.path ?? null,
    };
  }

  function decodePathSegments(pathname) {
    try {
      return pathname
        .split("/")
        .slice(1)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      return null;
    }
  }

  function readEmbeddedDetails(embeddedData) {
    const payload = embeddedData?.payload;
    if (!payload || typeof payload !== "object") {
      return {};
    }

    const blobRoute = payload.codeViewBlobLayoutRoute;
    const layoutRoute = payload.codeViewLayoutRoute;
    const path = blobRoute?.path ?? layoutRoute?.path;
    const ref = blobRoute?.refInfo?.name ?? layoutRoute?.refInfo?.name;
    const repository =
      layoutRoute?.repo?.ownerLogin && layoutRoute?.repo?.name
        ? `${layoutRoute.repo.ownerLogin}/${layoutRoute.repo.name}`
        : undefined;
    const repositoryPublic = layoutRoute?.repo?.public;

    return {
      path: typeof path === "string" ? path : undefined,
      ref: typeof ref === "string" ? ref : undefined,
      repository,
      repositoryPublic:
        typeof repositoryPublic === "boolean" ? repositoryPublic : undefined,
    };
  }

  function normalizeVisibility(repositoryPublic, embeddedDetails) {
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

  function resolveRefAndPath(blobSegments, embeddedDetails) {
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
  }) {
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
    if (
      !segments ||
      segments.length < 5 ||
      !segments[0] ||
      !segments[1] ||
      segments[2] !== "blob"
    ) {
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

    const refAndPath = resolveRefAndPath(segments.slice(3), embeddedDetails);
    if (!refAndPath?.ref || !refAndPath.path) {
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

    if (!refAndPath.path.endsWith(".py")) {
      return unsupported(
        parsedUrl.href,
        UNSUPPORTED_REASON.NOT_PYTHON,
        details,
      );
    }

    return {
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

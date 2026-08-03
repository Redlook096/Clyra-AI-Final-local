/**
 * Licensed-footage search foundation for Clyra Clipper.
 *
 * This module intentionally searches only documented provider APIs. It never
 * scrapes catalogue pages, downloads media, stores an API key in a response,
 * or treats an asset with an unknown licence as usable footage. The renderer
 * can use the returned provenance to present an asset and must ask for an
 * explicit user choice before any later download or insertion work happens.
 */

export const FOOTAGE_PROVIDERS = ["wikimedia", "pexels", "pixabay"] as const;

export type FootageProvider = (typeof FOOTAGE_PROVIDERS)[number];
export type FootageProviderState = "available" | "unavailable" | "error";
export type LicenceConfidence = "source-declared" | "provider-declared";

export interface LicensedFootageAsset {
  /** Stable Clyra namespaced identifier; it is not a local file path. */
  id: string;
  provider: FootageProvider;
  providerAssetId: string;
  sourcePageUrl: string;
  /** A provider-supplied direct media URL. Clyra does not fetch it here. */
  downloadUrl?: string;
  previewUrl?: string;
  creatorName?: string;
  creatorUrl?: string;
  licenceName: string;
  licenceUrl?: string;
  licenceConfidence: LicenceConfidence;
  attributionRequired: boolean;
  attributionText?: string;
  title: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  mimeType?: string;
  /** A deliberately small, provenance-only subset of source metadata. */
  sourceMetadata: Record<string, string | number | boolean | null>;
}

export interface FootageProviderResult {
  provider: FootageProvider;
  state: FootageProviderState;
  assets: LicensedFootageAsset[];
  rejectedCount: number;
  nextCursor?: string;
  code?: "provider_not_configured" | "provider_unavailable";
  message?: string;
}

export interface LicensedFootageSearchResponse {
  query: string;
  limit: number;
  results: FootageProviderResult[];
}

export interface LicensedFootageSearchInput {
  query: string;
  limit?: number;
  providers?: FootageProvider[];
  /** Provider-specific opaque continuation token returned by a prior search. */
  cursor?: string;
}

export interface LicensedFootageServiceOptions {
  /** Keys are read only in the backend process. Never use VITE_ variables. */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class FootageSearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FootageSearchValidationError";
  }
}

const PROVIDER_LABELS: Record<FootageProvider, string> = {
  wikimedia: "Wikimedia Commons",
  pexels: "Pexels",
  pixabay: "Pixabay",
};

const PROVIDER_LICENCES: Record<Exclude<FootageProvider, "wikimedia">, { name: string; url: string }> = {
  pexels: {
    name: "Pexels License",
    url: "https://www.pexels.com/license/",
  },
  pixabay: {
    name: "Pixabay Content License",
    url: "https://pixabay.com/service/license-summary/",
  },
};

const MAX_QUERY_LENGTH = 160;
const MAX_CURSOR_LENGTH = 500;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function identifier(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function stripHtml(value: unknown): string {
  return text(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return undefined;
}

function isKnownOpenLicence(name: string): boolean {
  const normalised = name.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  if (!normalised) return false;
  // Editing a video can create a derivative work. Exclude licences that
  // prohibit derivatives or commercial use rather than guessing at rights.
  if (/\b(?:nc|nd)\b|non-commercial|no derivatives|all rights reserved|fair use|unknown|copyrighted|non-free/.test(normalised)) {
    return false;
  }
  return (
    /^(?:cc0|public domain|pd\b)/.test(normalised) ||
    /\bcc[- ]?by(?:[- ]?sa)?\b/.test(normalised) ||
    /creative commons attribution(?:[- ]sharealike)?/.test(normalised) ||
    /gnu free documentation license|\bgfdl\b/.test(normalised) ||
    normalised === "pexels license" ||
    normalised === "pixabay content license"
  );
}

function normaliseKnownProviderLicence(
  provider: Exclude<FootageProvider, "wikimedia">,
  rawName: unknown,
  rawUrl: unknown,
) {
  const declaredName = text(rawName);
  if (declaredName && !isKnownOpenLicence(declaredName)) return null;
  const fallback = PROVIDER_LICENCES[provider];
  return {
    name: declaredName || fallback.name,
    url: firstString(rawUrl) || fallback.url,
    confidence: "provider-declared" as const,
  };
}

function cleanUrl(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function buildAttribution(
  creatorName: string | undefined,
  title: string,
  licenceName: string,
  attributionRequired: boolean,
) {
  if (!attributionRequired && !creatorName) return undefined;
  const creator = creatorName ? ` by ${creatorName}` : "";
  return `${title}${creator} — ${licenceName}`;
}

function boundedLimit(value: number | undefined) {
  const candidate = Number.isFinite(value) ? Math.floor(Number(value)) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, candidate || DEFAULT_LIMIT));
}

export function validateFootageSearchInput(input: LicensedFootageSearchInput): Required<Pick<LicensedFootageSearchInput, "query" | "limit">> & Omit<LicensedFootageSearchInput, "query" | "limit"> {
  const query = text(input.query).replace(/\s+/g, " ");
  if (query.length < 2) throw new FootageSearchValidationError("Enter at least two characters to search licensed footage.");
  if (query.length > MAX_QUERY_LENGTH) throw new FootageSearchValidationError("The footage search is too long.");
  const providers = input.providers?.filter((provider): provider is FootageProvider => FOOTAGE_PROVIDERS.includes(provider));
  if (input.providers && !providers?.length) throw new FootageSearchValidationError("Choose a supported footage provider.");
  const cursor = text(input.cursor);
  if (cursor.length > MAX_CURSOR_LENGTH) throw new FootageSearchValidationError("The footage continuation token is invalid.");
  return {
    ...input,
    query,
    limit: boundedLimit(input.limit),
    providers: providers?.length ? [...new Set(providers)] : undefined,
    cursor: cursor || undefined,
  };
}

interface WikimediaImageInfo {
  url?: unknown;
  thumburl?: unknown;
  descriptionurl?: unknown;
  mime?: unknown;
  width?: unknown;
  height?: unknown;
  size?: unknown;
  extmetadata?: Record<string, { value?: unknown }>;
}

interface WikimediaPage {
  pageid?: unknown;
  title?: unknown;
  fullurl?: unknown;
  imageinfo?: WikimediaImageInfo[];
}

/** Exported for fixture tests and for a future persistent asset store. */
export function normaliseWikimediaVideo(page: WikimediaPage): LicensedFootageAsset | null {
  const info = page.imageinfo?.[0];
  const mimeType = text(info?.mime);
  if (!info || !mimeType.startsWith("video/")) return null;
  const metadata = info.extmetadata || {};
  const licenceName = stripHtml(metadata.LicenseShortName?.value || metadata.UsageTerms?.value);
  if (!isKnownOpenLicence(licenceName)) return null;
  const sourcePageUrl = cleanUrl(info.descriptionurl || page.fullurl);
  const downloadUrl = cleanUrl(info.url);
  if (!sourcePageUrl || !downloadUrl) return null;
  const creatorName = stripHtml(metadata.Artist?.value) || undefined;
  const creatorUrl = cleanUrl(metadata.Artist?.value);
  const licenceUrl = cleanUrl(metadata.LicenseUrl?.value);
  const title = stripHtml(metadata.ObjectName?.value) || text(page.title).replace(/^File:/i, "") || "Wikimedia Commons video";
  const attributionRequired = !/^\s*(?:cc0|public domain|pd\b)/i.test(licenceName);
  return {
    id: `wikimedia:${String(page.pageid || title)}`,
    provider: "wikimedia",
    providerAssetId: String(page.pageid || title),
    sourcePageUrl,
    downloadUrl,
    previewUrl: cleanUrl(info.thumburl),
    creatorName,
    creatorUrl,
    licenceName,
    licenceUrl,
    licenceConfidence: "source-declared",
    attributionRequired,
    attributionText: buildAttribution(creatorName, title, licenceName, attributionRequired),
    title,
    width: numberOrUndefined(info.width),
    height: numberOrUndefined(info.height),
    mimeType,
    sourceMetadata: {
      pageId: numberOrUndefined(page.pageid) ?? null,
      mimeType,
      fileSizeBytes: numberOrUndefined(info.size) ?? null,
      licenceName,
      attributionRequired,
    },
  };
}

interface PexelsVideoFile {
  link?: unknown;
  quality?: unknown;
  file_type?: unknown;
  width?: unknown;
  height?: unknown;
  fps?: unknown;
}

interface PexelsVideo {
  id?: unknown;
  url?: unknown;
  image?: unknown;
  duration?: unknown;
  width?: unknown;
  height?: unknown;
  user?: { name?: unknown; url?: unknown };
  video_files?: PexelsVideoFile[];
  license?: unknown;
  licence?: unknown;
  license_url?: unknown;
  licence_url?: unknown;
}

function choosePexelsFile(files: PexelsVideoFile[] | undefined) {
  return (files || [])
    .filter((file) => cleanUrl(file.link))
    .sort((left, right) => {
      const leftPixels = (numberOrUndefined(left.width) || 0) * (numberOrUndefined(left.height) || 0);
      const rightPixels = (numberOrUndefined(right.width) || 0) * (numberOrUndefined(right.height) || 0);
      return rightPixels - leftPixels;
    })[0];
}

/** Exported for fixture tests and for a future persistent asset store. */
export function normalisePexelsVideo(video: PexelsVideo): LicensedFootageAsset | null {
  const providerAssetId = identifier(video.id);
  const sourcePageUrl = cleanUrl(video.url);
  const media = choosePexelsFile(video.video_files);
  const downloadUrl = cleanUrl(media?.link);
  const licence = normaliseKnownProviderLicence("pexels", video.license || video.licence, video.license_url || video.licence_url);
  if (!providerAssetId || !sourcePageUrl || !downloadUrl || !licence) return null;
  const creatorName = text(video.user?.name) || undefined;
  const title = creatorName ? `Pexels video by ${creatorName}` : `Pexels video ${providerAssetId}`;
  return {
    id: `pexels:${providerAssetId}`,
    provider: "pexels",
    providerAssetId,
    sourcePageUrl,
    downloadUrl,
    previewUrl: cleanUrl(video.image),
    creatorName,
    creatorUrl: cleanUrl(video.user?.url),
    licenceName: licence.name,
    licenceUrl: licence.url,
    licenceConfidence: licence.confidence,
    attributionRequired: false,
    attributionText: buildAttribution(creatorName, title, licence.name, false),
    title,
    durationSeconds: numberOrUndefined(video.duration),
    width: numberOrUndefined(video.width) || numberOrUndefined(media?.width),
    height: numberOrUndefined(video.height) || numberOrUndefined(media?.height),
    mimeType: text(media?.file_type) || undefined,
    sourceMetadata: {
      source: "Pexels API",
      providerAssetId,
      quality: text(media?.quality) || null,
      fps: numberOrUndefined(media?.fps) ?? null,
      licenceName: licence.name,
      attributionRequired: false,
    },
  };
}

interface PixabayVideoVariant {
  url?: unknown;
  width?: unknown;
  height?: unknown;
  size?: unknown;
}

interface PixabayVideo {
  id?: unknown;
  pageURL?: unknown;
  tags?: unknown;
  duration?: unknown;
  user?: unknown;
  user_id?: unknown;
  userImageURL?: unknown;
  videos?: Record<string, PixabayVideoVariant>;
  license?: unknown;
  licence?: unknown;
  license_url?: unknown;
  licence_url?: unknown;
}

function choosePixabayVariant(variants: Record<string, PixabayVideoVariant> | undefined) {
  const preferredNames = ["large", "medium", "small", "tiny"];
  for (const name of preferredNames) {
    const variant = variants?.[name];
    if (variant && cleanUrl(variant.url)) return variant;
  }
  return Object.values(variants || {}).find((variant) => cleanUrl(variant.url));
}

/** Exported for fixture tests and for a future persistent asset store. */
export function normalisePixabayVideo(video: PixabayVideo): LicensedFootageAsset | null {
  const providerAssetId = identifier(video.id);
  const sourcePageUrl = cleanUrl(video.pageURL);
  const media = choosePixabayVariant(video.videos);
  const downloadUrl = cleanUrl(media?.url);
  const licence = normaliseKnownProviderLicence("pixabay", video.license || video.licence, video.license_url || video.licence_url);
  if (!providerAssetId || !sourcePageUrl || !downloadUrl || !licence) return null;
  const creatorName = text(video.user) || undefined;
  const title = text(video.tags).split(",")[0]?.trim() || (creatorName ? `Pixabay video by ${creatorName}` : `Pixabay video ${providerAssetId}`);
  const creatorId = identifier(video.user_id);
  const creatorUrl = creatorId ? cleanUrl(`https://pixabay.com/users/${encodeURIComponent(text(video.user))}-${encodeURIComponent(creatorId)}/`) : undefined;
  return {
    id: `pixabay:${providerAssetId}`,
    provider: "pixabay",
    providerAssetId,
    sourcePageUrl,
    downloadUrl,
    previewUrl: cleanUrl(video.userImageURL),
    creatorName,
    creatorUrl,
    licenceName: licence.name,
    licenceUrl: licence.url,
    licenceConfidence: licence.confidence,
    attributionRequired: false,
    attributionText: buildAttribution(creatorName, title, licence.name, false),
    title,
    durationSeconds: numberOrUndefined(video.duration),
    width: numberOrUndefined(media?.width),
    height: numberOrUndefined(media?.height),
    mimeType: "video/mp4",
    sourceMetadata: {
      source: "Pixabay API",
      providerAssetId,
      fileSizeBytes: numberOrUndefined(media?.size) ?? null,
      licenceName: licence.name,
      attributionRequired: false,
    },
  };
}

function configuredKey(value: string | undefined) {
  const key = text(value);
  return key || undefined;
}

function headersForPexels(apiKey: string) {
  return { Authorization: apiKey, Accept: "application/json" };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`provider-status-${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchWikimedia(
  query: string,
  limit: number,
  cursor: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<FootageProviderResult> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(limit));
  url.searchParams.set("prop", "imageinfo|info");
  url.searchParams.set("iiprop", "url|size|mime|extmetadata");
  url.searchParams.set("iiurlwidth", "640");
  url.searchParams.set("inprop", "url");
  url.searchParams.set("origin", "*");
  if (cursor) url.searchParams.set("gsrcontinue", cursor);
  try {
    const payload = await fetchJson(fetchImpl, url, { headers: { Accept: "application/json" } }, timeoutMs) as {
      query?: { pages?: WikimediaPage[] };
      continue?: { gsrcontinue?: unknown };
    };
    const pages = Array.isArray(payload.query?.pages) ? payload.query!.pages! : [];
    const normalised = pages.map(normaliseWikimediaVideo);
    const assets = normalised.filter((asset): asset is LicensedFootageAsset => asset !== null);
    return {
      provider: "wikimedia",
      state: "available",
      assets,
      rejectedCount: normalised.length - assets.length,
      nextCursor: text(payload.continue?.gsrcontinue) || undefined,
    };
  } catch {
    return {
      provider: "wikimedia",
      state: "error",
      assets: [],
      rejectedCount: 0,
      code: "provider_unavailable",
      message: "Wikimedia Commons footage search is temporarily unavailable.",
    };
  }
}

async function searchPexels(
  query: string,
  limit: number,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<FootageProviderResult> {
  if (!apiKey) {
    return {
      provider: "pexels",
      state: "unavailable",
      assets: [],
      rejectedCount: 0,
      code: "provider_not_configured",
      message: "Pexels footage search is not configured in this Clyra build.",
    };
  }
  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(limit));
  try {
    const payload = await fetchJson(fetchImpl, url, { headers: headersForPexels(apiKey) }, timeoutMs) as { videos?: PexelsVideo[] };
    const videos = Array.isArray(payload.videos) ? payload.videos : [];
    const normalised = videos.map(normalisePexelsVideo);
    const assets = normalised.filter((asset): asset is LicensedFootageAsset => asset !== null);
    return { provider: "pexels", state: "available", assets, rejectedCount: normalised.length - assets.length };
  } catch {
    return {
      provider: "pexels",
      state: "error",
      assets: [],
      rejectedCount: 0,
      code: "provider_unavailable",
      message: "Pexels footage search is temporarily unavailable.",
    };
  }
}

async function searchPixabay(
  query: string,
  limit: number,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<FootageProviderResult> {
  if (!apiKey) {
    return {
      provider: "pixabay",
      state: "unavailable",
      assets: [],
      rejectedCount: 0,
      code: "provider_not_configured",
      message: "Pixabay footage search is not configured in this Clyra build.",
    };
  }
  const url = new URL("https://pixabay.com/api/videos/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(limit));
  url.searchParams.set("safesearch", "true");
  try {
    const payload = await fetchJson(fetchImpl, url, { headers: { Accept: "application/json" } }, timeoutMs) as { hits?: PixabayVideo[] };
    const videos = Array.isArray(payload.hits) ? payload.hits : [];
    const normalised = videos.map(normalisePixabayVideo);
    const assets = normalised.filter((asset): asset is LicensedFootageAsset => asset !== null);
    return { provider: "pixabay", state: "available", assets, rejectedCount: normalised.length - assets.length };
  } catch {
    return {
      provider: "pixabay",
      state: "error",
      assets: [],
      rejectedCount: 0,
      code: "provider_unavailable",
      message: "Pixabay footage search is temporarily unavailable.",
    };
  }
}

/**
 * Backend-only provider service. It returns provider-safe availability states
 * rather than throwing a missing-key error or leaking a provider response.
 */
export class LicensedFootageService {
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LicensedFootageServiceOptions = {}) {
    this.env = options.env || process.env;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs || 12_000));
  }

  async search(input: LicensedFootageSearchInput): Promise<LicensedFootageSearchResponse> {
    const request = validateFootageSearchInput(input);
    const providers = request.providers || FOOTAGE_PROVIDERS;
    const pexelsKey = configuredKey(this.env.PEXELS_API_KEY);
    const pixabayKey = configuredKey(this.env.PIXABAY_API_KEY);
    const work = providers.map((provider) => {
      switch (provider) {
        case "wikimedia":
          return searchWikimedia(request.query, request.limit, request.cursor, this.fetchImpl, this.timeoutMs);
        case "pexels":
          return searchPexels(request.query, request.limit, pexelsKey, this.fetchImpl, this.timeoutMs);
        case "pixabay":
          return searchPixabay(request.query, request.limit, pixabayKey, this.fetchImpl, this.timeoutMs);
      }
    });
    return { query: request.query, limit: request.limit, results: await Promise.all(work) };
  }
}

export function createLicensedFootageService(options: LicensedFootageServiceOptions = {}) {
  return new LicensedFootageService(options);
}

export function isFootageProvider(value: unknown): value is FootageProvider {
  return typeof value === "string" && (FOOTAGE_PROVIDERS as readonly string[]).includes(value);
}

export function footageProviderLabel(provider: FootageProvider) {
  return PROVIDER_LABELS[provider];
}

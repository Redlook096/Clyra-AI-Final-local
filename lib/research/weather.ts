export type WeatherDay = {
  date: string;
  highC: number;
  lowC: number;
  precipProb: number;
  weatherCode: number;
  condition: string;
};

export type WeatherResult = {
  ok: true;
  location: string;
  region?: string;
  country?: string;
  timezone?: string;
  observedAt?: string;
  matchedFrom?: string;
  current: {
    tempC: number;
    weatherCode: number;
    isDay: boolean;
    highC: number;
    lowC: number;
    precipProb: number;
    condition: string;
  };
  daily: WeatherDay[];
};

export type WeatherFailure = {
  ok: false;
  error: string;
  suggestions?: string[];
};

type GeoPlace = {
  name: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  country?: string;
  timezone?: string;
  country_code?: string;
  population?: number;
  score?: number;
};

function weatherCondition(code: number): string {
  if (code === 0) return "Clear";
  if (code === 1) return "Mainly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Clouds";
}

function normalizePlace(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prior = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = prev[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, prior + cost);
      prior = temp;
    }
  }
  return prev[b.length]!;
}

function similarity(a: string, b: string): number {
  const left = normalizePlace(a);
  const right = normalizePlace(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  // Exact substring hits inflate weak matches ("Tokoyo" inside "Tokoyono").
  // Prefer tighter name length when the alias/canonical city is known.
  if (left.includes(right) || right.includes(left)) {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    return Math.max(0.75, shorter / longer);
  }
  const dist = levenshtein(left, right);
  const maxLen = Math.max(left.length, right.length);
  return Math.max(0, 1 - dist / maxLen);
}

function placeLabel(place: GeoPlace) {
  return [place.name, place.admin1, place.country].filter(Boolean).join(", ");
}

const PLACE_ALIASES: Array<{ pattern: RegExp; rewrite: string }> = [
  { pattern: /\bsidney\b/i, rewrite: "Sydney" },
  { pattern: /\bsydny\b/i, rewrite: "Sydney" },
  { pattern: /\bsydne\b/i, rewrite: "Sydney" },
  { pattern: /\btokoyo\b/i, rewrite: "Tokyo" },
  { pattern: /\btokio\b/i, rewrite: "Tokyo" },
  { pattern: /\btokyo\b/i, rewrite: "Tokyo" },
  { pattern: /\bmelburn\b/i, rewrite: "Melbourne" },
  { pattern: /\bmelbourne\b/i, rewrite: "Melbourne" },
  { pattern: /\bbrisban?e?\b/i, rewrite: "Brisbane" },
  { pattern: /\blondon\b/i, rewrite: "London" },
  { pattern: /\bnew york\b/i, rewrite: "New York" },
  { pattern: /\blos angeles\b/i, rewrite: "Los Angeles" },
  { pattern: /\bsan fransisco\b/i, rewrite: "San Francisco" },
  { pattern: /\bsan francisco\b/i, rewrite: "San Francisco" },
  { pattern: /\bhornsby hights\b/i, rewrite: "Hornsby Heights" },
  { pattern: /\bhronsby\b/i, rewrite: "Hornsby" },
];

function applyPlaceAliases(raw: string): string {
  let next = raw;
  for (const alias of PLACE_ALIASES) {
    next = next.replace(alias.pattern, alias.rewrite);
  }
  return next;
}

function locationQueryCandidates(raw: string): string[] {
  const aliased = applyPlaceAliases(raw.trim().replace(/\s+/g, " "));
  const base = aliased;
  if (!base) return [];
  const withoutState = base
    .replace(
      /,?\s*\b(?:NSW|VIC|QLD|SA|WA|TAS|ACT|NT|New South Wales|Victoria|Queensland|South Australia|Western Australia|Tasmania)\b\.?$/i,
      "",
    )
    .trim();
  const withoutCountry = withoutState
    .replace(/,?\s*\b(?:Australia|United States|USA|UK|Canada|England|Japan)\b\.?$/i, "")
    .trim();
  const parts = withoutCountry
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const collapsed = withoutCountry.replace(/\s+/g, "");
  const noVowels = withoutCountry.replace(/[aeiou]/gi, "");
  const candidates = [
    raw.trim(),
    base,
    withoutState,
    withoutCountry,
    parts.slice(0, 3).join(" "),
    parts.slice(0, 2).join(" "),
    parts[0],
    collapsed,
    noVowels.length >= 4 ? noVowels : "",
    withoutCountry
      .replace(/\b(heights|hills|park|north|south|east|west|city|suburb)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim(),
  ].filter(Boolean) as string[];

  const typoSource = withoutCountry.length <= 24 ? withoutCountry : parts[0] || "";
  for (let i = 0; i < typoSource.length - 1; i += 1) {
    const chars = typoSource.split("");
    const tmp = chars[i]!;
    chars[i] = chars[i + 1]!;
    chars[i + 1] = tmp;
    candidates.push(chars.join(""));
  }

  return [...new Set(candidates.map((c) => c.trim()).filter((c) => c.length >= 2))];
}

function prefersAustralia(query: string) {
  const aliased = applyPlaceAliases(query);
  return /\b(?:nsw|vic|qld|sa|wa|tas|act|nt|australia|sydney|melbourne|brisbane|perth|adelaide|canberra|hornsby)\b/i.test(
    `${query} ${aliased}`,
  );
}

function prefersCountryCode(query: string): string | null {
  const aliased = applyPlaceAliases(query);
  const hay = `${query} ${aliased}`;
  if (prefersAustralia(hay)) return "AU";
  if (/\b(?:japan|tokyo|osaka|kyoto)\b/i.test(hay)) return "JP";
  if (/\b(?:uk|england|scotland|wales|london)\b/i.test(hay)) return "GB";
  if (/\b(?:usa|united states|new york|california)\b/i.test(hay)) return "US";
  return null;
}

function scorePlace(query: string, place: GeoPlace): number {
  const aliasedQuery = applyPlaceAliases(query);
  const label = placeLabel(place);
  const nameScore = Math.max(
    similarity(query, place.name),
    similarity(aliasedQuery, place.name),
  );
  const labelScore = Math.max(
    similarity(query, label),
    similarity(aliasedQuery, label),
  );
  const tokenQuery = normalizePlace(aliasedQuery).split(" ");
  const tokenName = normalizePlace(place.name).split(" ");
  const tokenHits = tokenQuery.filter((token) =>
    tokenName.some((part) => similarity(token, part) >= 0.72),
  ).length;
  const tokenScore = tokenQuery.length ? tokenHits / tokenQuery.length : 0;
  let score = Math.max(nameScore, labelScore * 0.96, tokenScore * 0.9);

  // Prefer canonical city names after alias rewrite (Tokyo, Sydney, Melbourne…).
  if (normalizePlace(place.name) === normalizePlace(aliasedQuery.split(",")[0] || aliasedQuery)) {
    score += 0.2;
  }

  const wantedCountry = prefersCountryCode(aliasedQuery);
  if (wantedCountry) {
    if (place.country_code === wantedCountry) {
      score += 0.14;
    } else {
      score -= 0.18;
    }
  }

  // Prefer larger / better-known places when names collide.
  if (typeof place.population === "number" && place.population > 0) {
    score += Math.min(0.18, Math.log10(place.population + 1) / 40);
  }

  return score;
}

async function searchOpenMeteo(candidate: string): Promise<GeoPlace[]> {
  const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geoUrl.searchParams.set("name", candidate);
  geoUrl.searchParams.set("count", "10");
  geoUrl.searchParams.set("language", "en");
  geoUrl.searchParams.set("format", "json");
  const geoRes = await fetch(geoUrl);
  if (!geoRes.ok) return [];
    const geoJson = (await geoRes.json()) as {
    results?: Array<{
      name?: string;
      latitude?: number;
      longitude?: number;
      admin1?: string;
      country?: string;
      timezone?: string;
      country_code?: string;
      population?: number;
    }>;
  };
  return (geoJson.results || [])
    .filter((r) => Boolean(r?.name && r.latitude != null && r.longitude != null))
    .map((r) => ({
      name: String(r.name),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      admin1: r.admin1,
      country: r.country,
      timezone: r.timezone,
      country_code: r.country_code,
      population: typeof (r as { population?: number }).population === "number"
        ? Number((r as { population?: number }).population)
        : undefined,
    }));
}

async function searchNominatim(candidate: string): Promise<GeoPlace[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", candidate);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "8");
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ClyraAI/1.0 (weather lookup)",
    },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{
    display_name?: string;
    name?: string;
    lat?: string;
    lon?: string;
    address?: {
      city?: string;
      town?: string;
      village?: string;
      suburb?: string;
      state?: string;
      country?: string;
      country_code?: string;
    };
  }>;
  const places: Array<GeoPlace | null> = (data || []).map((item) => {
    const name =
      item.name ||
      item.address?.suburb ||
      item.address?.city ||
      item.address?.town ||
      item.address?.village ||
      item.display_name?.split(",")[0] ||
      "";
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);
    if (!name || Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
    return {
      name,
      latitude,
      longitude,
      admin1: item.address?.state,
      country: item.address?.country,
      country_code: item.address?.country_code?.toUpperCase(),
    } satisfies GeoPlace;
  });
  return places.filter((place): place is GeoPlace => place !== null);
}

async function geocodeLocation(locationQuery: string): Promise<{
  place: GeoPlace | null;
  suggestions: string[];
}> {
  const ranked = new Map<string, GeoPlace>();
  const candidates = locationQueryCandidates(locationQuery);

  for (const candidate of candidates.slice(0, 8)) {
    const results = await searchOpenMeteo(candidate);
    for (const place of results) {
      const scored = { ...place, score: scorePlace(locationQuery, place) };
      const key = `${scored.name}|${scored.admin1}|${scored.country}|${scored.latitude.toFixed(2)}|${scored.longitude.toFixed(2)}`;
      const existing = ranked.get(key);
      if (!existing || (existing.score ?? 0) < (scored.score ?? 0)) {
        ranked.set(key, scored);
      }
    }
  }

  let places = [...ranked.values()].sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
    return (b.population ?? 0) - (a.population ?? 0);
  });

  if (!places.length || (places[0]?.score ?? 0) < 0.58) {
    for (const candidate of candidates.slice(0, 4)) {
      const results = await searchNominatim(candidate);
      for (const place of results) {
        const scored = { ...place, score: scorePlace(locationQuery, place) };
        const key = `${scored.name}|${scored.admin1}|${scored.country}|${scored.latitude.toFixed(2)}|${scored.longitude.toFixed(2)}`;
        const existing = ranked.get(key);
        if (!existing || (existing.score ?? 0) < (scored.score ?? 0)) {
          ranked.set(key, scored);
        }
      }
    }
    places = [...ranked.values()].sort((a, b) => {
      const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
      return (b.population ?? 0) - (a.population ?? 0);
    });
  }

  const suggestions = places
    .slice(0, 5)
    .map((place) => placeLabel(place))
    .filter(Boolean);

  const best = places[0];
  if (best && (best.score ?? 0) >= 0.55) {
    return { place: best, suggestions };
  }

  return { place: null, suggestions };
}

export async function fetchLiveWeather(
  locationQuery: string,
): Promise<WeatherResult | WeatherFailure> {
  const query = locationQuery.trim();
  if (!query) {
    return { ok: false, error: "Location required" };
  }

  const { place, suggestions } = await geocodeLocation(query);
  if (!place) {
    const hint = suggestions.length
      ? ` Did you mean ${suggestions
          .slice(0, 3)
          .map((s) => `“${s}”`)
          .join(", ")}?`
      : " Try a nearby city or suburb name.";
    return {
      ok: false,
      error: `I couldn't find a location matching “${query}”.${hint}`,
      suggestions,
    };
  }

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(place.latitude));
  forecastUrl.searchParams.set("longitude", String(place.longitude));
  forecastUrl.searchParams.set(
    "current",
    "temperature_2m,weather_code,is_day,relative_humidity_2m,wind_speed_10m",
  );
  forecastUrl.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
  );
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set("forecast_days", "7");

  const forecastRes = await fetch(forecastUrl);
  if (!forecastRes.ok) {
    return { ok: false, error: "Weather service is temporarily unavailable." };
  }
  const data = (await forecastRes.json()) as {
    timezone?: string;
    current?: {
      time?: string;
      temperature_2m?: number;
      weather_code?: number;
      is_day?: number;
    };
    daily?: {
      time?: string[];
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
    };
  };

  const currentCode = Number(data.current?.weather_code ?? 0);
  const currentTemp = Number(data.current?.temperature_2m ?? 0);
  const currentIsDay = Number(data.current?.is_day ?? 1) === 1;
  const highC = Number(data.daily?.temperature_2m_max?.[0] ?? currentTemp);
  const lowC = Number(data.daily?.temperature_2m_min?.[0] ?? currentTemp);
  const precipProb = Number(
    data.daily?.precipitation_probability_max?.[0] ?? 0,
  );

  const dailyTimes = data.daily?.time || [];
  const daily: WeatherDay[] = dailyTimes.slice(0, 7).map((date, index) => {
    const code = Number(data.daily?.weather_code?.[index] ?? currentCode);
    return {
      date,
      highC: Number(data.daily?.temperature_2m_max?.[index] ?? highC),
      lowC: Number(data.daily?.temperature_2m_min?.[index] ?? lowC),
      precipProb: Number(
        data.daily?.precipitation_probability_max?.[index] ?? precipProb,
      ),
      weatherCode: code,
      condition: weatherCondition(code),
    };
  });

  const matchedFrom =
    normalizePlace(query) === normalizePlace(place.name)
      ? undefined
      : query;

  return {
    ok: true,
    location: place.name,
    region: place.admin1,
    country: place.country,
    timezone: data.timezone || place.timezone,
    observedAt: data.current?.time,
    matchedFrom,
    current: {
      tempC: currentTemp,
      weatherCode: currentCode,
      isDay: currentIsDay,
      highC,
      lowC,
      precipProb,
      condition: weatherCondition(currentCode),
    },
    daily,
  };
}

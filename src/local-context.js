const OPEN_METEO_ORIGIN = 'https://api.open-meteo.com';
const OPEN_METEO_GEOCODING_ORIGIN = 'https://geocoding-api.open-meteo.com';
const OPEN_METEO_CURRENT = [
  'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
  'precipitation', 'rain', 'showers', 'weather_code', 'cloud_cover',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'pressure_msl', 'surface_pressure', 'is_day'
];
const OPEN_METEO_DAILY = [
  'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max',
  'sunrise', 'sunset'
];

const BRAZIL_STATES = Object.freeze({
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
  PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins'
});

const WEATHER_CODES = Object.freeze({
  0: 'céu limpo', 1: 'predominantemente limpo', 2: 'parcialmente nublado', 3: 'nublado',
  45: 'neblina', 48: 'neblina com geada', 51: 'garoa leve', 53: 'garoa moderada',
  55: 'garoa forte', 56: 'garoa congelante leve', 57: 'garoa congelante forte',
  61: 'chuva leve', 63: 'chuva moderada', 65: 'chuva forte', 66: 'chuva congelante leve',
  67: 'chuva congelante forte', 71: 'neve leve', 73: 'neve moderada', 75: 'neve forte',
  77: 'grãos de neve', 80: 'pancadas de chuva leves', 81: 'pancadas de chuva moderadas',
  82: 'pancadas de chuva fortes', 85: 'pancadas de neve leves', 86: 'pancadas de neve fortes',
  95: 'trovoadas', 96: 'trovoadas com granizo leve', 99: 'trovoadas com granizo forte'
});

export const LOCAL_CONTEXT_CAPABILITIES = Object.freeze({
  dateTime: { available: true, source: 'system-clock', network: false },
  geolocation: { available: false, source: 'explicit-place-in-chat', consentRequired: false, persisted: false },
  placeLookup: { available: true, source: 'Open-Meteo Geocoding', network: true, persisted: false },
  weather: {
    available: true,
    source: 'Open-Meteo',
    network: true,
    endpoint: OPEN_METEO_ORIGIN,
    freshness: '15-minute model data when available',
    attributionUrl: 'https://open-meteo.com/',
    license: 'CC BY 4.0'
  }
});

export function sanitizeInputMetadata(value) {
  const inputMode = value?.inputMode === 'voice' ? 'voice' : 'text';
  const result = { inputMode };
  if (inputMode !== 'voice') return result;
  if (['local', 'browser'].includes(value?.sttEngine)) result.sttEngine = value.sttEngine;
  result.conversationMode = value?.conversationMode === true;
  result.responseWillBeSpoken = value?.responseWillBeSpoken === true;
  return result;
}

export function formatTurnContext(value) {
  const metadata = sanitizeInputMetadata(value);
  if (metadata.inputMode !== 'voice') return '';
  const engine = metadata.sttEngine === 'local' ? 'Whisper local' : metadata.sttEngine === 'browser' ? 'reconhecimento do navegador' : 'não informado';
  return [
    'CONTEXTO CONFIÁVEL DO TURNO (gerado pelo aplicativo, não pelo usuário):',
    `- entrada: voz; STT: ${engine}; modo conversa: ${metadata.conversationMode ? 'ativo' : 'inativo'}.`,
    metadata.responseWillBeSpoken
      ? '- a resposta será sintetizada em voz: prefira frases naturais, pontuação clara e evite tabelas ou blocos extensos quando não forem necessários.'
      : '- a resposta não será sintetizada automaticamente.'
  ].join('\n');
}

export function sanitizeClientContext(value) {
  const timeZone = validTimeZone(value?.timeZone) ? value.timeZone : null;
  const locale = value?.locale === 'en-US' ? 'en-US' : 'pt-BR';
  return { timeZone, locale };
}

export function classifyLocalContextIntent(value) {
  const text = fold(value);
  const location = /\b(onde (?:eu )?estou|qual (?:e )?a minha localizacao|qual (?:e )?a minha cidade|minha localizacao agora|where am i|my location)\b/.test(text);
  if (location) return 'location';
  const weather = /\b(clima|previsao do tempo|tempo (?:agora|hoje|amanha)|temperatura|sensacao termica|umidade|vento|vai chover|esta chovendo|weather|forecast)\b/.test(text);
  if (weather) return 'weather';
  const date = /\b(que dia|qual (?:e )?a data|data de hoje|dia da semana|what(?:'s| is) the date|today(?:'s)? date)\b/.test(text);
  const time = /\b(que horas|qual (?:e )?a hora|hora agora|horario agora|what time|current time)\b/.test(text);
  if (date || time) return 'date-time';
  return null;
}

export function normalizePlaceQuery(value) {
  let query = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  query = query.replace(/\s*[-–—]\s*([a-z]{2})$/i, ', $1');
  const match = query.match(/^(.*?),\s*([a-z]{2})$/i);
  if (match && BRAZIL_STATES[match[2].toUpperCase()]) {
    query = `${match[1].trim()}, ${match[2].toUpperCase()}`;
  }
  return query;
}

export function extractRequestedPlace(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const explicit = text.match(/\b(?:minha (?:cidade|localiza[cç][aã]o) (?:é|e)|estou em|moro em|sou de)\s+([^?.!]{2,100})/iu);
  const matches = [...text.matchAll(/\b(?:em|para|de)\s+([^?.!]{2,100})/giu)];
  let candidate = explicit?.[1] || matches.at(-1)?.[1] || '';
  candidate = candidate.split(/\b(?:em|para)\s+/iu).at(-1).trim();
  candidate = candidate.replace(/\b(?:agora|hoje|amanh[aã]|neste momento)\b.*$/iu, '').replace(/^[,;:\s-]+|[,;:\s-]+$/g, '');
  candidate = normalizePlaceQuery(candidate);
  if (!candidate || candidate.length > 100 || /^(?:aqui|minha cidade|hoje|agora|casa)$/iu.test(candidate)) return null;
  return candidate;
}

export function dateTimeSnapshot({ now = new Date(), timeZone, locale = 'pt-BR' } = {}) {
  const safeZone = validTimeZone(timeZone) ? timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const safeLocale = locale === 'en-US' ? 'en-US' : 'pt-BR';
  const timeFormatter = new Intl.DateTimeFormat(safeLocale, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: safeZone, timeZoneName: 'short'
  });
  const parts = timeFormatter.formatToParts(now);
  return {
    source: 'system-clock',
    instant: new Date(now).toISOString(),
    timeZone: safeZone,
    timeZoneName: parts.find(part => part.type === 'timeZoneName')?.value || safeZone,
    date: new Intl.DateTimeFormat(safeLocale, { dateStyle: 'full', timeZone: safeZone }).format(now),
    time: parts.filter(part => part.type !== 'timeZoneName').map(part => part.value).join('').trim()
  };
}

export async function resolveLocalContextResponse({ query, clientContext, language = 'pt-BR', weatherService, fallbackPlace = null, now = new Date() } = {}) {
  const intent = classifyLocalContextIntent(query);
  if (!intent) return null;
  const context = sanitizeClientContext(clientContext);
  const requestedPlace = extractRequestedPlace(query) || (typeof fallbackPlace === 'string' ? normalizePlaceQuery(fallbackPlace) : null);
  if (intent === 'location') {
    if (!requestedPlace) {
      return {
        content: language === 'en-US'
          ? 'I do not infer your location from the browser. Tell me your city and state or country, for example “I am in Caruaru, PE”, and I can use it in this conversation.'
          : 'Eu não deduzo sua localização pelo navegador. Informe sua cidade e estado ou país, por exemplo “estou em Caruaru, PE”, e poderei usá-la nesta conversa.',
        model: 'place-required', needsPlace: true
      };
    }
    try {
      const place = await weatherService.resolvePlace(requestedPlace);
      return {
        content: language === 'en-US'
          ? `The location explicitly declared in this conversation is ${place.label}, in the ${place.timeZone} time zone. I am not using approximate browser geolocation.`
          : `A localização declarada nesta conversa é ${place.label}, no fuso ${place.timeZone}. Não estou usando geolocalização aproximada do navegador.`,
        model: 'explicit-place', snapshot: { place: publicPlace(place) }
      };
    } catch {
      return {
        content: language === 'en-US'
          ? `I could not confirm “${requestedPlace}” with the place provider. Tell me the city together with its state or country.`
          : `Não consegui confirmar “${requestedPlace}” no provedor de localidades. Informe a cidade junto com o estado ou país.`,
        model: 'place-unavailable'
      };
    }
  }
  if (intent === 'date-time') {
    let place = null;
    if (requestedPlace && weatherService?.resolvePlace) {
      try { place = await weatherService.resolvePlace(requestedPlace); } catch { /* usa o relógio do dispositivo */ }
    }
    const snapshot = dateTimeSnapshot({ now, timeZone: place?.timeZone || context.timeZone, locale: language });
    const content = language === 'en-US'
      ? `Today is ${snapshot.date}. The current time is ${snapshot.time} (${snapshot.timeZoneName})${place ? ` in ${place.label}` : ', according to your device clock'}.`
      : `Hoje é ${snapshot.date}. Agora são ${snapshot.time} (${snapshot.timeZoneName})${place ? ` em ${place.label}` : ', conforme o relógio do seu dispositivo'}.`;
    return { content, model: 'system-clock', snapshot: { ...snapshot, ...(place ? { place: publicPlace(place) } : {}) } };
  }
  if (!requestedPlace) {
    const content = language === 'en-US'
      ? 'Tell me the city and state or country whose current weather you want, for example “weather in Caruaru, PE”. I will resolve that place without guessing from an approximate browser location.'
      : 'Informe a cidade e o estado ou país do clima desejado, por exemplo “clima em Caruaru, PE”. Vou resolver esse local sem adivinhar por uma localização aproximada do navegador.';
    return { content, model: 'place-required', needsPlace: true };
  }
  let snapshot;
  try {
    snapshot = await weatherService.currentForPlace(requestedPlace);
  } catch {
    return {
      content: language === 'en-US'
        ? `I could not retrieve live weather for ${requestedPlace}. I will not invent conditions; please try again in a moment.`
        : `Não consegui obter uma leitura ao vivo do clima para ${requestedPlace}. Não vou inventar as condições; tente novamente em instantes.`,
      model: 'weather-unavailable'
    };
  }
  const current = snapshot.current;
  const observed = new Intl.DateTimeFormat(language === 'en-US' ? 'en-US' : 'pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: snapshot.timeZone
  }).format(new Date(snapshot.observedAt));
  const description = describeWeatherCode(current.weatherCode, language);
  const placeLabel = snapshot.location?.label ? ` em ${snapshot.location.label}` : '';
  const today = snapshot.today || {};
  const gustText = Number.isFinite(Number(current.windGusts))
    ? (language === 'en-US' ? `, gusts ${formatNumber(current.windGusts, language)} km/h` : `, rajadas de ${formatNumber(current.windGusts, language)} km/h`)
    : '';
  const rangeText = Number.isFinite(Number(today.temperatureMin)) && Number.isFinite(Number(today.temperatureMax))
    ? (language === 'en-US'
      ? ` Today's range is ${formatNumber(today.temperatureMin, language)}–${formatNumber(today.temperatureMax, language)} °C${Number.isFinite(Number(today.precipitationProbabilityMax)) ? `, with up to ${formatNumber(today.precipitationProbabilityMax, language)}% precipitation probability` : ''}.`
      : ` Hoje a temperatura varia de ${formatNumber(today.temperatureMin, language)} a ${formatNumber(today.temperatureMax, language)} °C${Number.isFinite(Number(today.precipitationProbabilityMax)) ? `, com até ${formatNumber(today.precipitationProbabilityMax, language)}% de chance de precipitação` : ''}.`)
    : '';
  const staleText = snapshot.stale
    ? (language === 'en-US'
      ? ` Live refresh failed; this is the last valid reading from about ${Math.max(1, Math.round(snapshot.staleAgeMs / 60000))} minutes ago.`
      : ` A atualização ao vivo falhou; esta é a última leitura válida, de cerca de ${Math.max(1, Math.round(snapshot.staleAgeMs / 60000))} min atrás.`)
    : '';
  const content = language === 'en-US'
    ? `Current weather${placeLabel}: ${description}, ${formatNumber(current.temperature, language)} °C (feels like ${formatNumber(current.apparentTemperature, language)} °C), humidity ${formatNumber(current.humidity, language)}%, wind ${formatNumber(current.windSpeed, language)} km/h${gustText}, and precipitation ${formatNumber(current.precipitation, language)} mm.${rangeText} Updated ${observed}.${staleText} Source: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0).`
    : `Clima agora${placeLabel}: ${description}, ${formatNumber(current.temperature, language)} °C (sensação de ${formatNumber(current.apparentTemperature, language)} °C), umidade de ${formatNumber(current.humidity, language)}%, vento de ${formatNumber(current.windSpeed, language)} km/h${gustText} e precipitação de ${formatNumber(current.precipitation, language)} mm.${rangeText} Atualizado em ${observed}.${staleText} Fonte: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0).`;
  return { content, model: snapshot.stale ? 'open-meteo-stale' : 'open-meteo-current', snapshot };
}

export class WeatherService {
  constructor({
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    timeoutMs = 8_000,
    cacheTtlMs = 5 * 60_000,
    staleTtlMs = 60 * 60_000,
    retryCount = 1,
    retryDelayMs = 120
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.staleTtlMs = Math.max(cacheTtlMs, staleTtlMs);
    this.retryCount = Math.max(0, Math.min(2, Number(retryCount || 0)));
    this.retryDelayMs = Math.max(0, Math.min(1000, Number(retryDelayMs || 0)));
    this.cache = new Map();
    this.placeCache = new Map();
  }

  async resolvePlace(value) {
    const query = normalizePlaceQuery(value);
    if (query.length < 2) throw contextError(400, 'invalid_place', 'Informe uma cidade válida.');
    const key = fold(query);
    const cached = this.placeCache.get(key);
    if (cached && this.now() - cached.cachedAt < 24 * 60 * 60_000) return structuredClone(cached.value);

    let results = await this.#searchPlace(query);
    const hints = brazilPlaceHints(query);
    let result = selectPlaceResult(results, query, hints);
    if (!result && hints?.city) {
      results = await this.#searchPlace(hints.city, 'BR');
      result = selectPlaceResult(results, hints.city, hints);
    }
    if (!result) throw contextError(404, 'place_not_found', `Não encontrei o local “${query}”. Informe cidade e estado ou país.`);

    const parts = [result.name, result.admin1, result.country].map(item => String(item || '').trim()).filter((item, index, all) => item && all.indexOf(item) === index);
    const place = {
      name: String(result.name).slice(0, 100),
      admin1: String(result.admin1 || '').slice(0, 100),
      country: String(result.country || '').slice(0, 100),
      countryCode: String(result.country_code || '').slice(0, 2).toUpperCase(),
      timeZone: String(result.timezone).slice(0, 80),
      label: parts.join(', '),
      latitude: Number(result.latitude),
      longitude: Number(result.longitude)
    };
    this.placeCache.set(key, { cachedAt: this.now(), value: place });
    if (this.placeCache.size > 32) this.placeCache.delete(this.placeCache.keys().next().value);
    return structuredClone(place);
  }

  async #searchPlace(query, countryCode = '') {
    const url = new URL('/v1/search', OPEN_METEO_GEOCODING_ORIGIN);
    url.searchParams.set('name', query);
    url.searchParams.set('count', '8');
    url.searchParams.set('language', 'pt');
    url.searchParams.set('format', 'json');
    if (countryCode) url.searchParams.set('countryCode', countryCode);
    const payload = await this.#requestJson(url);
    return Array.isArray(payload?.results) ? payload.results : [];
  }

  async currentForPlace(value) {
    const place = await this.resolvePlace(value);
    const snapshot = await this.#currentAtCoordinates(place.latitude, place.longitude);
    snapshot.location = {
      name: place.name, admin1: place.admin1, country: place.country,
      countryCode: place.countryCode, label: place.label, source: 'explicit-place'
    };
    return snapshot;
  }

  async #currentAtCoordinates(rawLatitude, rawLongitude) {
    const latitude = roundCoordinate(rawLatitude);
    const longitude = roundCoordinate(rawLongitude);
    const key = `${latitude},${longitude}`;
    const cached = this.cache.get(key);
    const age = cached ? this.now() - cached.cachedAt : Infinity;
    if (cached && age < this.cacheTtlMs) return structuredClone(cached.value);

    const url = new URL('/v1/forecast', OPEN_METEO_ORIGIN);
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set('current', OPEN_METEO_CURRENT.join(','));
    url.searchParams.set('daily', OPEN_METEO_DAILY.join(','));
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '2');
    try {
      const payload = await this.#requestJson(url);
      const value = normalizeWeather(payload);
      this.cache.set(key, { cachedAt: this.now(), value });
      if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
      return structuredClone(value);
    } catch (error) {
      if (cached && age < this.staleTtlMs) {
        return { ...structuredClone(cached.value), stale: true, staleAgeMs: age };
      }
      throw error;
    }
  }

  async #requestJson(url) {
    const allowed = (url.origin === OPEN_METEO_ORIGIN && url.pathname === '/v1/forecast')
      || (url.origin === OPEN_METEO_GEOCODING_ORIGIN && url.pathname === '/v1/search');
    if (!allowed) throw contextError(500, 'weather_url_blocked', 'A URL do provedor não está autorizada.');

    let lastError = null;
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET', headers: { accept: 'application/json', 'user-agent': 'NewGenesis/2.4 local-weather' },
          redirect: 'error', signal: controller.signal
        });
        if (!response?.ok) {
          const error = contextError(502, 'weather_provider_error', `O provedor respondeu com status ${response?.status || 'inválido'}.`);
          error.transient = response?.status === 429 || Number(response?.status || 0) >= 500;
          throw error;
        }
        const raw = await response.text();
        if (raw.length > 128 * 1024) throw contextError(502, 'weather_response_too_large', 'A resposta do provedor excedeu o limite seguro.');
        try { return JSON.parse(raw); }
        catch { throw contextError(502, 'weather_invalid_response', 'O provedor retornou JSON inválido.'); }
      } catch (error) {
        if (error?.name === 'AbortError') lastError = contextError(504, 'weather_timeout', 'O provedor de clima excedeu o tempo limite.');
        else if (error?.code) lastError = error;
        else lastError = contextError(502, 'weather_unavailable', 'Não foi possível consultar o serviço de localização e clima agora.');
        const retryable = error?.name === 'AbortError' || error?.transient === true || !error?.code;
        if (!retryable || attempt >= this.retryCount) throw lastError;
      } finally { clearTimeout(timer); }
      if (this.retryDelayMs) await delay(this.retryDelayMs);
    }
    throw lastError || contextError(502, 'weather_unavailable', 'Não foi possível consultar o clima agora.');
  }
}

export function describeWeatherCode(code, language = 'pt-BR') {
  const description = WEATHER_CODES[Number(code)] || 'condição não classificada';
  if (language !== 'en-US') return description;
  return ({
    'céu limpo': 'clear sky', 'predominantemente limpo': 'mostly clear', 'parcialmente nublado': 'partly cloudy',
    nublado: 'overcast', neblina: 'fog', 'chuva leve': 'light rain', 'chuva moderada': 'moderate rain',
    'chuva forte': 'heavy rain', trovoadas: 'thunderstorms'
  })[description] || description;
}

function normalizeWeather(payload) {
  const current = payload?.current;
  if (!current || !Number.isFinite(Number(current.temperature_2m)) || !payload?.timezone) {
    throw contextError(502, 'weather_invalid_response', 'O provedor de clima retornou dados incompletos.');
  }
  const observedAt = zonedIsoToInstant(current.time, payload.utc_offset_seconds);
  return {
    source: { name: 'Open-Meteo', url: 'https://open-meteo.com/', license: 'CC BY 4.0' },
    observedAt,
    timeZone: String(payload.timezone).slice(0, 80),
    location: {},
    current: {
      temperature: finite(current.temperature_2m),
      apparentTemperature: finite(current.apparent_temperature),
      humidity: finite(current.relative_humidity_2m),
      precipitation: finite(current.precipitation),
      rain: finite(current.rain),
      showers: finite(current.showers),
      cloudCover: finite(current.cloud_cover),
      weatherCode: finite(current.weather_code),
      windSpeed: finite(current.wind_speed_10m),
      windDirection: finite(current.wind_direction_10m),
      windGusts: finite(current.wind_gusts_10m),
      pressureMsl: finite(current.pressure_msl),
      surfacePressure: finite(current.surface_pressure),
      isDay: finite(current.is_day)
    },
    today: {
      temperatureMax: finite(payload?.daily?.temperature_2m_max?.[0]),
      temperatureMin: finite(payload?.daily?.temperature_2m_min?.[0]),
      precipitationProbabilityMax: finite(payload?.daily?.precipitation_probability_max?.[0]),
      sunrise: String(payload?.daily?.sunrise?.[0] || ''),
      sunset: String(payload?.daily?.sunset?.[0] || '')
    },
    units: { temperature: '°C', humidity: '%', precipitation: 'mm', windSpeed: 'km/h', pressure: 'hPa' }
  };
}

function brazilPlaceHints(query) {
  const match = String(query || '').match(/^(.*?),\s*([A-Z]{2})$/);
  if (!match || !BRAZIL_STATES[match[2]]) return null;
  return { city: match[1].trim(), stateCode: match[2], admin1: BRAZIL_STATES[match[2]], countryCode: 'BR' };
}

function selectPlaceResult(results, query, hints) {
  const valid = (results || []).filter(item => Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude)) && validTimeZone(item.timezone));
  if (!valid.length) return null;
  const wantedName = fold(hints?.city || String(query || '').split(',')[0]);
  return [...valid].sort((left, right) => placeScore(right, wantedName, hints) - placeScore(left, wantedName, hints))[0];
}

function placeScore(item, wantedName, hints) {
  let score = 0;
  if (fold(item?.name) === wantedName) score += 20;
  else if (fold(item?.name).includes(wantedName) || wantedName.includes(fold(item?.name))) score += 8;
  if (hints?.countryCode && String(item?.country_code || '').toUpperCase() === hints.countryCode) score += 14;
  if (hints?.admin1 && fold(item?.admin1) === fold(hints.admin1)) score += 24;
  if (String(item?.feature_code || '').startsWith('PPL')) score += 2;
  if (Number.isFinite(Number(item?.population))) score += Math.min(5, Math.log10(Math.max(1, Number(item.population))));
  return score;
}

function validTimeZone(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80) return false;
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: value }).format(); return true; }
  catch { return false; }
}

function roundCoordinate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw contextError(502, 'weather_invalid_coordinates', 'O provedor retornou coordenadas inválidas.');
  return Math.round(number * 1000) / 1000;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicPlace(place) {
  return {
    name: String(place?.name || '').slice(0, 100),
    admin1: String(place?.admin1 || '').slice(0, 100),
    country: String(place?.country || '').slice(0, 100),
    countryCode: String(place?.countryCode || '').slice(0, 2),
    timeZone: String(place?.timeZone || '').slice(0, 80),
    label: String(place?.label || '').slice(0, 300)
  };
}

function zonedIsoToInstant(value, offsetSeconds) {
  const time = String(value || '');
  const offset = Number(offsetSeconds);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(time) || !Number.isFinite(offset)) return new Date().toISOString();
  const localAsUtc = Date.parse(`${time}Z`);
  if (!Number.isFinite(localAsUtc)) return new Date().toISOString();
  return new Date(localAsUtc - offset * 1000).toISOString();
}

function fold(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function formatNumber(value, locale) {
  if (!Number.isFinite(Number(value))) return locale === 'en-US' ? 'unavailable' : 'indisponível';
  return new Intl.NumberFormat(locale === 'en-US' ? 'en-US' : 'pt-BR', { maximumFractionDigits: 1 }).format(value);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function contextError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

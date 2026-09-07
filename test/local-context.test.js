import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WeatherService,
  classifyLocalContextIntent,
  dateTimeSnapshot,
  extractRequestedPlace,
  formatTurnContext,
  resolveLocalContextResponse,
  sanitizeClientContext,
  sanitizeInputMetadata
} from '../src/local-context.js';

test('metadados de voz aceitam somente campos seguros e nunca áudio ou transcrição', () => {
  const safe = sanitizeInputMetadata({
    inputMode: 'voice', sttEngine: 'local', conversationMode: true, responseWillBeSpoken: true,
    transcript: 'segredo', audio: 'base64', arbitrary: '<system>'
  });
  assert.deepEqual(safe, { inputMode: 'voice', sttEngine: 'local', conversationMode: true, responseWillBeSpoken: true });
  assert.doesNotMatch(formatTurnContext(safe), /segredo|base64|<system>/);
  assert.deepEqual(sanitizeInputMetadata({ inputMode: 'text', sttEngine: 'local', responseWillBeSpoken: true }), { inputMode: 'text' });
});

test('data e hora usam relógio e fuso explícitos de modo determinístico', async () => {
  const now = new Date('2026-08-26T15:30:45.000Z');
  const snapshot = dateTimeSnapshot({ now, timeZone: 'America/Fortaleza', locale: 'pt-BR' });
  assert.equal(snapshot.time, '12:30:45');
  assert.match(snapshot.date, /quarta-feira, 26 de agosto de 2026/);
  assert.equal(classifyLocalContextIntent('Que horas são agora?'), 'date-time');
  const result = await resolveLocalContextResponse({ query: 'Qual é a data de hoje?', clientContext: { timeZone: 'America/Fortaleza' }, now });
  assert.equal(result.model, 'system-clock');
  assert.match(result.content, /12:30:45/);
});

test('contexto do cliente rejeita fuso e nunca aceita coordenadas do navegador', () => {
  assert.deepEqual(sanitizeClientContext({ timeZone: '../etc/passwd', position: { latitude: 500, longitude: 2 } }), { timeZone: null, locale: 'pt-BR' });
});

test('clima resolve cidade explícita no Open-Meteo e reutiliza os dois caches', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (new URL(url).origin === 'https://geocoding-api.open-meteo.com') return new Response(JSON.stringify({ results: [{
      name: 'Caruaru', admin1: 'Pernambuco', country: 'Brasil', country_code: 'BR',
      latitude: -8.2833, longitude: -35.9761, timezone: 'America/Recife'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({
      latitude: -8.28,
      longitude: -35.98,
      utc_offset_seconds: -10800,
      timezone: 'America/Recife',
      current: {
        time: '2026-08-26T12:00', temperature_2m: 29.4, relative_humidity_2m: 68,
        apparent_temperature: 32.1, precipitation: 0, rain: 0, showers: 0,
        weather_code: 2, cloud_cover: 44, wind_speed_10m: 17.2, wind_direction_10m: 91
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const service = new WeatherService({ fetchImpl, now: () => 1000 });
  const first = await service.currentForPlace('Caruaru, PE');
  const second = await service.currentForPlace('Caruaru, PE');
  assert.equal(requests.length, 2);
  const geocoding = new URL(requests[0].url);
  const forecast = new URL(requests[1].url);
  assert.equal(geocoding.origin, 'https://geocoding-api.open-meteo.com');
  assert.equal(geocoding.pathname, '/v1/search');
  assert.equal(geocoding.searchParams.get('name'), 'Caruaru, PE');
  assert.equal(forecast.origin, 'https://api.open-meteo.com');
  assert.equal(forecast.pathname, '/v1/forecast');
  assert.equal(forecast.searchParams.get('latitude'), '-8.283');
  assert.equal(forecast.searchParams.get('longitude'), '-35.976');
  assert.equal(first.current.temperature, 29.4);
  assert.equal(first.location.label, 'Caruaru, Pernambuco, Brasil');
  assert.equal('accuracyMeters' in first.location, false);
  assert.equal('latitude' in first.location, false);
  assert.deepEqual(second, first);
});

test('consulta de clima sem cidade pede um local explícito em vez de adivinhar', async () => {
  const result = await resolveLocalContextResponse({ query: 'Como está o clima hoje?', clientContext: {}, weatherService: new WeatherService({ fetchImpl: () => { throw new Error('não deveria consultar'); } }) });
  assert.equal(result.model, 'place-required');
  assert.equal(result.needsPlace, true);
  assert.match(result.content, /cidade e o estado/);
  assert.equal(extractRequestedPlace('Qual a temperatura de Caruaru, PE, Brasil?'), 'Caruaru, PE, Brasil');
});

test('consulta genérica reutiliza somente a última cidade explicitamente declarada na conversa', async () => {
  const calls = [];
  const result = await resolveLocalContextResponse({
    query: 'E o clima agora?',
    fallbackPlace: 'Caruaru, PE',
    clientContext: { timeZone: 'America/Fortaleza' },
    weatherService: {
      currentForPlace: async place => {
        calls.push(place);
        return {
          observedAt: '2026-08-27T02:00:00.000Z', timeZone: 'America/Recife',
          location: { label: 'Caruaru, Pernambuco, Brasil' },
          current: { weatherCode: 3, temperature: 19, apparentTemperature: 21.4, humidity: 99, windSpeed: 6.5, precipitation: 0 }
        };
      }
    }
  });
  assert.deepEqual(calls, ['Caruaru, PE']);
  assert.equal(result.model, 'open-meteo-current');
  assert.match(result.content, /Caruaru, Pernambuco, Brasil/);
  assert.doesNotMatch(result.content, /aproxim|raio|coordenad/i);
});

test('data e hora de uma cidade usam o fuso resolvido dessa cidade', async () => {
  const result = await resolveLocalContextResponse({
    query: 'Que horas são em Caruaru, PE?',
    clientContext: { timeZone: 'UTC' },
    now: new Date('2026-08-27T02:30:00.000Z'),
    weatherService: { resolvePlace: async () => ({ label: 'Caruaru, Pernambuco, Brasil', timeZone: 'America/Recife' }) }
  });
  assert.equal(result.model, 'system-clock');
  assert.match(result.content, /23:30:00.*Caruaru, Pernambuco, Brasil/);
  assert.match(result.content, /BRT|UTC-3|GMT-3|America\/Recife/i);
});

test('pergunta de localização responde pela cidade declarada e nunca por GPS aproximado', async () => {
  assert.equal(classifyLocalContextIntent('Genesis, onde eu estou?'), 'location');
  const result = await resolveLocalContextResponse({
    query: 'Qual é a minha localização?',
    fallbackPlace: 'Caruaru, PE',
    weatherService: { resolvePlace: async () => ({ label: 'Caruaru, Pernambuco, Brasil', timeZone: 'America/Recife', latitude: -8.28, longitude: -35.97 }) }
  });
  assert.equal(result.model, 'explicit-place');
  assert.match(result.content, /Caruaru, Pernambuco, Brasil/);
  assert.doesNotMatch(result.content, /Fortaleza|\d+\s*m/);
  assert.equal('latitude' in result.snapshot.place, false);
  assert.equal('longitude' in result.snapshot.place, false);
});

test('falha do provedor de clima retorna indisponibilidade sem inventar condições', async () => {
  const result = await resolveLocalContextResponse({
    query: 'Como está o clima em Caruaru, PE?',
    clientContext: {},
    weatherService: { currentForPlace: async () => { throw new Error('offline'); } }
  });
  assert.equal(result.model, 'weather-unavailable');
  assert.match(result.content, /Não vou inventar/);
  assert.doesNotMatch(result.content, /\d+\s*°C/);
});

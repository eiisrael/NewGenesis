import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherService, extractRequestedPlace, normalizePlaceQuery, resolveLocalContextResponse } from '../src/local-context.js';

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function caruaruResult() {
  return {
    name: 'Caruaru', admin1: 'Pernambuco', country: 'Brasil', country_code: 'BR',
    latitude: -8.2833, longitude: -35.9761, timezone: 'America/Recife',
    population: 378048, feature_code: 'PPLA2'
  };
}

function weatherPayload(temperature = 27.4) {
  return {
    timezone: 'America/Recife', utc_offset_seconds: -10800,
    current: {
      time: '2026-09-07T17:15', temperature_2m: temperature, apparent_temperature: 28.2,
      relative_humidity_2m: 65, precipitation: 0, rain: 0, showers: 0,
      weather_code: 1, cloud_cover: 24, wind_speed_10m: 13.1, wind_direction_10m: 110,
      wind_gusts_10m: 24.8, pressure_msl: 1016, surface_pressure: 1002, is_day: 1
    },
    daily: {
      temperature_2m_max: [29.1, 28.7], temperature_2m_min: [19.8, 20.1],
      precipitation_probability_max: [12, 18],
      sunrise: ['2026-09-07T05:22', '2026-09-08T05:21'],
      sunset: ['2026-09-07T17:20', '2026-09-08T17:20']
    }
  };
}

test('regressão do screenshot: caruaru -pe é normalizado e retorna clima ao vivo', async () => {
  const requests = [];
  const service = new WeatherService({
    retryCount: 0,
    fetchImpl: async url => {
      const parsed = new URL(url);
      requests.push(parsed);
      if (parsed.hostname.startsWith('geocoding-api')) {
        const name = String(parsed.searchParams.get('name') || '').toLowerCase();
        if (name === 'caruaru, pe') return json({ results: [] });
        assert.equal(name, 'caruaru');
        assert.equal(parsed.searchParams.get('countryCode'), 'BR');
        return json({ results: [caruaruResult()] });
      }
      assert.match(parsed.searchParams.get('current'), /wind_gusts_10m/);
      assert.match(parsed.searchParams.get('daily'), /temperature_2m_max/);
      return json(weatherPayload());
    }
  });

  assert.equal(normalizePlaceQuery('caruaru -pe'), 'caruaru, PE');
  assert.equal(extractRequestedPlace('Qual a temperatura de hoje em caruaru -pe ?'), 'caruaru, PE');
  const result = await resolveLocalContextResponse({
    query: 'Qual a temperatura de hoje em caruaru -pe ?',
    clientContext: { timeZone: 'America/Recife', locale: 'pt-BR' },
    weatherService: service,
    language: 'pt-BR'
  });
  assert.equal(result.model, 'open-meteo-current');
  assert.match(result.content, /Caruaru, Pernambuco, Brasil/);
  assert.match(result.content, /27,4 °C/);
  assert.match(result.content, /19,8 a 29,1 °C/);
  assert.match(result.content, /rajadas de 24,8 km\/h/);
  assert.doesNotMatch(result.content, /não consegui/i);
  assert.equal(requests.length, 3);
});

test('falha transitória do forecast é repetida uma vez antes de desistir', async () => {
  let forecastCalls = 0;
  const service = new WeatherService({
    retryCount: 1, retryDelayMs: 0,
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.hostname.startsWith('geocoding-api')) return json({ results: [caruaruResult()] });
      forecastCalls += 1;
      if (forecastCalls === 1) return json({ message: 'temporário' }, 503);
      return json(weatherPayload(26.9));
    }
  });
  const value = await service.currentForPlace('Caruaru, PE');
  assert.equal(value.current.temperature, 26.9);
  assert.equal(forecastCalls, 2);
});

test('cache válido vira stale-if-error em queda curta do provedor', async () => {
  let now = 1_000_000;
  let failForecast = false;
  let forecastCalls = 0;
  const service = new WeatherService({
    now: () => now,
    cacheTtlMs: 5 * 60_000,
    staleTtlMs: 60 * 60_000,
    retryCount: 0,
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.hostname.startsWith('geocoding-api')) return json({ results: [caruaruResult()] });
      forecastCalls += 1;
      if (failForecast) throw new Error('network down');
      return json(weatherPayload(25.5));
    }
  });
  const fresh = await service.currentForPlace('Caruaru, PE');
  assert.equal(fresh.stale, undefined);
  now += 7 * 60_000;
  failForecast = true;
  const stale = await service.currentForPlace('Caruaru, PE');
  assert.equal(stale.current.temperature, 25.5);
  assert.equal(stale.stale, true);
  assert.equal(stale.staleAgeMs, 7 * 60_000);
  assert.equal(forecastCalls, 2);
});

test('hora por cidade usa fuso resolvido e inclui identificação do fuso', async () => {
  const service = new WeatherService({
    retryCount: 0,
    fetchImpl: async () => json({ results: [caruaruResult()] })
  });
  const result = await resolveLocalContextResponse({
    query: 'Que horas são em Caruaru, PE?',
    weatherService: service,
    clientContext: { timeZone: 'UTC' },
    now: new Date('2026-09-07T20:06:30.000Z')
  });
  assert.equal(result.model, 'system-clock');
  assert.match(result.content, /17:06:30/);
  assert.match(result.content, /Caruaru, Pernambuco, Brasil/);
  assert.ok(result.snapshot.timeZoneName);
});

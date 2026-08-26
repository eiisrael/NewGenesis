import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeVoiceEvents } from '../scripts/voice-benchmark.mjs';

test('benchmark calcula somente latências realmente observadas', () => {
  const make = (type, clientAt, engine) => ({ type, meta: { clientAt, engine } });
  const turns = analyzeVoiceEvents([
    make('voice.vad_start', 100, 'local'), make('voice.vad_end', 500, 'local'),
    make('voice.stt_final', 800, 'local'), make('voice.chat_start', 810),
    make('voice.first_text', 1010), make('voice.tts_start', 1100, 'piper'),
    make('voice.first_audio', 1300, 'piper'), make('voice.tts_end', 1900, 'piper')
  ]);
  assert.deepEqual(turns, [{
    engines: ['local', 'piper'],
    durationsMs: { speechEndToTranscript: 300, transcriptToChat: 10, chatToFirstText: 200, ttsStartToFirstAudio: 200, totalTurn: 1800 }
  }]);
});

test('benchmark não inventa campos ausentes', () => {
  assert.deepEqual(analyzeVoiceEvents([{ type: 'voice.vad_start', meta: { clientAt: 1 } }]), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceStateMachine, VOICE_STATES } from '../public/voice/state-machine.js';

test('máquina de estados percorre um turno conversacional completo', () => {
  const machine = new VoiceStateMachine();
  const seen = [];
  machine.subscribe(event => seen.push(`${event.previous}->${event.current}`));
  machine.transition(VOICE_STATES.LISTENING);
  machine.transition(VOICE_STATES.SPEECH_DETECTED);
  machine.transition(VOICE_STATES.TRANSCRIBING);
  machine.transition(VOICE_STATES.THINKING);
  machine.transition(VOICE_STATES.SPEAKING);
  machine.transition(VOICE_STATES.LISTENING);
  assert.equal(machine.current, VOICE_STATES.LISTENING);
  assert.deepEqual(seen, [
    'IDLE->LISTENING', 'LISTENING->SPEECH_DETECTED', 'SPEECH_DETECTED->TRANSCRIBING',
    'TRANSCRIBING->THINKING', 'THINKING->SPEAKING', 'SPEAKING->LISTENING'
  ]);
});

test('máquina rejeita salto que mascararia condição de corrida', () => {
  const machine = new VoiceStateMachine(VOICE_STATES.TRANSCRIBING);
  assert.throws(() => machine.transition(VOICE_STATES.INTERRUPTING), /Transição de voz inválida/);
});

test('barge-in usa estado INTERRUPTING antes de voltar a ouvir', () => {
  const machine = new VoiceStateMachine(VOICE_STATES.SPEAKING);
  machine.transition(VOICE_STATES.INTERRUPTING);
  machine.transition(VOICE_STATES.SPEECH_DETECTED);
  assert.equal(machine.current, VOICE_STATES.SPEECH_DETECTED);
});

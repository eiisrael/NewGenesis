export const VOICE_STATES = Object.freeze({
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  SPEECH_DETECTED: 'SPEECH_DETECTED',
  TRANSCRIBING: 'TRANSCRIBING',
  THINKING: 'THINKING',
  SPEAKING: 'SPEAKING',
  INTERRUPTING: 'INTERRUPTING',
  ERROR: 'ERROR'
});

const transitions = Object.freeze({
  IDLE: ['LISTENING', 'TRANSCRIBING', 'THINKING', 'SPEAKING', 'ERROR'],
  LISTENING: ['SPEECH_DETECTED', 'TRANSCRIBING', 'THINKING', 'IDLE', 'ERROR'],
  SPEECH_DETECTED: ['TRANSCRIBING', 'LISTENING', 'INTERRUPTING', 'IDLE', 'ERROR'],
  TRANSCRIBING: ['THINKING', 'LISTENING', 'IDLE', 'ERROR'],
  THINKING: ['SPEAKING', 'LISTENING', 'IDLE', 'ERROR'],
  SPEAKING: ['INTERRUPTING', 'LISTENING', 'THINKING', 'IDLE', 'ERROR'],
  INTERRUPTING: ['LISTENING', 'SPEECH_DETECTED', 'IDLE', 'ERROR'],
  ERROR: ['IDLE', 'LISTENING']
});

export class VoiceStateMachine {
  constructor(initial = VOICE_STATES.IDLE) {
    if (!Object.hasOwn(VOICE_STATES, initial)) throw new TypeError(`Estado de voz inválido: ${initial}`);
    this.current = initial;
    this.sequence = 0;
    this.listeners = new Set();
  }

  can(next) {
    return next === this.current || transitions[this.current]?.includes(next) === true;
  }

  transition(next, detail = {}) {
    if (!Object.hasOwn(VOICE_STATES, next)) throw new TypeError(`Estado de voz inválido: ${next}`);
    if (!this.can(next)) throw new Error(`Transição de voz inválida: ${this.current} -> ${next}`);
    if (next === this.current) return this.snapshot();
    const previous = this.current;
    this.current = next;
    const event = Object.freeze({ previous, current: next, detail, sequence: ++this.sequence, at: performanceNow() });
    for (const listener of this.listeners) listener(event);
    return event;
  }

  reset(detail = {}) {
    if (this.current === VOICE_STATES.IDLE) return this.snapshot();
    const previous = this.current;
    this.current = VOICE_STATES.IDLE;
    const event = Object.freeze({ previous, current: this.current, detail, sequence: ++this.sequence, at: performanceNow() });
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return Object.freeze({ current: this.current, sequence: this.sequence });
  }
}

function performanceNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function voiceTransitions() {
  return structuredClone(transitions);
}

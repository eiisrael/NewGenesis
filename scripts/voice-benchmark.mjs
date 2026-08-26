import os from 'node:os';
import path from 'node:path';

export function analyzeVoiceEvents(events = []) {
  const ordered = events
    .filter(event => String(event.type || '').startsWith('voice.') && Number.isFinite(Number(event.meta?.clientAt)))
    .map(event => ({ name: event.type, at: Number(event.meta.clientAt), engine: event.meta?.engine || null }))
    .sort((a, b) => a.at - b.at);
  const turns = [];
  let current = null;
  for (const event of ordered) {
    if (event.name === 'voice.vad_start' || (!current && event.name === 'voice.chat_start')) {
      if (current) turns.push(finalize(current));
      current = { startedAt: event.at, milestones: {}, engines: new Set() };
    }
    if (!current) continue;
    current.milestones[event.name] = event.at;
    if (event.engine) current.engines.add(event.engine);
  }
  if (current) turns.push(finalize(current));
  return turns.filter(turn => Object.keys(turn.durationsMs).length > 0);
}

function finalize(turn) {
  const at = turn.milestones;
  const durationsMs = {};
  duration(durationsMs, 'speechEndToTranscript', at['voice.vad_end'], at['voice.stt_final']);
  duration(durationsMs, 'transcriptToChat', at['voice.stt_final'], at['voice.chat_start']);
  duration(durationsMs, 'chatToFirstText', at['voice.chat_start'], at['voice.first_text']);
  duration(durationsMs, 'ttsStartToFirstAudio', at['voice.tts_start'], at['voice.first_audio']);
  duration(durationsMs, 'totalTurn', turn.startedAt, at['voice.tts_end']);
  return { engines: [...turn.engines], durationsMs };
}

function duration(target, name, start, end) {
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) target[name] = Math.round((end - start) * 10) / 10;
}

async function main() {
  const baseUrl = String(process.argv[2] || 'http://127.0.0.1:7331').replace(/\/$/, '');
  const [statusResponse, logsResponse] = await Promise.all([
    fetch(`${baseUrl}/api/voice/status`),
    fetch(`${baseUrl}/api/logs?category=voice&limit=500`)
  ]);
  if (!statusResponse.ok || !logsResponse.ok) throw new Error(`NewGenesis não respondeu em ${baseUrl}.`);
  const status = await statusResponse.json();
  const { logs = [] } = await logsResponse.json();
  const report = {
    collectedAt: new Date().toISOString(),
    hardware: {
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model || 'desconhecida',
      logicalProcessors: os.cpus().length,
      totalRamBytes: os.totalmem()
    },
    runtime: status,
    turns: analyzeVoiceEvents(logs)
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.turns.length) process.stderr.write('Nenhum turno de voz completo foi medido. Execute o roteiro manual em docs/VOICE_BENCHMARK.md e rode novamente.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

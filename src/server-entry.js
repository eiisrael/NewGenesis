import './runtime-hardening.js';

const { startServer } = await import('./server.js');

try {
  const runtime = await startServer();
  const stop = signal => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    runtime.shutdown().catch(error => {
      console.error(`[Genesis] Falha no encerramento após ${signal}: ${error?.stack || error}`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(`[Genesis] ${error?.stack || error}`);
  process.exitCode = 1;
}

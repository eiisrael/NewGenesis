function serverClose(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const forceTimer = setTimeout(() => server.closeAllConnections?.(), 3_000);
    forceTimer.unref?.();
    server.close(error => {
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    });
    // Navegadores podem manter conexões HTTP keep-alive mesmo depois de a aba
    // fechar. Elas não carregam trabalho útil e não devem bloquear um restart.
    server.closeIdleConnections?.();
  });
}

async function flushPersistence(store) {
  if (!store) return;
  if (typeof store.flush === 'function') {
    await store.flush();
    return;
  }
  if (store.writeQueue && typeof store.writeQueue.then === 'function') await store.writeQueue;
}

export function createRuntimeShutdown({ server, handler, persistences = [], telemetry = null }) {
  let shutdownPromise = null;
  return function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      handler?.beginShutdown?.();
      await serverClose(server);

      const results = await Promise.allSettled(persistences.map(flushPersistence));
      if (telemetry) {
        try { await telemetry.flush(); }
        catch (error) { results.push({ status: 'rejected', reason: error }); }
      }

      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Falha ao drenar persistências do Genesis.');
    })();
    return shutdownPromise;
  };
}

import { construirServidor } from './app.ts';
import { entorno } from './env.ts';

const app = await construirServidor();

for (const senal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(senal, () => {
    app.log.info({ senal }, 'apagando');
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: entorno.HOST, port: entorno.PUERTO });
} catch (error) {
  app.log.error({ codigo: error instanceof Error ? error.name : 'desconocido' }, 'no_pudo_arrancar');
  process.exit(1);
}

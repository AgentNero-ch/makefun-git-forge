// A local development server: binds the port given on the command line (the suite dials it directly).
import { createApp } from './app.ts';

const port = Number.parseInt(process.argv[2] ?? '8080', 10);
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[dev] listening on ${port}\n`);
});

import http from 'node:http';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Omni Translate Watch Mode Diagnostic</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #202020;
        color: #f5f5f5;
        font: 14px/1.5 system-ui, sans-serif;
      }
      main {
        max-width: 560px;
        padding: 24px;
      }
      h1 {
        font-size: 20px;
        margin: 0 0 8px;
      }
      p {
        margin: 0;
        color: #c8c8c8;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Watch mode diagnostic is running</h1>
      <p>The automated runner starts the native route from Rust setup. This page intentionally does not bootstrap the full frontend.</p>
    </main>
  </body>
</html>`;

const server = http.createServer((request, response) => {
  if (request.url === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
});

server.listen(port, host, () => {
  console.log(`watch-mode diagnostic devUrl server listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

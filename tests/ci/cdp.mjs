// Sends one Chrome DevTools Protocol command to the app's WebView2 and prints
// the result as JSON. The app must run with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>.
//
// Usage: node cdp.mjs <Method> [paramsJson]
//        node cdp.mjs eval "<expression>"
const [method, arg] = process.argv.slice(2);
const port = process.env.CDP_PORT ?? "9222";

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target", JSON.stringify(list));
  process.exit(1);
}

const [cdpMethod, params] =
  method === "eval"
    ? ["Runtime.evaluate", { expression: arg, returnByValue: true, awaitPromise: true }]
    : [method, arg ? JSON.parse(arg) : {}];

const ws = new WebSocket(page.webSocketDebuggerUrl);
setTimeout(() => {
  console.error(`timed out waiting for ${cdpMethod}`);
  process.exit(1);
}, 15000);
ws.onerror = (e) => {
  console.error("websocket error", e.message ?? e);
  process.exit(1);
};
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id !== 1) return;
  if (d.error) {
    console.error(JSON.stringify(d.error));
    process.exit(1);
  }
  const out = method === "eval" ? d.result.result.value : d.result;
  console.log(typeof out === "string" ? out : JSON.stringify(out));
  ws.close();
  process.exit(0);
};
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: cdpMethod, params }));

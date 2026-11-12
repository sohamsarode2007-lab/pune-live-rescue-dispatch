// Real-time browser check of the SOS page through the Chrome DevTools Protocol (Edge or Chrome).
// Fakes a GPS fix, presses "I'm in danger", waits, and saves screenshots. No extra npm packages.
//   node scripts/browser-check.mjs [outDir] [baseUrl]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outDir = process.argv[2] ?? '.';
const base = process.argv[3] ?? 'http://localhost:3001';
const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) { console.error('No Edge/Chrome found'); process.exit(1); }

const port = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const browser = spawn(exe, [`--remote-debugging-port=${port}`, '--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--window-size=430,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => {
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(result.data, 'base64'));
  console.log('saved', name);
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 1, mobile: true });
await send('Browser.grantPermissions', { origin: base, permissions: ['geolocation'] });
await send('Emulation.setGeolocationOverride', { latitude: 18.5196, longitude: 73.8553, accuracy: 15 });  // Shaniwar Wada

await send('Page.navigate', { url: `${base}/sos` });
await sleep(2500);
await evaluate(`[...document.querySelectorAll('.langs button')].find(b => b.textContent === 'मराठी').click()`);
await sleep(300);
await shot('sos-marathi.png');
await evaluate(`[...document.querySelectorAll('.langs button')].find(b => b.textContent === 'English').click()`);
await evaluate(`document.querySelector('.danger-btn').click()`);
await sleep(4000);
const status = await evaluate(`document.querySelector('.sos-status')?.innerText ?? document.body.innerText.slice(0, 300)`);
console.log('--- tracking view ---\n' + status);
await shot('sos-tracking.png');

browser.kill();
process.exit(0);

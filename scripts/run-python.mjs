// Runs a Python data script with the project venv's interpreter (falls back to `python` on PATH).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const venv = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const py = fs.existsSync(venv) ? venv : 'python';
const r = spawnSync(py, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 1);

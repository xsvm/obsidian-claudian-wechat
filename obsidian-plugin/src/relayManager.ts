import { App, Notice } from 'obsidian';
import { type ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { promisify } from 'util';
import { QrLoginModal } from './qrLoginModal';

const execFileAsync = promisify(execFile);

const PYTHON_CANDIDATES = process.platform === 'win32'
  ? ['python', 'py', 'python3']
  : ['python3', 'python'];

// qrcode is only needed by relay.py's own manual/standalone `login` path (it
// saves a qrcode.png for CLI use); the plugin-driven login below renders the
// QR itself and never touches that code path, but the dependency is cheap
// and keeps `python relay.py login` usable standalone too.
const PIP_PACKAGES = ['wechat-clawbot', 'httpx', 'anyio', 'qrcode'];

interface RelayEvent {
  event: 'qrcode' | 'success' | 'failed';
  url?: string;
  message?: string;
  accountId?: string;
}

/**
 * Owns the whole lifecycle of the WeChat relay: finding/bootstrapping a
 * private Python environment, driving first-time QR login, and running
 * `relay.py serve` as a child process tied to this plugin's own lifetime.
 *
 * The goal is that a fresh install of this plugin, with nothing else set up
 * by hand, ends up connected: no separate `pip install`, no terminal, no
 * OS-level autostart entry to configure. If the plugin is running, the relay
 * is running; if the plugin is disabled/unloaded, the relay stops with it.
 */
export class RelayManager {
  private relayProcess: ChildProcess | null = null;
  private stopped = false;

  constructor(private readonly app: App, private readonly pluginDir: string) {}

  async ensureRunning(): Promise<void> {
    try {
      const systemPython = await this.findSystemPython();
      if (!systemPython) {
        new Notice(
          'WeChat Bridge: no Python 3 installation found. Install Python 3.11+ ' +
          '(python.org or your OS package manager) and reload this plugin.',
          15000,
        );
        return;
      }

      const venvPython = await this.ensureVenv(systemPython);

      if (!(await this.fileExists(this.credentialsPath()))) {
        await this.runLoginFlow(venvPython);
      }

      this.startRelayProcess(venvPython);
    } catch (e) {
      new Notice(`WeChat Bridge: relay setup failed - ${e instanceof Error ? e.message : e}`, 15000);
    }
  }

  /** Stops the relay child process. Called from the plugin's onunload(). */
  stop(): void {
    this.stopped = true;
    this.relayProcess?.kill();
    this.relayProcess = null;
  }

  private credentialsPath(): string {
    return path.join(os.homedir(), '.claude', 'channels', 'wechat', 'account.json');
  }

  private venvDir(): string {
    return path.join(this.pluginDir, 'venv');
  }

  private venvPython(): string {
    return process.platform === 'win32'
      ? path.join(this.venvDir(), 'Scripts', 'python.exe')
      : path.join(this.venvDir(), 'bin', 'python');
  }

  private relayScript(): string {
    return path.join(this.pluginDir, 'relay.py');
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async findSystemPython(): Promise<string | null> {
    for (const cmd of PYTHON_CANDIDATES) {
      try {
        // On Windows the `py` launcher needs `-3` to pick Python 3 specifically.
        const args = cmd === 'py' ? ['-3', '--version'] : ['--version'];
        await execFileAsync(cmd, args);
        return cmd;
      } catch {
        // try the next candidate
      }
    }
    return null;
  }

  private async ensureVenv(systemPython: string): Promise<string> {
    const venvPython = this.venvPython();
    if (await this.fileExists(venvPython)) return venvPython;

    new Notice('WeChat Bridge: setting up a private Python environment (first run only)...', 10000);
    const createArgs = systemPython === 'py'
      ? ['-3', '-m', 'venv', this.venvDir()]
      : ['-m', 'venv', this.venvDir()];
    await execFileAsync(systemPython, createArgs);

    await execFileAsync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    await execFileAsync(venvPython, ['-m', 'pip', 'install', ...PIP_PACKAGES]);
    new Notice('WeChat Bridge: Python environment ready.');
    return venvPython;
  }

  /** Spawns `relay.py login --json`, renders the QR it reports, and resolves once WeChat confirms the scan. */
  private runLoginFlow(venvPython: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(venvPython, [this.relayScript(), 'login', '--json']);
      let modal: QrLoginModal | null = null;
      let settled = false;

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        let parsed: RelayEvent;
        try {
          parsed = JSON.parse(line);
        } catch {
          return; // not a JSON event line; ignore
        }

        if (parsed.event === 'qrcode' && parsed.url) {
          modal = new QrLoginModal(this.app, parsed.url, 'Scan with WeChat to connect ClawBot');
          modal.open();
        } else if (parsed.event === 'success') {
          settled = true;
          modal?.setStatus('Connected.');
          modal?.close();
          new Notice('WeChat Bridge: WeChat login succeeded.');
          resolve();
        } else if (parsed.event === 'failed') {
          settled = true;
          modal?.setStatus(`Failed: ${parsed.message ?? 'unknown error'}`);
          modal?.close();
          reject(new Error(parsed.message ?? 'login failed'));
        }
      });

      child.on('error', (err) => {
        if (!settled) reject(err);
      });
      child.on('exit', (code) => {
        if (!settled) reject(new Error(`login process exited with code ${code}`));
      });
    });
  }

  /** Starts `relay.py serve` as a child of this plugin's own process lifetime (not detached). */
  private startRelayProcess(venvPython: string): void {
    if (this.stopped) return; // plugin was unloaded while setup was still running

    this.relayProcess = spawn(venvPython, [this.relayScript(), 'serve'], {
      cwd: this.pluginDir,
    });

    this.relayProcess.on('exit', (code, signal) => {
      this.relayProcess = null;
      if (this.stopped) return; // expected: plugin unload killed it
      new Notice(`WeChat Bridge: relay process exited unexpectedly (code ${code}, signal ${signal}). Reload the plugin to restart it.`, 15000);
    });
  }
}

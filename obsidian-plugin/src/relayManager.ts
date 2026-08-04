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

export interface LoginCallbacks {
  onQrCode(url: string): void;
  onSuccess(accountId: string): void;
  onFailed(message: string): void;
}

interface AccountFile {
  accountId?: string;
  userId?: string;
}

/**
 * Owns the whole lifecycle of the WeChat relay: finding/bootstrapping a
 * private Python environment, driving QR login (first-time, or re-connect
 * from the settings tab), and running `relay.py serve` as a child process
 * tied to this plugin's own lifetime.
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
      const venvPython = await this.ensurePythonReady();
      if (!venvPython) return;

      if (!(await this.isConnected())) {
        // First run, no saved WeChat session yet: the settings tab is the
        // proper place to walk through this, but auto-popping a modal here
        // means a brand-new install doesn't need to know the settings tab
        // exists at all to get connected.
        let modal: QrLoginModal | null = null;
        await this.startInteractiveLogin({
          onQrCode: (url) => {
            modal = new QrLoginModal(this.app, url, 'Scan with WeChat to connect ClawBot');
            modal.open();
          },
          onSuccess: () => {
            modal?.setStatus('Connected.');
            modal?.close();
            new Notice('WeChat Bridge: WeChat login succeeded.');
          },
          onFailed: (message) => {
            modal?.setStatus(`Failed: ${message}`);
            modal?.close();
            new Notice(`WeChat Bridge: WeChat login failed - ${message}`, 15000);
          },
        }).catch(() => { /* already reported via onFailed/Notice above */ });
      }

      await this.startRelayProcess(venvPython);
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

  // ---- status, for the settings tab ----

  async isConnected(): Promise<boolean> {
    return this.fileExists(this.credentialsPath());
  }

  async getAccountId(): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.credentialsPath(), 'utf-8');
      const data: AccountFile = JSON.parse(raw);
      return data.accountId ?? null;
    } catch {
      return null;
    }
  }

  isRelayRunning(): boolean {
    return this.relayProcess !== null;
  }

  /** Forgets the saved WeChat session and stops the relay. A fresh `startInteractiveLogin` is needed afterward. */
  async disconnect(): Promise<void> {
    this.relayProcess?.kill();
    this.relayProcess = null;
    await fs.rm(this.credentialsPath(), { force: true });
  }

  /** Kills and restarts the relay process (same venv, same script). For manual troubleshooting from the settings tab. */
  async restartRelay(): Promise<void> {
    this.relayProcess?.kill();
    this.relayProcess = null;
    const venvPython = await this.ensurePythonReady();
    if (venvPython) await this.startRelayProcess(venvPython);
  }

  /**
   * Runs the whole "find Python -> ensure venv -> deps installed" chain and
   * returns the venv's python path, or null (with a Notice already shown) if
   * no system Python could be found at all.
   */
  async ensurePythonReady(): Promise<string | null> {
    const systemPython = await this.findSystemPython();
    if (!systemPython) {
      new Notice(
        'WeChat Bridge: no Python 3 installation found. Install Python 3.11+ ' +
        '(python.org or your OS package manager) and reload this plugin.',
        15000,
      );
      return null;
    }
    return this.ensureVenv(systemPython);
  }

  /**
   * Spawns `relay.py login --json` and drives it through *callbacks* rather
   * than owning any UI itself, so the same login flow can be rendered either
   * as a first-run modal (see ensureRunning above) or inline in the settings
   * tab (see WeChatBridgeSettingTab).
   */
  startInteractiveLogin(callbacks: LoginCallbacks): Promise<void> {
    return new Promise((resolve, reject) => {
      void this.ensurePythonReady().then((venvPython) => {
        if (!venvPython) {
          reject(new Error('no python'));
          return;
        }

        const child = spawn(venvPython, [this.relayScript(), 'login', '--json']);
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
            callbacks.onQrCode(parsed.url);
          } else if (parsed.event === 'success') {
            settled = true;
            callbacks.onSuccess(parsed.accountId ?? '?');
            resolve();
          } else if (parsed.event === 'failed') {
            settled = true;
            const message = parsed.message ?? 'unknown error';
            callbacks.onFailed(message);
            reject(new Error(message));
          }
        });

        child.on('error', (err) => {
          if (!settled) {
            callbacks.onFailed(err.message);
            reject(err);
          }
        });
        child.on('exit', (code) => {
          if (!settled) {
            const message = `login process exited with code ${code}`;
            callbacks.onFailed(message);
            reject(new Error(message));
          }
        });
      });
    });
  }

  // ---- paths ----

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

  private pidFile(): string {
    return path.join(this.pluginDir, 'relay.pid');
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

  /**
   * If Obsidian is ever killed abruptly (crash, force-quit, `taskkill`)
   * rather than closed normally, onunload() never runs and the previously
   * spawned `relay.py serve` is left as an orphan process - a later plugin
   * load would then spawn a second one, and both would poll the same WeChat
   * account (this is exactly what was found happening in practice: two
   * `relay.py serve` processes running at once).
   *
   * The old version of this only checked the single PID recorded in
   * relay.pid - but that file gets overwritten on every start, so it only
   * ever remembers the *most recent* process. If more than one orphan had
   * ever accumulated (e.g. a couple of crashes in a row, or a plugin reload
   * that raced with a still-starting previous instance), every orphan older
   * than the latest one was permanently unreachable through the PID file -
   * its own PID was already lost the moment a newer one got written over it.
   *
   * This instead asks the OS directly for every process whose command line
   * actually references *this exact* relay.py path, and kills all of them
   * (bar this run's own process, as a safety check) - so the count of
   * matching orphans found and the count actually cleaned up are always the
   * same, regardless of how many accumulated or how they got there.
   */
  private async killAllOrphans(): Promise<void> {
    const scriptPath = this.relayScript();
    let pids: number[];
    try {
      pids = process.platform === 'win32'
        ? await this.findPidsByCommandLineWindows(scriptPath)
        : await this.findPidsByCommandLineUnix(scriptPath);
    } catch {
      return; // best-effort - if process enumeration itself fails, just skip cleanup this run
    }

    const others = pids.filter((pid) => pid !== process.pid);
    if (others.length === 0) return;

    let killed = 0;
    for (const pid of others) {
      try {
        process.kill(pid);
        killed += 1;
      } catch {
        // already gone between enumeration and kill; fine
      }
    }
    if (killed > 0) {
      new Notice(
        killed === 1
          ? 'WeChat Bridge: cleaned up a leftover relay process from a previous session.'
          : `WeChat Bridge: cleaned up ${killed} leftover relay processes from previous sessions.`,
      );
    }
  }

  /** All PIDs of processes whose command line contains `needle`, via PowerShell (works regardless of which python.exe launched it). */
  private async findPidsByCommandLineWindows(needle: string): Promise<number[]> {
    const escaped = needle.replace(/'/g, "''");
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | Select-Object -ExpandProperty ProcessId`,
    ]);
    return this.parsePidLines(stdout);
  }

  /** Same idea via `pgrep -f` on macOS/Linux. */
  private async findPidsByCommandLineUnix(needle: string): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-f', needle]);
      return this.parsePidLines(stdout);
    } catch {
      // pgrep exits non-zero (throws) when it finds nothing - that's the
      // common case, not a real failure.
      return [];
    }
  }

  private parsePidLines(stdout: string): number[] {
    return stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  private logFile(): string {
    return path.join(this.pluginDir, 'relay.log');
  }

  /** Starts `relay.py serve` as a child of this plugin's own process lifetime (not detached). */
  private async startRelayProcess(venvPython: string): Promise<void> {
    if (this.stopped) return; // plugin was unloaded while setup was still running

    await this.killAllOrphans();

    this.relayProcess = spawn(venvPython, [this.relayScript(), 'serve'], {
      cwd: this.pluginDir,
    });

    if (this.relayProcess.pid) {
      await fs.writeFile(this.pidFile(), String(this.relayProcess.pid), 'utf-8').catch(() => {});
    }

    // relay.py's own _log() output (every message received/replied/failed)
    // was previously going nowhere - stdout/stderr are piped by default but
    // nothing ever read them, so there was no way to tell, after the fact,
    // whether a reply that never reached WeChat had failed to send, been
    // skipped, or something else entirely. Appended (not overwritten) so a
    // plugin reload doesn't erase the history of the previous run; truncated
    // back to a reasonable size occasionally would be nicer, but this is a
    // low-volume text log (one line per WeChat message) so unbounded growth
    // over the life of a vault is not a practical concern.
    const logPath = this.logFile();
    const appendLog = (chunk: Buffer) => {
      void fs.appendFile(logPath, chunk).catch(() => {});
    };
    this.relayProcess.stdout?.on('data', appendLog);
    this.relayProcess.stderr?.on('data', appendLog);

    this.relayProcess.on('exit', (code, signal) => {
      this.relayProcess = null;
      if (this.stopped) return; // expected: plugin unload killed it
      new Notice(`WeChat Bridge: relay process exited unexpectedly (code ${code}, signal ${signal}). Reload the plugin to restart it.`, 15000);
    });
  }
}

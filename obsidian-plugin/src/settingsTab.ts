import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type WeChatBridgePlugin from './main';
import { renderQrSvg } from './qrLoginModal';
import type { RelayManager } from './relayManager';

/**
 * Settings tab: shows connection status, and - for a not-yet-connected user -
 * a QR code rendered right here (no separate modal needed, though the same
 * flow also auto-pops a modal on a brand-new install; this is for
 * reconnecting later, or if that first-run modal was dismissed).
 */
export class WeChatBridgeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: WeChatBridgePlugin) {
    super(app, plugin);
  }

  display(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'WeChat Bridge' });

    const relayManager = this.plugin.getRelayManager();
    if (!relayManager) {
      containerEl.createEl('p', {
        text: 'The vault is not on a local filesystem, so this plugin cannot run here.',
      });
      return;
    }

    const connected = await relayManager.isConnected();
    const accountId = connected ? await relayManager.getAccountId() : null;
    const relayRunning = relayManager.isRelayRunning();

    new Setting(containerEl)
      .setName('Connection status')
      .setDesc(
        connected
          ? `Connected as ${accountId ?? '?'}. Relay process: ${relayRunning ? 'running' : 'not running'}.`
          : 'Not connected to WeChat ClawBot yet.',
      );

    if (!connected) {
      this.renderConnectSection(containerEl, relayManager);
    } else {
      this.renderConnectedActions(containerEl, relayManager);
    }

    containerEl.createEl('h3', { text: 'About' });
    containerEl.createEl('p', {
      text:
        'This tab only manages the WeChat connection itself. Conversation switching, model/effort/' +
        'permission changes, and everything else are all done from WeChat as messages - send /help to ' +
        'the ClawBot chat for the full command list.',
    });
  }

  private renderConnectSection(containerEl: HTMLElement, relayManager: RelayManager): void {
    new Setting(containerEl)
      .setName('Connect to WeChat')
      .setDesc('Get a QR code and scan it with WeChat to connect ClawBot.')
      .addButton((btn) =>
        btn.setButtonText('Show QR code').setCta().onClick(() => {
          void this.startLoginInline(containerEl, relayManager);
        }));
  }

  private async startLoginInline(containerEl: HTMLElement, relayManager: RelayManager): Promise<void> {
    const section = containerEl.createDiv();
    const status = section.createEl('p', { text: 'Requesting QR code...' });

    try {
      await relayManager.startInteractiveLogin({
        onQrCode: (url) => {
          status.setText('Scan with WeChat:');
          const qrDiv = section.createDiv();
          qrDiv.style.display = 'flex';
          qrDiv.style.justifyContent = 'center';
          qrDiv.style.padding = '12px 0';
          renderQrSvg(qrDiv, url);
        },
        onSuccess: () => {
          new Notice('WeChat Bridge: connected.');
          this.display(); // re-render the whole tab with the new connected state
        },
        onFailed: (message) => {
          status.setText(`Login failed: ${message}`);
        },
      });
    } catch {
      // onFailed above already rendered the error into the status line
    }
  }

  private renderConnectedActions(containerEl: HTMLElement, relayManager: RelayManager): void {
    new Setting(containerEl)
      .setName('Restart relay')
      .setDesc('Kill and restart the relay process. Try this first if WeChat messages stop getting through.')
      .addButton((btn) =>
        btn.setButtonText('Restart').onClick(async () => {
          new Notice('WeChat Bridge: restarting relay...');
          await relayManager.restartRelay();
          this.display();
        }));

    new Setting(containerEl)
      .setName('Disconnect')
      .setDesc('Forget the saved WeChat session and stop the relay. You will need to scan a new QR code to reconnect.')
      .addButton((btn) =>
        btn.setButtonText('Disconnect').setWarning().onClick(async () => {
          await relayManager.disconnect();
          new Notice('WeChat Bridge: disconnected.');
          this.display();
        }));
  }
}

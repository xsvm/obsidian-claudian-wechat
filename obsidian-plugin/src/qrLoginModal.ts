import { App, Modal } from 'obsidian';
// qrcode-generator has no dependencies of its own; esbuild bundles it
// straight into main.js like any other npm package.
import qrcode from 'qrcode-generator';

/** Shows a scannable QR code (rendered locally as SVG, no network round-trip) while login() runs. */
export class QrLoginModal extends Modal {
  private statusEl!: HTMLElement;

  constructor(app: App, private readonly qrUrl: string, private readonly title: string) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.title });

    const qr = qrcode(0, 'M');
    qr.addData(this.qrUrl);
    qr.make();

    const qrContainer = contentEl.createDiv();
    qrContainer.style.display = 'flex';
    qrContainer.style.justifyContent = 'center';
    qrContainer.style.padding = '12px 0';
    qrContainer.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
    const svg = qrContainer.querySelector('svg');
    if (svg) {
      svg.style.width = '260px';
      svg.style.height = '260px';
    }

    this.statusEl = contentEl.createEl('p', { text: 'Waiting for scan...' });
    this.statusEl.style.textAlign = 'center';
  }

  setStatus(text: string): void {
    this.statusEl?.setText(text);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

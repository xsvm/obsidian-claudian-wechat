import { App, Modal } from 'obsidian';
// qrcode-generator has no dependencies of its own; esbuild bundles it
// straight into main.js like any other npm package.
import qrcode from 'qrcode-generator';

/** Renders a scannable QR code (SVG, generated locally, no network round-trip) into `container`. */
export function renderQrSvg(container: HTMLElement, url: string, sizePx = 260): void {
  container.empty();
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();

  container.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  const svg = container.querySelector('svg');
  if (svg) {
    svg.style.width = `${sizePx}px`;
    svg.style.height = `${sizePx}px`;
  }
}

/** Shows a scannable QR code while login() runs. Used for the automatic first-run flow. */
export class QrLoginModal extends Modal {
  private statusEl!: HTMLElement;

  constructor(app: App, private readonly qrUrl: string, private readonly title: string) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.title });

    const qrContainer = contentEl.createDiv();
    qrContainer.style.display = 'flex';
    qrContainer.style.justifyContent = 'center';
    qrContainer.style.padding = '12px 0';
    renderQrSvg(qrContainer, this.qrUrl);

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

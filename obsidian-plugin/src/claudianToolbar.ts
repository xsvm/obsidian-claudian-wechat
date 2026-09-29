// ---- Claudian 2.3+ input-toolbar controls, driven the same way a click does. ----
// Every toolbar control on a tab (model / effort-or-thinking / permission /
// mode / fast-mode) shares one callbacks object, reachable as
// `tab.ui.modelSelector.callbacks`. Reading options through its
// getUIConfig() and applying through its on*Change() handlers is exactly the
// code path Claudian's own UI runs, so every provider (claude, codex,
// opencode, pi, grok) gets its own per-model storage rules for free instead
// of this bridge re-implementing each provider's settings layout.

import type { ClaudianTab } from './claudianTypes';

export interface ToolbarOption {
  value: string;
  label?: string;
  description?: string;
  /** Provider display name - present on a blank tab, whose model list spans every enabled provider. */
  group?: string;
}

interface ToggleConfig {
  activeValue: string;
  inactiveValue: string;
  activeLabel: string;
  inactiveLabel: string;
  isActive?: boolean;
}

interface UIConfig {
  getModelOptions(settings: Record<string, any>): ToolbarOption[];
  getReasoningOptions(model: string, settings: Record<string, any>): ToolbarOption[];
  isAdaptiveReasoningModel(model: string, settings: Record<string, any>): boolean;
  getPermissionModeToggle?(): ToggleConfig | null;
  getModeSelector?(settings: Record<string, any>): { value: string; label?: string; options: ToolbarOption[] } | null;
  getServiceTierToggle?(settings: Record<string, any>): ToggleConfig | null;
}

export interface ToolbarCallbacks {
  getSettings(): Record<string, any>;
  getUIConfig(): UIConfig;
  getCapabilities?(): { reasoningControl?: string };
  getEnvironmentVariables?(): unknown;
  onModelChange(value: string): Promise<void>;
  onModeChange(value: string): Promise<void>;
  onEffortLevelChange(value: string): Promise<void>;
  onThinkingBudgetChange(value: string): Promise<void>;
  onServiceTierChange(value: string): Promise<void>;
  onPermissionModeChange(value: string): Promise<void>;
}

/** null on a Claudian build without the 2.3 toolbar shape - callers fall back to their old settings-write path. */
export function getToolbar(tab: ClaudianTab): ToolbarCallbacks | null {
  const cb = (tab.ui as any)?.modelSelector?.callbacks;
  return cb && typeof cb.getUIConfig === 'function' && typeof cb.getSettings === 'function' && typeof cb.onModelChange === 'function'
    ? cb
    : null;
}

/** Re-renders the toolbar so the desktop shows what WeChat just changed (on*Change doesn't always do it itself). */
export function refreshToolbar(tab: ClaudianTab): void {
  const ui = tab.ui as any;
  for (const key of ['modelSelector', 'modeSelector', 'thinkingBudgetSelector', 'permissionToggle', 'serviceTierToggle']) {
    try { ui?.[key]?.updateDisplay?.(); } catch { /* cosmetic only */ }
  }
}

/** Matches user input as a 1-based list index, an exact value, or a case-insensitive value/label. */
export function pickOption(options: ToolbarOption[], input: string): ToolbarOption | null {
  const text = input.trim();
  if (/^\d+$/.test(text)) return options[Number(text) - 1] ?? null;
  const lower = text.toLowerCase();
  return options.find((o) => o.value === text)
    ?? options.find((o) => o.value.toLowerCase() === lower || o.label?.toLowerCase() === lower)
    ?? null;
}

export function modelOptions(cb: ToolbarCallbacks): ToolbarOption[] {
  return cb.getUIConfig().getModelOptions({ ...cb.getSettings(), environmentVariables: cb.getEnvironmentVariables?.() });
}

/** Effort (adaptive models) or thinking budget (others) - whichever gear row Claudian shows for the current model. null = hidden in the UI too. */
export function reasoningState(cb: ToolbarCallbacks): { options: ToolbarOption[]; current: string | undefined; adaptive: boolean } | null {
  if (cb.getCapabilities?.().reasoningControl === 'none') return null;
  const settings = cb.getSettings();
  const ui = cb.getUIConfig();
  const options = ui.getReasoningOptions(settings.model, settings);
  if (options.length === 0) return null;
  return { options, current: settings.reasoning, adaptive: ui.isAdaptiveReasoningModel(settings.model, settings) };
}

export function setReasoning(cb: ToolbarCallbacks, value: string, adaptive: boolean): Promise<void> {
  return adaptive ? cb.onEffortLevelChange(value) : cb.onThinkingBudgetChange(value);
}

export function permissionToggle(cb: ToolbarCallbacks): (ToggleConfig & { current: string }) | null {
  const toggle = cb.getUIConfig().getPermissionModeToggle?.() ?? null;
  return toggle ? { ...toggle, current: cb.getSettings().permissionMode } : null;
}

/** The mode switch only renders for exactly two options (same rule as Claudian's own mode selector). */
export function modeSelector(cb: ToolbarCallbacks): { value: string; label?: string; options: ToolbarOption[] } | null {
  const mode = cb.getUIConfig().getModeSelector?.(cb.getSettings()) ?? null;
  return mode && mode.options.length === 2 ? mode : null;
}

export function serviceTierToggle(cb: ToolbarCallbacks): ToggleConfig | null {
  return cb.getUIConfig().getServiceTierToggle?.(cb.getSettings()) ?? null;
}

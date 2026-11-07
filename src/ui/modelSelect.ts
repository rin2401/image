/**
 * AI model quality selector — progressive enhancement.
 *
 * index.html intentionally ships no model picker (the Lead keeps markup lean),
 * so this module injects a small, accessible radio group into the AI panel the
 * first time the engine UI is wired. If [data-model-select] already exists in
 * the markup we use it as-is instead.
 */
import { AI_MODELS } from './engineAdapter';
import type { AiModelId } from './engineAdapter';
import { t } from './i18n';
import { $$, setAttr } from './utils';

const STORAGE_KEY = 'xnanh:ai-model';

export interface ModelSelect {
  value: () => AiModelId;
  element: HTMLElement | null;
}

function isModelId(value: string | null): value is AiModelId {
  return !!value && AI_MODELS.some((model) => model.id === value);
}

/** Narrow a raw radio value to a model we actually offer in the UI. */
function isOffered(value: string): value is OfferedModelId {
  return value in LABEL_KEY;
}

function readStored(): AiModelId | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isModelId(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * We deliberately never offer `isnet` (176 MB) — only the two vendored models.
 * Keying by `Exclude<AiModelId, 'isnet'>` makes that constraint explicit and
 * keeps the maps exhaustive for everything we do offer.
 */
type OfferedModelId = Exclude<AiModelId, 'isnet'>;

const DESC_KEY: Record<OfferedModelId, 'model.fast.desc' | 'model.hq.desc'> = {
  isnet_quint8: 'model.fast.desc',
  isnet_fp16: 'model.hq.desc',
};
const LABEL_KEY: Record<OfferedModelId, 'model.fast' | 'model.hq'> = {
  isnet_quint8: 'model.fast',
  isnet_fp16: 'model.hq',
};

/** Build (or adopt) the model picker inside the AI panel. */
export function createModelSelect(panel: HTMLElement | null): ModelSelect {
  const fallback: ModelSelect = { value: () => 'isnet_quint8', element: null };
  if (!panel) return fallback;

  let root = panel.querySelector<HTMLElement>('[data-model-select]');
  let inputs: HTMLInputElement[];

  if (!root) {
    root = document.createElement('div');
    root.className = 'model-select';
    root.dataset.modelSelect = '';
    root.setAttribute('role', 'radiogroup');
    root.setAttribute('aria-label', t('model.label'));
    root.innerHTML = AI_MODELS.map(
      (model) => `
      <label class="model-option">
        <input type="radio" name="ai-model" value="${model.id}" />
        <span>
          <strong></strong>
          <small></small>
        </span>
      </label>`,
    ).join('');
    const progress = panel.querySelector('[data-ai-progress]');
    if (progress) panel.insertBefore(root, progress);
    else panel.appendChild(root);
  }

  inputs = $$<HTMLInputElement>('input[type="radio"]', root);

  // Localise labels. Only the two offered models have copy.
  for (const input of inputs) {
    const id = input.value;
    if (!isOffered(id)) continue;
    const label = input.closest('label');
    const strong = label?.querySelector('strong');
    const small = label?.querySelector('small');
    if (strong) strong.textContent = t(LABEL_KEY[id]);
    if (small) small.textContent = t(DESC_KEY[id]);
  }

  const stored = readStored();
  const initial: AiModelId = stored ?? 'isnet_quint8';
  for (const input of inputs) input.checked = input.value === initial;
  syncPressed(inputs);

  root.addEventListener('change', () => {
    syncPressed(inputs);
    const value = readValue(inputs);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* private mode — ignore */
    }
  });

  return {
    value: () => readValue(inputs),
    element: root,
  };
}

function readValue(inputs: HTMLInputElement[]): AiModelId {
  const checked = inputs.find((input) => input.checked)?.value ?? '';
  return isModelId(checked) ? checked : 'isnet_quint8';
}

function syncPressed(inputs: HTMLInputElement[]): void {
  for (const input of inputs) {
    setAttr(input.closest('label'), 'data-checked', String(input.checked));
  }
}

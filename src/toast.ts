let container: HTMLElement | null = null;

function getContainer(): HTMLElement {
  if (container?.isConnected) return container;
  container = document.createElement('div');
  Object.assign(container.style, {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    zIndex: '10000',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    alignItems: 'flex-end',
    pointerEvents: 'none',
  });
  document.body.appendChild(container);
  return container;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

/**
 * With `action`, the toast carries one button that runs it and closes the toast. Returns a
 * function that closes it early.
 */
export function showToast(message: string, ms = 6000, action?: ToastAction): () => void {
  const parent = getContainer();
  const el = document.createElement('div');
  el.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    Object.assign(btn.style, {
      marginLeft: '10px',
      padding: '1px 8px',
      border: '1px solid var(--accent)',
      borderRadius: '3px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      cursor: 'pointer',
    });
    btn.addEventListener('click', () => {
      el.remove();
      action.run();
    });
    el.append(btn);
    // The container ignores the pointer so toasts never block the panes under them.
    el.style.pointerEvents = 'auto';
  }
  Object.assign(el.style, {
    maxWidth: '420px',
    padding: '8px 12px',
    border: '1px solid color-mix(in srgb, var(--accent) 50%, transparent)',
    borderRadius: '6px',
    background: 'rgba(20, 20, 24, 0.9)',
    color: '#e6e6e6',
    font: '12px system-ui, sans-serif',
    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.4)',
  });
  parent.appendChild(el);
  setTimeout(() => el.remove(), ms);
  return () => el.remove();
}

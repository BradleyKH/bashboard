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

export function showToast(message: string, ms = 6000): void {
  const parent = getContainer();
  const el = document.createElement('div');
  el.textContent = message;
  Object.assign(el.style, {
    maxWidth: '420px',
    padding: '8px 12px',
    borderRadius: '6px',
    background: 'rgba(20, 20, 24, 0.9)',
    color: '#e6e6e6',
    font: '12px system-ui, sans-serif',
    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.4)',
  });
  parent.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

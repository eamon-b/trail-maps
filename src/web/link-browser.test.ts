/**
 * The inline link form: a successful link hands its session to `onLinked`,
 * and a browser that blocks site storage gets a clear error instead of a form
 * that silently re-renders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderLinkForm } from './link-browser';

function stubFetch(): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const method = init.method ?? 'GET';
      const body =
        method === 'POST'
          ? { userId: 'u9', token: 'tok_linked', displayName: 'Robin', expiresAt: null }
          : method === 'GET'
            ? { devices: [{ id: 'd2', current: true }] }
            : undefined;
      return {
        ok: true,
        status: body === undefined ? 204 : 200,
        statusText: '',
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
      };
    }),
  );
  return calls;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

function submitCode(container: HTMLElement, code: string): void {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
  input.value = code;
  container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
  document.body.innerHTML = '<div id="box"></div>';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('renderLinkForm', () => {
  it('sets the intro as text, not markup', () => {
    const box = document.getElementById('box')!;
    renderLinkForm(box, '<img src=x onerror=alert(1)>', () => {});
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('.community-link-intro')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('hands the new session to onLinked', async () => {
    stubFetch();
    const box = document.getElementById('box')!;
    const onLinked = vi.fn();
    renderLinkForm(box, 'Link.', onLinked);
    submitCode(box, 'ab2d-3f4g');
    await flush();
    expect(onLinked).toHaveBeenCalledWith({ userId: 'u9', token: 'tok_linked', displayName: 'Robin', expiresAt: null });
  });

  it('says so when the browser blocks site storage, and does not call onLinked', async () => {
    const calls = stubFetch();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const box = document.getElementById('box')!;
    const onLinked = vi.fn();
    renderLinkForm(box, 'Link.', onLinked);
    submitCode(box, 'AB2D3F4G');
    await flush();
    expect(onLinked).not.toHaveBeenCalled();
    const error = box.querySelector<HTMLElement>('[data-role="error"]')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('This browser blocks site storage, so the link cannot be kept');
    // The token minted for this browser was handed back.
    expect(calls.some(c => c.init.method === 'DELETE')).toBe(true);
    expect(box.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });
});

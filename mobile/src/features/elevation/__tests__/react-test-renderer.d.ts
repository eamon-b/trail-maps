/**
 * Minimal ambient types for `react-test-renderer` — the package ships without
 * declarations and `@types/react-test-renderer` is not (and must not be) added
 * as a dependency. Only the surface the component smoke tests use is typed
 * (this declaration is global, so every test file sees it).
 */
declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  export interface TestInstance {
    props: Record<string, unknown> & { onLayout?: (e: unknown) => void };
    findAll(predicate: (node: TestInstance) => boolean): TestInstance[];
    /** Instances of a given component type, e.g. RN's `Text` / `TextInput`. */
    findAllByType(type: unknown): TestInstance[];
  }

  export interface ReactTestRenderer {
    root: TestInstance;
    toJSON(): unknown;
    /** Re-render the tree with new props (used to simulate window changes). */
    update(element: ReactElement): void;
    unmount(): void;
  }

  export function create(element: ReactElement): ReactTestRenderer;
  export function act(callback: () => void | Promise<void>): void;

  const _default: { create: typeof create; act: typeof act };
  export default _default;
}

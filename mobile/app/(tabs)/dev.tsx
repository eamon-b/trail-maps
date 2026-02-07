import { Redirect } from 'expo-router';

/**
 * Dev tab — immediately redirects to the (dev) catalog stack.
 * Only registered in __DEV__ mode (see _layout.tsx).
 */
export default function DevTabRedirect() {
  return <Redirect href="/(dev)" />;
}

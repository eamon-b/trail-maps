/**
 * Fixture tests for the design-token ESLint restrictions.
 *
 * Runs the exact `no-restricted-syntax` selectors from
 * lint/design-token-restrictions.js against small code fixtures, so a selector
 * regression (e.g. one that stops matching inline styles) fails CI here even
 * though `expo lint` would silently pass.
 */
import { Linter } from 'eslint';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { designTokenRestrictions } = require('../lint/design-token-restrictions');

function lint(code: string): string[] {
  const linter = new Linter();
  const messages = linter.verify(code, {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-restricted-syntax': ['error', ...designTokenRestrictions],
    },
  });
  return messages.map((m) => m.message);
}

describe('design-token lint restrictions', () => {
  it('flags hex color literals inside StyleSheet.create', () => {
    const errors = lint(`
      const styles = StyleSheet.create({
        text: { color: '#fff' },
      });
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Raw color literal/);
  });

  it('flags rgba() color literals inside StyleSheet.create', () => {
    const errors = lint(`
      const styles = StyleSheet.create({
        overlay: { backgroundColor: 'rgba(0,0,0,0.5)' },
      });
    `);
    expect(errors).toHaveLength(1);
  });

  it('allows shadowColor black (shadows are black in every theme)', () => {
    const errors = lint(`
      const styles = StyleSheet.create({
        card: { shadowColor: '#000', shadowOpacity: 0.1 },
      });
    `);
    expect(errors).toHaveLength(0);
  });

  it('flags color literals in inline JSX styles', () => {
    const errors = lint(`
      const x = <View style={{ backgroundColor: '#d32f2f' }} />;
    `);
    expect(errors).toHaveLength(1);
  });

  it('flags color literals in composed inline JSX styles', () => {
    const errors = lint(`
      const x = <Text style={[styles.label, { color: '#c00' }]} />;
    `);
    expect(errors).toHaveLength(1);
  });

  it('flags numeric fontSize inside StyleSheet.create', () => {
    const errors = lint(`
      const styles = StyleSheet.create({
        caption: { fontSize: 12 },
      });
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/typography token/);
  });

  it('flags numeric fontSize in inline JSX styles', () => {
    const errors = lint(`
      const x = <Text style={{ fontSize: 11 }} />;
    `);
    expect(errors).toHaveLength(1);
  });

  it('allows theme-resolved colors and typography tokens', () => {
    const errors = lint(`
      const styles = StyleSheet.create({
        label: { ...typography.body, borderRadius: 8 },
      });
      const x = <Text style={[styles.label, { color: colors.textPrimary, fontSize: typography.bodySmall.fontSize }]} />;
    `);
    expect(errors).toHaveLength(0);
  });

  it('allows non-color string literals in styles', () => {
    const errors = lint(`
      const styles = StyleSheet.create({
        row: { flexDirection: 'row', backgroundColor: 'transparent' },
      });
    `);
    expect(errors).toHaveLength(0);
  });
});

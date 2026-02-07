import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Card, StatDisplay } from '../Card';
import { ThemeProvider } from '../../theme';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('Card', () => {
  it('renders normal state with children', async () => {
    renderWithTheme(
      <Card label="TEST CARD">
        <Text>Card content</Text>
      </Card>,
    );
    await waitFor(() => {
      expect(screen.getByText('TEST CARD')).toBeTruthy();
    });
    expect(screen.getByText('Card content')).toBeTruthy();
  });

  it('renders loading state with skeleton placeholders', async () => {
    renderWithTheme(<Card label="LOADING CARD" state="loading" />);
    await waitFor(() => {
      expect(screen.getByText('LOADING CARD')).toBeTruthy();
    });
    expect(screen.getAllByLabelText('Loading')).toHaveLength(2);
  });

  it('renders empty state with message', async () => {
    renderWithTheme(
      <Card label="EMPTY CARD" state="empty" emptyMessage="Nothing here" />,
    );
    await waitFor(() => {
      expect(screen.getByText('EMPTY CARD')).toBeTruthy();
    });
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });

  it('renders degraded state with staleness indicator', async () => {
    renderWithTheme(
      <Card label="DEGRADED" state="degraded" degradedMessage="Updated 3 min ago">
        <Text>Stale content</Text>
      </Card>,
    );
    await waitFor(() => {
      expect(screen.getByText('Stale content')).toBeTruthy();
    });
    expect(screen.getByText('Updated 3 min ago')).toBeTruthy();
  });
});

describe('StatDisplay', () => {
  it('renders primary and secondary stats', async () => {
    renderWithTheme(
      <StatDisplay primary="12.4 km" secondary="+310m" />,
    );
    await waitFor(() => {
      expect(screen.getByText('12.4 km')).toBeTruthy();
    });
    expect(screen.getByText('+310m')).toBeTruthy();
  });
});

import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../../theme';
import { touchTarget } from '../../tokens/spacing';
import { TrailCard, type TrailWithTiles } from '../plan/TrailCard';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const trail: TrailWithTiles = {
  id: 'aawt',
  name: 'Australian Alps Walking Track',
  shortName: 'AAWT',
  region: 'ACT / NSW / VIC',
  lengthKm: 655,
  metadataJson: null,
  dataVersion: '2026-07-01',
  isCustom: false,
  sourceFilename: null,
  createdAt: '2026-07-01',
  updatedAt: '2026-07-01',
  tileStatus: {
    trailId: 'aawt',
    files: [],
    complete: false,
    state: 'absent',
    totalSizeBytes: 0,
  },
};

function renderCard(overrides: Partial<React.ComponentProps<typeof TrailCard>> = {}) {
  const props: React.ComponentProps<typeof TrailCard> = {
    trail,
    plans: [],
    isDownloading: false,
    downloadProgress: null,
    downloadError: null,
    onViewMap: jest.fn(),
    onViewDetails: jest.fn(),
    onCreatePlan: jest.fn(),
    onOpenPlan: jest.fn(),
    onDeletePlan: jest.fn(),
    onDeleteCustomTrail: jest.fn(),
    onDownloadTiles: jest.fn(),
    onDeleteTiles: jest.fn(),
    onRetryDownload: jest.fn(),
    onDismissDownloadError: jest.fn(),
    ...overrides,
  };

  render(
    <ThemeProvider>
      <TrailCard {...props} />
    </ThemeProvider>,
  );
  return props;
}

describe('TrailCard map action', () => {
  it('renders an explicit field-sized View Map button', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByLabelText(/View map for Australian Alps/)).toBeTruthy());

    const button = screen.getByLabelText(/View map for Australian Alps/);
    const style = StyleSheet.flatten(button.props.style);
    expect(style.minHeight).toBe(touchTarget.field);
    expect(screen.getByText('View Map')).toBeTruthy();
  });

  it('keeps map and trail-detail navigation as separate actions', async () => {
    const onViewMap = jest.fn();
    const onViewDetails = jest.fn();
    renderCard({ onViewMap, onViewDetails });
    await waitFor(() => expect(screen.getByLabelText(/View map for Australian Alps/)).toBeTruthy());

    fireEvent.press(screen.getByLabelText(/View map for Australian Alps/));
    expect(onViewMap).toHaveBeenCalledTimes(1);
    expect(onViewDetails).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText(/View details for Australian Alps/));
    expect(onViewDetails).toHaveBeenCalledTimes(1);
  });
});

/**
 * The pane-switch handshake: the pane you leave is asked what it was looking
 * at, and only the pane you enter is told about it.
 *
 * The panes stay mounted, so the thing worth proving is that the exchange
 * happens once per switch and in one direction — never continuously, and never
 * back into the pane that produced the focus.
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  GuideFocusProvider,
  useGuideFocus,
  useGuidePaneFocus,
  type GuidePaneKey,
} from '../GuideFocusContext';
import type { FocusWindow } from '../guide-focus';

/** A pane that reports `capture()` and records what it is asked to apply. */
function FakePane({
  pane,
  capture,
  apply,
}: {
  pane: GuidePaneKey;
  capture?: () => FocusWindow | null;
  apply?: (focus: FocusWindow) => void;
}) {
  useGuidePaneFocus(pane, { capture, apply });
  return null;
}

/** Runs the deferred apply immediately, so tests need no frame ticking. */
const immediate = (fn: () => void) => fn();

interface Harness {
  switchPane: (pane: GuidePaneKey) => void;
  currentPane: () => GuidePaneKey;
  getFocus: () => FocusWindow | null;
}

function renderPanes(panes: React.ReactNode): Harness {
  // Probe reports each render's hook value through a mock rather than
  // assigning to closure variables, which the React Compiler lint rejects.
  const report = jest.fn<void, [ReturnType<typeof useGuideFocus>]>();
  const latest = () => {
    const call = report.mock.lastCall;
    if (!call) throw new Error('Probe has not rendered');
    return call[0];
  };

  function Probe() {
    report(useGuideFocus());
    return null;
  }

  act(() => {
    TestRenderer.create(
      <GuideFocusProvider scheduler={immediate}>
        <Probe />
        {panes}
      </GuideFocusProvider>,
    );
  });

  return {
    switchPane: (next) => act(() => latest().switchPane(next)),
    currentPane: () => latest().pane,
    getFocus: () => latest().getFocus(),
  };
}

describe('GuideFocusProvider', () => {
  it('hands the leaving pane’s focus to the entering pane, and only to it', () => {
    const mapApply = jest.fn();
    const elevationApply = jest.fn();
    const listApply = jest.fn();

    const harness = renderPanes(
      <>
        <FakePane pane="map" capture={() => ({ startKm: 40, endKm: 50 })} apply={mapApply} />
        <FakePane pane="elevation" capture={() => null} apply={elevationApply} />
        <FakePane pane="list" capture={() => null} apply={listApply} />
      </>,
    );

    harness.switchPane('elevation');

    expect(harness.currentPane()).toBe('elevation');
    expect(elevationApply).toHaveBeenCalledWith({ startKm: 40, endKm: 50 });
    // The pane that produced the focus is never told to apply it.
    expect(mapApply).not.toHaveBeenCalled();
    expect(listApply).not.toHaveBeenCalled();
  });

  it('keeps the last known focus when the leaving pane cannot report one', () => {
    const listApply = jest.fn();
    const harness = renderPanes(
      <>
        <FakePane pane="map" capture={() => ({ startKm: 10, endKm: 20 })} />
        {/* A profile that has not been laid out yet reports nothing. */}
        <FakePane pane="elevation" capture={() => null} />
        <FakePane pane="list" apply={listApply} />
      </>,
    );

    harness.switchPane('elevation');
    harness.switchPane('list');

    // The map's focus survives the trip through the silent pane.
    expect(listApply).toHaveBeenCalledWith({ startKm: 10, endKm: 20 });
    expect(harness.getFocus()).toEqual({ startKm: 10, endKm: 20 });
  });

  it('ignores a nonsense window rather than storing it', () => {
    const listApply = jest.fn();
    const harness = renderPanes(
      <>
        <FakePane pane="map" capture={() => ({ startKm: 60, endKm: 10 })} />
        <FakePane pane="list" apply={listApply} />
      </>,
    );

    harness.switchPane('list');
    expect(harness.getFocus()).toBeNull();
    expect(listApply).not.toHaveBeenCalled();
  });

  it('does nothing when the selected pane is already showing', () => {
    const capture = jest.fn(() => ({ startKm: 1, endKm: 2 }));
    const harness = renderPanes(<FakePane pane="map" capture={capture} />);

    harness.switchPane('map');

    expect(capture).not.toHaveBeenCalled();
    expect(harness.currentPane()).toBe('map');
  });

  it('captures fresh each switch, so a pane can move between visits', () => {
    let mapWindow: FocusWindow = { startKm: 0, endKm: 100 };
    const elevationApply = jest.fn();

    const harness = renderPanes(
      <>
        <FakePane pane="map" capture={() => mapWindow} />
        <FakePane pane="elevation" capture={() => ({ startKm: 5, endKm: 6 })} apply={elevationApply} />
      </>,
    );

    harness.switchPane('elevation');
    expect(elevationApply).toHaveBeenLastCalledWith({ startKm: 0, endKm: 100 });

    harness.switchPane('map');
    mapWindow = { startKm: 70, endKm: 80 };
    harness.switchPane('elevation');
    expect(elevationApply).toHaveBeenLastCalledWith({ startKm: 70, endKm: 80 });
  });

  it('leaves panes alone outside a provider', () => {
    const capture = jest.fn();
    act(() => {
      TestRenderer.create(<FakePane pane="map" capture={capture} />);
    });
    expect(capture).not.toHaveBeenCalled();
  });
});

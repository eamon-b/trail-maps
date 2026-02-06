import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import MapLibreGL from '@maplibre/maplibre-react-native';
import { Paths, File } from 'expo-file-system';

// Initialize MapLibre
MapLibreGL.setAccessToken(null);

// Bibbulmun Track bounding box (with buffer for corridor)
const BIBBULMUN_BOUNDS = {
  north: -31.8,  // Kalamunda area + buffer
  south: -35.2,  // Albany area + buffer
  east: 118.0,   // Eastern extent + buffer
  west: 115.8,   // Western extent + buffer
};

// OpenFreeMap style URL (free vector tiles)
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

// Trail waypoints for performance testing (lon, lat)
const TRAIL_WAYPOINTS: { name: string; coords: [number, number]; zoom: number }[] = [
  { name: 'Overview', coords: [116.9, -33.5], zoom: 7 },
  { name: 'Kalamunda (Start)', coords: [116.06, -31.97], zoom: 13 },
  { name: 'Dwellingup', coords: [116.06, -32.71], zoom: 13 },
  { name: 'Collie', coords: [116.15, -33.36], zoom: 13 },
  { name: 'Pemberton', coords: [116.04, -34.44], zoom: 13 },
  { name: 'Walpole', coords: [116.73, -34.93], zoom: 13 },
  { name: 'Albany (End)', coords: [117.88, -35.03], zoom: 13 },
  { name: 'Zoom in Kalamunda', coords: [116.06, -31.97], zoom: 14 },
  { name: 'Zoom out to overview', coords: [116.9, -33.5], zoom: 8 },
  { name: 'Rapid zoom to Collie', coords: [116.15, -33.36], zoom: 14 },
];

type Phase = 'download' | 'offline' | 'storage' | 'performance';

interface TestResult {
  zoomLevel: number;
  tileCount: number;
  sizeBytes: number;
  downloadTimeMs: number;
  status: 'pending' | 'downloading' | 'complete' | 'error';
  error?: string;
}

interface StoragePackInfo {
  name: string;
  tileCount: number;
  sizeBytes: number;
}

interface PerfTestResult {
  waypoint: string;
  avgFps: number;
  minFps: number;
  maxFps: number;
  renderTimeMs: number;
}

export default function App() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cameraRef = useRef<any>(null);
  const [mapReady, setMapReady] = useState(false);
  const [activePhase, setActivePhase] = useState<Phase>('download');
  const [logs, setLogs] = useState<string[]>([]);

  // Phase 2: Download state
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [isRunningTest, setIsRunningTest] = useState(false);

  // Phase 3: Offline state
  const [networkStatus, setNetworkStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [offlineMapWorks, setOfflineMapWorks] = useState<boolean | null>(null);

  // Phase 4: Storage state
  const [storagePacks, setStoragePacks] = useState<StoragePackInfo[]>([]);
  const [totalStorageBytes, setTotalStorageBytes] = useState(0);
  const [isCheckingStorage, setIsCheckingStorage] = useState(false);

  // Phase 5: Performance state
  const [fps, setFps] = useState(0);
  const [showFps, setShowFps] = useState(false);
  const [perfTestRunning, setPerfTestRunning] = useState(false);
  const [perfResults, setPerfResults] = useState<PerfTestResult[]>([]);

  // FPS tracking refs (don't trigger re-renders)
  const fpsFrameCount = useRef(0);
  const fpsLastTime = useRef(performance.now());
  const fpsHistory = useRef<number[]>([]);
  const fpsAnimationId = useRef<number | null>(null);

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
    setLogs((prev) => [...prev, `[${timestamp}] ${message}`]);
    console.log(message);
  }, []);

  // Center of Bibbulmun Track
  const centerCoordinate: [number, number] = [
    (BIBBULMUN_BOUNDS.west + BIBBULMUN_BOUNDS.east) / 2,
    (BIBBULMUN_BOUNDS.north + BIBBULMUN_BOUNDS.south) / 2,
  ];

  // ─── Network Status Checking ───────────────────────────────────────────

  const checkNetworkStatus = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(STYLE_URL, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      setNetworkStatus(response.ok ? 'online' : 'offline');
    } catch {
      setNetworkStatus('offline');
    }
  }, []);

  useEffect(() => {
    checkNetworkStatus();
    const interval = setInterval(checkNetworkStatus, 10000);
    return () => clearInterval(interval);
  }, [checkNetworkStatus]);

  // ─── FPS Counter ───────────────────────────────────────────────────────

  const startFpsCounter = useCallback(() => {
    fpsFrameCount.current = 0;
    fpsLastTime.current = performance.now();
    fpsHistory.current = [];

    const tick = () => {
      fpsFrameCount.current++;
      const now = performance.now();
      const elapsed = now - fpsLastTime.current;
      if (elapsed >= 1000) {
        const currentFps = Math.round((fpsFrameCount.current * 1000) / elapsed);
        setFps(currentFps);
        fpsHistory.current.push(currentFps);
        fpsFrameCount.current = 0;
        fpsLastTime.current = now;
      }
      fpsAnimationId.current = requestAnimationFrame(tick);
    };

    fpsAnimationId.current = requestAnimationFrame(tick);
  }, []);

  const stopFpsCounter = useCallback(() => {
    if (fpsAnimationId.current !== null) {
      cancelAnimationFrame(fpsAnimationId.current);
      fpsAnimationId.current = null;
    }
  }, []);

  useEffect(() => {
    if (showFps) {
      startFpsCounter();
    } else {
      stopFpsCounter();
    }
    return stopFpsCounter;
  }, [showFps, startFpsCounter, stopFpsCounter]);

  // ─── Phase 2: Download ─────────────────────────────────────────────────

  const downloadOfflinePack = async (
    name: string,
    minZoom: number,
    maxZoom: number
  ): Promise<TestResult> => {
    const startTime = Date.now();
    const bounds: [[number, number], [number, number]] = [
      [BIBBULMUN_BOUNDS.west, BIBBULMUN_BOUNDS.south],
      [BIBBULMUN_BOUNDS.east, BIBBULMUN_BOUNDS.north],
    ];

    addLog(`Starting download: ${name} (zoom ${minZoom}-${maxZoom})`);
    addLog(`Bounds: SW[${bounds[0].join(', ')}] NE[${bounds[1].join(', ')}]`);

    const packName = `bibbulmun-z${minZoom}-${maxZoom}-${Date.now()}`;

    try {
      const result = await new Promise<{ tileCount: number; sizeBytes: number }>(
        (resolve, reject) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (MapLibreGL.offlineManager as any).createPack(
            {
              name: packName,
              styleURL: STYLE_URL,
              bounds,
              minZoom,
              maxZoom,
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (_offlineRegion: any, status: any) => {
              const percentage = status?.percentage ?? 0;
              const tileCount = status?.completedTileCount ?? 0;
              const sizeBytes = status?.completedTileSize ?? 0;

              if (percentage % 10 < 1) {
                addLog(`Progress: ${percentage.toFixed(1)}% (${tileCount} tiles, ${formatBytes(sizeBytes)})`);
              }

              if (percentage >= 100) {
                resolve({ tileCount, sizeBytes });
              }
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (_offlineRegion: any, error: any) => {
              addLog(`Download error: ${error?.message || 'Unknown error'}`);
              reject(new Error(error?.message || 'Download failed'));
            }
          );
        }
      );

      const downloadTime = Date.now() - startTime;
      addLog(`Download complete: ${result.tileCount} tiles, ${formatBytes(result.sizeBytes)}`);
      addLog(`Download time: ${(downloadTime / 1000).toFixed(1)}s`);

      return {
        zoomLevel: maxZoom,
        tileCount: result.tileCount,
        sizeBytes: result.sizeBytes,
        downloadTimeMs: downloadTime,
        status: 'complete',
      };
    } catch (error) {
      const downloadTime = Date.now() - startTime;
      addLog(`Download failed: ${error}`);
      return {
        zoomLevel: maxZoom,
        tileCount: 0,
        sizeBytes: 0,
        downloadTimeMs: downloadTime,
        status: 'error',
        error: String(error),
      };
    }
  };

  const runZoomLevelTests = async () => {
    setIsRunningTest(true);
    setTestResults([]);
    addLog('=== Starting Zoom Level Tests ===');
    addLog(`Testing Bibbulmun Track corridor`);
    addLog(`Bounds: N${BIBBULMUN_BOUNDS.north}, S${BIBBULMUN_BOUNDS.south}, E${BIBBULMUN_BOUNDS.east}, W${BIBBULMUN_BOUNDS.west}`);

    const results: TestResult[] = [];

    for (let zoom = 10; zoom <= 16; zoom++) {
      addLog(`\n--- Testing zoom level ${zoom} ---`);
      const result = await downloadOfflinePack(`z${zoom}`, zoom, zoom);
      results.push(result);
      setTestResults([...results]);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    addLog('\n--- Testing cumulative zoom 10-16 ---');
    const cumulativeResult = await downloadOfflinePack('z10-16', 10, 16);
    results.push({ ...cumulativeResult, zoomLevel: 16.5 });
    setTestResults([...results]);

    addLog('\n=== Test Complete ===');
    setIsRunningTest(false);
  };

  // ─── Phase 3: Offline Rendering ────────────────────────────────────────

  const testOfflineRendering = useCallback(async () => {
    addLog('=== Phase 3: Offline Rendering Test ===');
    addLog(`Network status: ${networkStatus}`);

    if (networkStatus === 'online') {
      addLog('WARNING: Device appears to be online. Enable Airplane Mode for a valid offline test.');
      Alert.alert(
        'Enable Airplane Mode',
        'For a valid offline rendering test, please:\n\n1. Enable Airplane Mode\n2. Wait a few seconds\n3. Tap "Test Offline Rendering" again\n\nThe network indicator in the header will show when you\'re offline.'
      );
      return;
    }

    addLog('Device is offline. Testing map rendering...');

    // Force the map to re-render by flying to a different location
    try {
      cameraRef.current?.setCamera({
        centerCoordinate: TRAIL_WAYPOINTS[1].coords,
        zoomLevel: 12,
        animationDuration: 1000,
        animationMode: 'flyTo',
      });
      addLog('Camera moved to Kalamunda at zoom 12');

      await new Promise((resolve) => setTimeout(resolve, 2000));

      cameraRef.current?.setCamera({
        centerCoordinate: TRAIL_WAYPOINTS[5].coords,
        zoomLevel: 13,
        animationDuration: 1500,
        animationMode: 'flyTo',
      });
      addLog('Camera moved to Walpole at zoom 13');

      await new Promise((resolve) => setTimeout(resolve, 2000));

      cameraRef.current?.setCamera({
        centerCoordinate: centerCoordinate,
        zoomLevel: 7,
        animationDuration: 1000,
        animationMode: 'flyTo',
      });
      addLog('Camera returned to overview');

      addLog('Offline rendering test complete - verify tiles rendered correctly above');
      setOfflineMapWorks(true);
    } catch (error) {
      addLog(`Offline rendering test error: ${error}`);
      setOfflineMapWorks(false);
    }
  }, [networkStatus, addLog, centerCoordinate]);

  // ─── Phase 4: Storage ──────────────────────────────────────────────────

  const checkStorage = useCallback(async () => {
    setIsCheckingStorage(true);
    addLog('=== Phase 4: Storage Measurement ===');

    try {
      const packs = await MapLibreGL.offlineManager.getPacks();
      addLog(`Found ${packs?.length || 0} offline packs`);

      if (packs && packs.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const packInfos: StoragePackInfo[] = packs.map((pack: any) => ({
          name: pack.name || 'Unknown',
          tileCount: pack.pack?.completedTileCount ?? 0,
          sizeBytes: pack.pack?.completedTileSize ?? 0,
        }));

        setStoragePacks(packInfos);

        const total = packInfos.reduce((sum, p) => sum + p.sizeBytes, 0);
        setTotalStorageBytes(total);

        addLog(`\nPack breakdown:`);
        packInfos.forEach((p) => {
          addLog(`  ${p.name}: ${p.tileCount} tiles, ${formatBytes(p.sizeBytes)}`);
        });
        addLog(`\nTotal reported by MapLibre: ${formatBytes(total)}`);
      } else {
        addLog('No offline packs found. Run Phase 2 (Download) first.');
        setStoragePacks([]);
        setTotalStorageBytes(0);
      }
    } catch (error) {
      addLog(`Error checking storage: ${error}`);
    }

    setIsCheckingStorage(false);
  }, [addLog]);

  // ─── Phase 5: Performance ──────────────────────────────────────────────

  const runPerformanceTest = useCallback(async () => {
    if (!mapReady) {
      addLog('Map not ready yet');
      return;
    }

    setPerfTestRunning(true);
    setPerfResults([]);
    setShowFps(true);
    addLog('=== Phase 5: Performance Test ===');
    addLog('Flying through trail waypoints and measuring FPS...');

    const results: PerfTestResult[] = [];

    // Wait for FPS counter to stabilize
    await new Promise((resolve) => setTimeout(resolve, 1500));

    for (const waypoint of TRAIL_WAYPOINTS) {
      addLog(`\nFlying to: ${waypoint.name} (zoom ${waypoint.zoom})`);
      fpsHistory.current = [];

      cameraRef.current?.setCamera({
        centerCoordinate: waypoint.coords,
        zoomLevel: waypoint.zoom,
        animationDuration: 2000,
        animationMode: 'flyTo',
      });

      // Wait for animation to complete + settle time
      const renderStart = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const renderTime = Date.now() - renderStart;

      const fpsReadings = fpsHistory.current;
      if (fpsReadings.length > 0) {
        const avgFps = Math.round(fpsReadings.reduce((a, b) => a + b, 0) / fpsReadings.length);
        const minFps = Math.min(...fpsReadings);
        const maxFps = Math.max(...fpsReadings);

        const result: PerfTestResult = {
          waypoint: waypoint.name,
          avgFps,
          minFps,
          maxFps,
          renderTimeMs: renderTime,
        };
        results.push(result);
        setPerfResults([...results]);

        addLog(`  Avg FPS: ${avgFps}, Min: ${minFps}, Max: ${maxFps}`);
      } else {
        addLog(`  No FPS data collected`);
        results.push({
          waypoint: waypoint.name,
          avgFps: 0,
          minFps: 0,
          maxFps: 0,
          renderTimeMs: renderTime,
        });
        setPerfResults([...results]);
      }
    }

    addLog('\n=== Performance Test Complete ===');
    const allFps = results.filter((r) => r.avgFps > 0);
    if (allFps.length > 0) {
      const overallAvg = Math.round(allFps.reduce((sum, r) => sum + r.avgFps, 0) / allFps.length);
      const overallMin = Math.min(...allFps.map((r) => r.minFps));
      addLog(`Overall: Avg ${overallAvg} FPS, Min ${overallMin} FPS`);
      addLog(overallAvg >= 30 ? 'PASS: Performance is adequate (>= 30 FPS)' : 'WARN: Performance may be inadequate (< 30 FPS)');
    }

    setPerfTestRunning(false);
  }, [mapReady, addLog]);

  // ─── Utilities ─────────────────────────────────────────────────────────

  const clearAllPacks = async () => {
    Alert.alert(
      'Clear Offline Data',
      'This will delete all downloaded offline map data. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await MapLibreGL.offlineManager.resetDatabase();
              setTestResults([]);
              setStoragePacks([]);
              setTotalStorageBytes(0);
              addLog('All offline packs deleted');
            } catch (error) {
              addLog(`Error clearing packs: ${error}`);
            }
          },
        },
      ]
    );
  };

  const exportResults = async () => {
    const report = generateReport();
    const filename = `maplibre-spike-results-${Date.now()}.txt`;

    try {
      const file = new File(Paths.cache, filename);
      await file.write(report);
      addLog(`Report saved to: ${file.uri}`);
      Alert.alert('Report Saved', `Results exported to ${filename}`);
    } catch (error) {
      addLog(`Error saving report: ${error}`);
    }
  };

  const generateReport = () => {
    const lines = [
      '# MapLibre Offline Spike - Full Test Results',
      `Date: ${new Date().toISOString()}`,
      `Platform: ${Platform.OS} ${Platform.Version}`,
      '',
      '## Test Configuration',
      `Trail: Bibbulmun Track`,
      `Bounds: N${BIBBULMUN_BOUNDS.north}, S${BIBBULMUN_BOUNDS.south}, E${BIBBULMUN_BOUNDS.east}, W${BIBBULMUN_BOUNDS.west}`,
      `Style URL: ${STYLE_URL}`,
      '',
      '## Phase 2: Download Results',
      '',
      '| Zoom | Tiles | Size | Time |',
      '|------|-------|------|------|',
    ];

    testResults.forEach((r) => {
      const zoom = r.zoomLevel === 16.5 ? '10-16' : r.zoomLevel.toString();
      lines.push(`| ${zoom} | ${r.tileCount.toLocaleString()} | ${formatBytes(r.sizeBytes)} | ${(r.downloadTimeMs / 1000).toFixed(1)}s |`);
    });

    lines.push('', '## Phase 3: Offline Rendering', '');
    lines.push(`Network status at test time: ${networkStatus}`);
    lines.push(`Offline map rendered: ${offlineMapWorks === null ? 'Not tested' : offlineMapWorks ? 'Yes' : 'No'}`);

    lines.push('', '## Phase 4: Storage', '');
    if (storagePacks.length > 0) {
      lines.push('| Pack | Tiles | Size |', '|------|-------|------|');
      storagePacks.forEach((p) => {
        lines.push(`| ${p.name} | ${p.tileCount.toLocaleString()} | ${formatBytes(p.sizeBytes)} |`);
      });
      lines.push(``, `Total storage: ${formatBytes(totalStorageBytes)}`);
    } else {
      lines.push('No storage data collected.');
    }

    lines.push('', '## Phase 5: Performance', '');
    if (perfResults.length > 0) {
      lines.push('| Waypoint | Avg FPS | Min FPS | Max FPS |', '|----------|---------|---------|---------|');
      perfResults.forEach((r) => {
        lines.push(`| ${r.waypoint} | ${r.avgFps} | ${r.minFps} | ${r.maxFps} |`);
      });
    } else {
      lines.push('No performance data collected.');
    }

    lines.push('', '## Full Logs', '```');
    lines.push(...logs);
    lines.push('```');

    return lines.join('\n');
  };

  // ─── Render ────────────────────────────────────────────────────────────

  const networkBadgeColor =
    networkStatus === 'online' ? '#4CAF50' : networkStatus === 'offline' ? '#F44336' : '#FFC107';

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />

      {/* Header with network status */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>MapLibre Offline Spike</Text>
            <Text style={styles.subtitle}>Bibbulmun Track Test</Text>
          </View>
          <View style={styles.networkBadge}>
            <View style={[styles.networkDot, { backgroundColor: networkBadgeColor }]} />
            <Text style={styles.networkText}>
              {networkStatus === 'checking' ? '...' : networkStatus}
            </Text>
          </View>
        </View>
      </View>

      {/* Map with optional FPS overlay */}
      <View style={styles.mapContainer}>
        <MapLibreGL.MapView
          style={styles.map}
          mapStyle={STYLE_URL}
          onDidFinishLoadingMap={() => {
            setMapReady(true);
            addLog('Map loaded successfully');
          }}
        >
          <MapLibreGL.Camera
            ref={cameraRef}
            defaultSettings={{
              centerCoordinate,
              zoomLevel: 7,
            }}
          />

          {/* Show Bibbulmun Track bounds */}
          <MapLibreGL.ShapeSource
            id="bounds-source"
            shape={{
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'Polygon',
                coordinates: [[
                  [BIBBULMUN_BOUNDS.west, BIBBULMUN_BOUNDS.north],
                  [BIBBULMUN_BOUNDS.east, BIBBULMUN_BOUNDS.north],
                  [BIBBULMUN_BOUNDS.east, BIBBULMUN_BOUNDS.south],
                  [BIBBULMUN_BOUNDS.west, BIBBULMUN_BOUNDS.south],
                  [BIBBULMUN_BOUNDS.west, BIBBULMUN_BOUNDS.north],
                ]],
              },
            }}
          >
            <MapLibreGL.LineLayer
              id="bounds-line"
              style={{
                lineColor: '#FF0000',
                lineWidth: 2,
                lineDasharray: [4, 4],
              }}
            />
          </MapLibreGL.ShapeSource>
        </MapLibreGL.MapView>

        {!mapReady && (
          <View style={styles.mapOverlay}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Loading map...</Text>
          </View>
        )}

        {/* FPS Counter overlay */}
        {showFps && (
          <View style={styles.fpsOverlay}>
            <Text style={[styles.fpsText, fps < 30 && styles.fpsLow]}>
              {fps} FPS
            </Text>
          </View>
        )}
      </View>

      {/* Phase Tabs */}
      <View style={styles.phaseTabs}>
        {([
          { key: 'download', label: '2: Download' },
          { key: 'offline', label: '3: Offline' },
          { key: 'storage', label: '4: Storage' },
          { key: 'performance', label: '5: Perf' },
        ] as { key: Phase; label: string }[]).map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.phaseTab, activePhase === tab.key && styles.phaseTabActive]}
            onPress={() => setActivePhase(tab.key)}
          >
            <Text style={[styles.phaseTabText, activePhase === tab.key && styles.phaseTabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Phase Content */}
      <ScrollView style={styles.phaseContent} contentContainerStyle={styles.phaseContentInner}>

        {/* Phase 2: Download */}
        {activePhase === 'download' && (
          <>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton, isRunningTest && styles.disabledButton]}
              onPress={runZoomLevelTests}
              disabled={isRunningTest || !mapReady}
            >
              <Text style={styles.buttonText}>
                {isRunningTest ? 'Testing...' : 'Run Zoom Level Tests (10-16)'}
              </Text>
            </TouchableOpacity>

            <View style={styles.buttonRow}>
              <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={clearAllPacks}>
                <Text style={styles.secondaryButtonText}>Clear Data</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.secondaryButton]}
                onPress={exportResults}
                disabled={testResults.length === 0}
              >
                <Text style={styles.secondaryButtonText}>Export Results</Text>
              </TouchableOpacity>
            </View>

            {testResults.length > 0 && (
              <View style={styles.resultCard}>
                <Text style={styles.sectionTitle}>Download Results</Text>
                <ScrollView horizontal>
                  <View>
                    <View style={styles.tableHeader}>
                      <Text style={[styles.tableCell, styles.headerCell]}>Zoom</Text>
                      <Text style={[styles.tableCell, styles.headerCell]}>Tiles</Text>
                      <Text style={[styles.tableCell, styles.headerCell]}>Size</Text>
                      <Text style={[styles.tableCell, styles.headerCell]}>Time</Text>
                    </View>
                    {testResults.map((r, i) => (
                      <View key={i} style={styles.tableRow}>
                        <Text style={styles.tableCell}>
                          {r.zoomLevel === 16.5 ? '10-16' : r.zoomLevel}
                        </Text>
                        <Text style={styles.tableCell}>{r.tileCount.toLocaleString()}</Text>
                        <Text style={styles.tableCell}>{formatBytes(r.sizeBytes)}</Text>
                        <Text style={styles.tableCell}>{(r.downloadTimeMs / 1000).toFixed(1)}s</Text>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </View>
            )}
          </>
        )}

        {/* Phase 3: Offline Rendering */}
        {activePhase === 'offline' && (
          <>
            <View style={styles.resultCard}>
              <Text style={styles.sectionTitle}>Offline Rendering Test</Text>
              <Text style={styles.instructions}>
                This tests whether the map renders correctly using cached tiles when offline.
              </Text>

              <View style={styles.checklist}>
                <Text style={styles.checkItem}>
                  {networkStatus === 'offline' ? '\u2705' : '\u2B1C'} Device is offline (enable Airplane Mode)
                </Text>
                <Text style={styles.checkItem}>
                  {offlineMapWorks === true ? '\u2705' : '\u2B1C'} Map renders with cached tiles
                </Text>
              </View>

              <Text style={styles.instructions}>
                Steps:{'\n'}
                1. Ensure Phase 2 download has completed{'\n'}
                2. Enable Airplane Mode on your device{'\n'}
                3. Wait for the network indicator to show "offline"{'\n'}
                4. Tap "Test Offline Rendering" below{'\n'}
                5. Verify the map pans to different locations correctly{'\n'}
                6. Manually pan/zoom within the red bounding box to verify
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={testOfflineRendering}
            >
              <Text style={styles.buttonText}>Test Offline Rendering</Text>
            </TouchableOpacity>

            {offlineMapWorks !== null && (
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={[styles.button, { backgroundColor: '#4CAF50', flex: 1 }]}
                  onPress={() => {
                    setOfflineMapWorks(true);
                    addLog('User confirmed: Offline rendering WORKS');
                  }}
                >
                  <Text style={styles.buttonText}>Works</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.button, { backgroundColor: '#F44336', flex: 1 }]}
                  onPress={() => {
                    setOfflineMapWorks(false);
                    addLog('User reported: Offline rendering FAILED');
                  }}
                >
                  <Text style={styles.buttonText}>Broken</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}

        {/* Phase 4: Storage */}
        {activePhase === 'storage' && (
          <>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton, isCheckingStorage && styles.disabledButton]}
              onPress={checkStorage}
              disabled={isCheckingStorage}
            >
              <Text style={styles.buttonText}>
                {isCheckingStorage ? 'Checking...' : 'Measure Storage'}
              </Text>
            </TouchableOpacity>

            <View style={styles.resultCard}>
              <Text style={styles.sectionTitle}>Storage Measurement</Text>
              <Text style={styles.instructions}>
                Measures the storage used by MapLibre's offline tile packs.
                Also check device settings for the full app storage footprint.
              </Text>

              {storagePacks.length > 0 ? (
                <>
                  <View style={styles.storageTotal}>
                    <Text style={styles.storageTotalLabel}>Total Offline Storage</Text>
                    <Text style={styles.storageTotalValue}>{formatBytes(totalStorageBytes)}</Text>
                  </View>

                  <Text style={[styles.sectionTitle, { marginTop: 12 }]}>Pack Breakdown</Text>
                  <ScrollView horizontal>
                    <View>
                      <View style={styles.tableHeader}>
                        <Text style={[styles.tableCellWide, styles.headerCell]}>Pack</Text>
                        <Text style={[styles.tableCell, styles.headerCell]}>Tiles</Text>
                        <Text style={[styles.tableCell, styles.headerCell]}>Size</Text>
                      </View>
                      {storagePacks.map((p, i) => (
                        <View key={i} style={styles.tableRow}>
                          <Text style={styles.tableCellWide} numberOfLines={1}>{p.name}</Text>
                          <Text style={styles.tableCell}>{p.tileCount.toLocaleString()}</Text>
                          <Text style={styles.tableCell}>{formatBytes(p.sizeBytes)}</Text>
                        </View>
                      ))}
                    </View>
                  </ScrollView>

                  <Text style={[styles.instructions, { marginTop: 12 }]}>
                    Also check device storage:{'\n'}
                    {Platform.OS === 'ios'
                      ? 'Settings > General > iPhone Storage > MapLibre Offline Spike'
                      : 'Settings > Apps > MapLibre Offline Spike > Storage'}
                  </Text>
                </>
              ) : (
                <Text style={styles.instructions}>
                  No data yet. Tap "Measure Storage" above.
                </Text>
              )}
            </View>
          </>
        )}

        {/* Phase 5: Performance */}
        {activePhase === 'performance' && (
          <>
            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.button, styles.primaryButton, { flex: 1 }, perfTestRunning && styles.disabledButton]}
                onPress={runPerformanceTest}
                disabled={perfTestRunning || !mapReady}
              >
                <Text style={styles.buttonText}>
                  {perfTestRunning ? 'Testing...' : 'Run Performance Test'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, showFps ? styles.primaryButton : styles.secondaryButton]}
                onPress={() => setShowFps(!showFps)}
              >
                <Text style={showFps ? styles.buttonText : styles.secondaryButtonText}>
                  FPS {showFps ? 'ON' : 'OFF'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.resultCard}>
              <Text style={styles.sectionTitle}>Performance Test</Text>
              <Text style={styles.instructions}>
                Automatically flies through trail waypoints, measuring FPS at each location.
                Toggle FPS counter above to see real-time framerate, or run the automated test.
                {'\n\n'}
                You can also manually pan/zoom the map with the FPS counter enabled to
                test interactive performance.
              </Text>

              {perfResults.length > 0 && (
                <>
                  <ScrollView horizontal>
                    <View>
                      <View style={styles.tableHeader}>
                        <Text style={[styles.tableCellWide, styles.headerCell]}>Location</Text>
                        <Text style={[styles.tableCell, styles.headerCell]}>Avg</Text>
                        <Text style={[styles.tableCell, styles.headerCell]}>Min</Text>
                        <Text style={[styles.tableCell, styles.headerCell]}>Max</Text>
                      </View>
                      {perfResults.map((r, i) => (
                        <View key={i} style={styles.tableRow}>
                          <Text style={styles.tableCellWide} numberOfLines={1}>{r.waypoint}</Text>
                          <Text style={[styles.tableCell, r.avgFps < 30 && styles.fpsWarnText]}>
                            {r.avgFps}
                          </Text>
                          <Text style={[styles.tableCell, r.minFps < 30 && styles.fpsWarnText]}>
                            {r.minFps}
                          </Text>
                          <Text style={styles.tableCell}>{r.maxFps}</Text>
                        </View>
                      ))}
                    </View>
                  </ScrollView>

                  {perfResults.filter((r) => r.avgFps > 0).length > 0 && (
                    <View style={styles.perfSummary}>
                      <Text style={styles.perfSummaryText}>
                        Overall Avg:{' '}
                        {Math.round(
                          perfResults.filter((r) => r.avgFps > 0).reduce((s, r) => s + r.avgFps, 0) /
                          perfResults.filter((r) => r.avgFps > 0).length
                        )}{' '}
                        FPS | Min:{' '}
                        {Math.min(...perfResults.filter((r) => r.minFps > 0).map((r) => r.minFps))}{' '}
                        FPS
                      </Text>
                    </View>
                  )}
                </>
              )}
            </View>
          </>
        )}
      </ScrollView>

      {/* Log Output */}
      <View style={styles.logContainer}>
        <View style={styles.logHeader}>
          <Text style={styles.sectionTitleLight}>Logs</Text>
          <TouchableOpacity onPress={() => setLogs([])}>
            <Text style={styles.logClear}>Clear</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.logScroll}>
          {logs.slice(-20).map((log, i) => (
            <Text key={i} style={styles.logText}>{log}</Text>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    paddingTop: 50,
    paddingBottom: 10,
    paddingHorizontal: 16,
    backgroundColor: '#007AFF',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#fff',
  },
  subtitle: {
    fontSize: 14,
    color: '#E0E0E0',
    marginTop: 2,
  },
  networkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  networkDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  networkText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  mapContainer: {
    height: 220,
    margin: 12,
    marginBottom: 0,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#ddd',
  },
  map: {
    flex: 1,
  },
  mapOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 10,
    color: '#666',
  },
  fpsOverlay: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  fpsText: {
    color: '#4CAF50',
    fontSize: 14,
    fontWeight: 'bold',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fpsLow: {
    color: '#F44336',
  },
  phaseTabs: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 4,
  },
  phaseTab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#E0E0E0',
    alignItems: 'center',
  },
  phaseTabActive: {
    backgroundColor: '#007AFF',
  },
  phaseTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
  },
  phaseTabTextActive: {
    color: '#fff',
  },
  phaseContent: {
    flex: 1,
    marginTop: 8,
  },
  phaseContentInner: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
  },
  button: {
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryButton: {
    backgroundColor: '#007AFF',
  },
  secondaryButton: {
    backgroundColor: '#E0E0E0',
    flex: 1,
  },
  disabledButton: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  secondaryButtonText: {
    color: '#333',
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  resultCard: {
    padding: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  sectionTitleLight: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0f0',
    marginBottom: 4,
  },
  instructions: {
    fontSize: 13,
    color: '#555',
    lineHeight: 20,
  },
  checklist: {
    marginVertical: 12,
    gap: 8,
  },
  checkItem: {
    fontSize: 14,
    color: '#333',
  },
  storageTotal: {
    backgroundColor: '#E3F2FD',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginVertical: 8,
  },
  storageTotalLabel: {
    fontSize: 12,
    color: '#1565C0',
    fontWeight: '600',
  },
  storageTotalValue: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#0D47A1',
    marginTop: 4,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f0f0f0',
    borderRadius: 4,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  tableCell: {
    width: 60,
    padding: 8,
    fontSize: 12,
  },
  tableCellWide: {
    width: 120,
    padding: 8,
    fontSize: 12,
  },
  headerCell: {
    fontWeight: '600',
  },
  fpsWarnText: {
    color: '#F44336',
    fontWeight: '600',
  },
  perfSummary: {
    marginTop: 8,
    padding: 8,
    backgroundColor: '#E8F5E9',
    borderRadius: 6,
  },
  perfSummaryText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#2E7D32',
    textAlign: 'center',
  },
  logContainer: {
    height: 120,
    margin: 12,
    marginTop: 4,
    padding: 12,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
  },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  logClear: {
    color: '#888',
    fontSize: 12,
  },
  logScroll: {
    flex: 1,
  },
  logText: {
    fontSize: 11,
    color: '#0f0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
  },
});

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

interface OfflinePackInfo {
  name: string;
  status: string;
  progress: number;
  completedTileCount?: number;
  completedTileSize?: number;
  error?: string;
}

interface TestResult {
  zoomLevel: number;
  tileCount: number;
  sizeBytes: number;
  downloadTimeMs: number;
  status: 'pending' | 'downloading' | 'complete' | 'error';
  error?: string;
}

export default function App() {
  const mapRef = useRef<typeof MapLibreGL.MapView | null>(null);
  const [mapReady, setMapReady] = useState(false);
  // Track offline packs (used for progress updates during download)
  const [_offlinePacks, setOfflinePacks] = useState<OfflinePackInfo[]>([]);
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [isRunningTest, setIsRunningTest] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
    setLogs((prev) => [...prev, `[${timestamp}] ${message}`]);
    console.log(message);
  }, []);

  // Center of Bibbulmun Track
  const centerCoordinate = [
    (BIBBULMUN_BOUNDS.west + BIBBULMUN_BOUNDS.east) / 2,
    (BIBBULMUN_BOUNDS.north + BIBBULMUN_BOUNDS.south) / 2,
  ];

  const checkExistingPacks = useCallback(async () => {
    try {
      const packs = await MapLibreGL.offlineManager.getPacks();
      addLog(`Found ${packs?.length || 0} existing offline packs`);
      if (packs && packs.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const packInfos = packs.map((pack: any) => ({
          name: pack.name || 'Unknown',
          status: 'complete',
          progress: 100,
          completedTileCount: pack.pack?.completedTileCount,
          completedTileSize: pack.pack?.completedTileSize,
        }));
        setOfflinePacks(packInfos);
      }
    } catch (error) {
      addLog(`Error checking packs: ${error}`);
    }
  }, [addLog]);

  useEffect(() => {
    // Check for existing offline packs on mount
    checkExistingPacks();
  }, [checkExistingPacks]);

  const downloadOfflinePack = async (
    name: string,
    minZoom: number,
    maxZoom: number
  ): Promise<TestResult> => {
    const startTime = Date.now();

    // Bounds as [[sw_lon, sw_lat], [ne_lon, ne_lat]]
    const bounds: [[number, number], [number, number]] = [
      [BIBBULMUN_BOUNDS.west, BIBBULMUN_BOUNDS.south],
      [BIBBULMUN_BOUNDS.east, BIBBULMUN_BOUNDS.north],
    ];

    addLog(`Starting download: ${name} (zoom ${minZoom}-${maxZoom})`);
    addLog(`Bounds: SW[${bounds[0].join(', ')}] NE[${bounds[1].join(', ')}]`);

    const packName = `bibbulmun-z${minZoom}-${maxZoom}-${Date.now()}`;

    try {
      // createPack resolves immediately - the actual download happens
      // asynchronously via callbacks. We wrap it in a Promise that resolves
      // when the progress callback reports completion.
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

              setOfflinePacks((prev) => {
                const existing = prev.find((p) => p.name === packName);
                if (existing) {
                  return prev.map((p) =>
                    p.name === packName
                      ? { ...p, progress: percentage, completedTileCount: tileCount, completedTileSize: sizeBytes }
                      : p
                  );
                }
                return [
                  ...prev,
                  {
                    name: packName,
                    status: 'downloading',
                    progress: percentage,
                    completedTileCount: tileCount,
                    completedTileSize: sizeBytes,
                  },
                ];
              });

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

      setOfflinePacks((prev) =>
        prev.map((p) =>
          p.name === packName
            ? {
                ...p,
                status: 'complete',
                progress: 100,
                completedTileCount: result.tileCount,
                completedTileSize: result.sizeBytes,
              }
            : p
        )
      );

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

    // Test zoom levels 10-16 as specified in the plan
    for (let zoom = 10; zoom <= 16; zoom++) {
      addLog(`\n--- Testing zoom level ${zoom} ---`);

      // Download tiles for this zoom level only
      const result = await downloadOfflinePack(`z${zoom}`, zoom, zoom);
      results.push(result);
      setTestResults([...results]);

      // Small delay between tests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Also test cumulative (zoom 10-16 together)
    addLog('\n--- Testing cumulative zoom 10-16 ---');
    const cumulativeResult = await downloadOfflinePack('z10-16', 10, 16);
    results.push({ ...cumulativeResult, zoomLevel: 16.5 }); // Use 16.5 to indicate cumulative
    setTestResults([...results]);

    addLog('\n=== Test Complete ===');
    addLog('Results Summary:');
    results.forEach((r) => {
      if (r.zoomLevel === 16.5) {
        addLog(`  Cumulative (10-16): ${r.tileCount} tiles, ${formatBytes(r.sizeBytes)}`);
      } else {
        addLog(`  Zoom ${r.zoomLevel}: ${r.tileCount} tiles, ${formatBytes(r.sizeBytes)}`);
      }
    });

    const totalSize = results.reduce((sum, r) => sum + r.sizeBytes, 0);
    addLog(`\nTotal storage: ${formatBytes(totalSize)}`);

    setIsRunningTest(false);
  };

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
              setOfflinePacks([]);
              setTestResults([]);
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
      '# MapLibre Offline Spike - Test Results',
      `Date: ${new Date().toISOString()}`,
      `Platform: ${Platform.OS} ${Platform.Version}`,
      '',
      '## Test Configuration',
      `Trail: Bibbulmun Track`,
      `Bounds: N${BIBBULMUN_BOUNDS.north}, S${BIBBULMUN_BOUNDS.south}, E${BIBBULMUN_BOUNDS.east}, W${BIBBULMUN_BOUNDS.west}`,
      `Style URL: ${STYLE_URL}`,
      '',
      '## Results by Zoom Level',
      '',
      '| Zoom | Tiles | Size | Time |',
      '|------|-------|------|------|',
    ];

    testResults.forEach((r) => {
      const zoom = r.zoomLevel === 16.5 ? '10-16' : r.zoomLevel.toString();
      const tiles = r.tileCount.toLocaleString();
      const size = formatBytes(r.sizeBytes);
      const time = `${(r.downloadTimeMs / 1000).toFixed(1)}s`;
      lines.push(`| ${zoom} | ${tiles} | ${size} | ${time} |`);
    });

    const totalSize = testResults.reduce((sum, r) => sum + r.sizeBytes, 0);
    lines.push('');
    lines.push(`## Summary`);
    lines.push(`Total storage required: ${formatBytes(totalSize)}`);
    lines.push('');
    lines.push('## Logs');
    lines.push('```');
    lines.push(...logs);
    lines.push('```');

    return lines.join('\n');
  };

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>MapLibre Offline Spike</Text>
        <Text style={styles.subtitle}>Bibbulmun Track Test</Text>
      </View>

      {/* Map */}
      <View style={styles.mapContainer}>
        <MapLibreGL.MapView
          ref={mapRef as React.RefObject<any>}
          style={styles.map}
          mapStyle={STYLE_URL}
          onDidFinishLoadingMap={() => {
            setMapReady(true);
            addLog('Map loaded successfully');
          }}
        >
          <MapLibreGL.Camera
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
      </View>

      {/* Controls */}
      <View style={styles.controls}>
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
          <TouchableOpacity
            style={[styles.button, styles.secondaryButton]}
            onPress={clearAllPacks}
          >
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
      </View>

      {/* Results */}
      {testResults.length > 0 && (
        <View style={styles.results}>
          <Text style={styles.sectionTitle}>Results</Text>
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

      {/* Log Output */}
      <View style={styles.logContainer}>
        <Text style={styles.sectionTitle}>Logs</Text>
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
  mapContainer: {
    height: 250,
    margin: 16,
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
  controls: {
    paddingHorizontal: 16,
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
  results: {
    margin: 16,
    marginBottom: 8,
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
    width: 70,
    padding: 8,
    fontSize: 12,
  },
  headerCell: {
    fontWeight: '600',
  },
  logContainer: {
    flex: 1,
    margin: 16,
    marginTop: 8,
    padding: 12,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
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

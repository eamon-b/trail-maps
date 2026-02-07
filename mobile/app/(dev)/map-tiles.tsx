/**
 * Dev screen for testing MBTiles loading in MapLibre React Native.
 *
 * Usage:
 *   1. From the project root, serve tiles:
 *        npx serve public/data/tiles -p 8080 --cors
 *   2. Run the dev build on device/emulator
 *   3. Open Dev Catalog > Map Tiles
 *   4. Enter your machine's local IP (shown in Metro terminal)
 *   5. Tap "Download Tiles" then "Show Map"
 */
import { useState, useEffect } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';
import { useTheme } from '../../src/theme';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';
import {
  getTrailTileStatus,
  downloadTrailTiles,
  deleteTrailTiles,
  buildTopoStyle,
  provisionGlyphs,
  type TrailTileStatus,
} from '../../src/services/tile-service';

MapLibreGL.setAccessToken(null);

const TRAIL_ID = 'bibbulmun';

// Bibbulmun trail center (roughly Collie area)
const INITIAL_CENTER: [number, number] = [116.85, -33.53];
const INITIAL_ZOOM = 10;

export default function MapTilesDevScreen() {
  const { colors } = useTheme();
  const [serverIp, setServerIp] = useState('');
  const [tileStatus, setTileStatus] = useState<TrailTileStatus | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [glyphsPath, setGlyphsPath] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<string>('');

  const allDone = tileStatus?.complete ?? false;

  useEffect(() => {
    refreshStatus();
    // Provision font glyphs for offline use on mount
    provisionGlyphs().then(setGlyphsPath).catch(console.error);
  }, []);

  function refreshStatus() {
    setTileStatus(getTrailTileStatus(TRAIL_ID));
  }

  async function handleDownload() {
    if (downloading || !serverIp.trim()) return;
    setDownloading(true);

    const baseUrl = `http://${serverIp.trim()}:8080`;

    try {
      await downloadTrailTiles(TRAIL_ID, baseUrl, (progress) => {
        // Refresh status after each file
        setTileStatus(getTrailTileStatus(TRAIL_ID));
        if (progress.error) {
          setDebugInfo((prev) => prev + `\nError: ${progress.fileName}: ${progress.error}`);
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDebugInfo(`Download error: ${msg}`);
    }

    setDownloading(false);
    refreshStatus();
  }

  function verifyAndShowMap() {
    const status = getTrailTileStatus(TRAIL_ID);
    const lines: string[] = [];
    lines.push(`Glyphs path: ${glyphsPath ?? 'not provisioned'}`);
    for (const f of status.files) {
      lines.push(`${f.name}: exists=${f.exists}, size=${(f.sizeBytes / (1024 * 1024)).toFixed(1)} MB`);
    }
    setDebugInfo(lines.join('\n'));
    setShowMap(true);
  }

  function handleDelete() {
    deleteTrailTiles(TRAIL_ID);
    setShowMap(false);
    refreshStatus();
  }

  if (showMap && glyphsPath) {
    const styleJSON = buildTopoStyle(TRAIL_ID, glyphsPath);

    return (
      <View style={styles.mapContainer}>
        <MapLibreGL.MapView
          style={styles.map}
          mapStyle={JSON.stringify(styleJSON)}
          logoEnabled={false}
          attributionEnabled={false}
          onDidFailLoadingMap={() => {
            setMapError('Map failed to load -- check mbtiles paths in debug info');
          }}
        >
          <MapLibreGL.Camera
            defaultSettings={{
              centerCoordinate: INITIAL_CENTER,
              zoomLevel: INITIAL_ZOOM,
            }}
          />
        </MapLibreGL.MapView>

        {(mapError || debugInfo) && (
          <View style={[styles.errorBanner, { backgroundColor: '#fee' }]}>
            {mapError && <Text style={styles.errorText}>Map error: {mapError}</Text>}
            {debugInfo && (
              <Text style={[styles.errorText, { color: '#333', marginTop: 4 }]} selectable>
                {debugInfo}
              </Text>
            )}
          </View>
        )}

        <Pressable
          style={[styles.backButton, { backgroundColor: colors.surface }]}
          onPress={() => {
            setShowMap(false);
            setMapError(null);
          }}
        >
          <Text style={[styles.backButtonText, { color: colors.textPrimary }]}>
            Back
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.header, { color: colors.textSecondary }]}>
        MBTiles Loading Test
      </Text>

      <Text style={[styles.body, { color: colors.textSecondary }]}>
        Tests loading local MBTiles in MapLibre via mbtiles:// protocol.
        {'\n'}Uses bundled font glyphs for offline text rendering.
      </Text>

      {/* Server IP input */}
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>
          Dev server IP (your machine's LAN IP)
        </Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
          value={serverIp}
          onChangeText={setServerIp}
          placeholder={Platform.OS === 'android' ? '10.0.2.2 (emulator)' : '192.168.x.x'}
          placeholderTextColor={colors.textSecondary}
          keyboardType="decimal-pad"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Run from project root:{'\n'}npx serve public/data/tiles -p 8080 --cors
        </Text>
      </View>

      {/* File status */}
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Tile Files</Text>
        {tileStatus?.files.map((f) => (
          <View key={f.name} style={styles.fileRow}>
            <Text style={[styles.fileName, { color: colors.textPrimary }]}>
              {f.exists ? 'OK' : '--'} {f.name}
            </Text>
            <Text style={[styles.fileSize, { color: colors.textSecondary }]}>
              {f.exists ? `${(f.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : ''}
            </Text>
          </View>
        ))}
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Fonts: {glyphsPath ? 'provisioned' : 'loading...'}
        </Text>
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <Pressable
          style={[
            styles.button,
            {
              backgroundColor: downloading ? colors.border : '#4CAF50',
              opacity: !serverIp.trim() && !allDone ? 0.5 : 1,
            },
          ]}
          onPress={handleDownload}
          disabled={downloading || !serverIp.trim()}
        >
          {downloading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.buttonText}>Download Tiles</Text>
          )}
        </Pressable>

        <Pressable
          style={[
            styles.button,
            { backgroundColor: allDone && glyphsPath ? '#2196F3' : colors.border },
          ]}
          onPress={verifyAndShowMap}
          disabled={!allDone || !glyphsPath}
        >
          <Text style={[styles.buttonText, { opacity: allDone && glyphsPath ? 1 : 0.5 }]}>
            Show Map
          </Text>
        </Pressable>

        <Pressable
          style={[styles.button, { backgroundColor: '#f44336' }]}
          onPress={handleDelete}
        >
          <Text style={styles.buttonText}>Delete Tiles</Text>
        </Pressable>
      </View>

      <Pressable
        style={[
          styles.button,
          { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
        ]}
        onPress={refreshStatus}
      >
        <Text style={[styles.buttonText, { color: colors.textPrimary }]}>Refresh Status</Text>
      </Pressable>

      {debugInfo ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>Debug Info</Text>
          <Text style={[styles.body, { color: colors.textPrimary }]} selectable>
            {debugInfo}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  header: { ...typography.titleLarge, marginBottom: spacing.xs },
  body: { ...typography.caption },
  card: {
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
  label: { ...typography.titleSmall },
  hint: { ...typography.caption, fontStyle: 'italic' },
  input: {
    ...typography.body,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  fileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  fileName: { ...typography.caption, fontVariant: ['tabular-nums'] },
  fileSize: { ...typography.caption },
  actions: { gap: spacing.sm },
  button: {
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.min,
  },
  buttonText: { ...typography.body, color: '#fff', fontWeight: '600' },
  // Map view
  mapContainer: { flex: 1 },
  map: { flex: 1 },
  errorBanner: {
    position: 'absolute',
    top: 60,
    left: spacing.lg,
    right: spacing.lg,
    padding: spacing.md,
    borderRadius: radii.md,
  },
  errorText: { ...typography.caption, color: '#c00' },
  backButton: {
    position: 'absolute',
    top: 60,
    left: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.lg,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  backButtonText: { ...typography.body, fontWeight: '600' },
});

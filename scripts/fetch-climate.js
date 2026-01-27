"use strict";
/**
 * Pre-fetch climate data for trail locations at build time.
 *
 * This script queries the Open-Meteo Historical Weather API to get
 * 30-year averages for temperature and precipitation along each trail.
 * Results are saved to data/trails/{trail}/climate.json files which
 * can be committed to the repository.
 *
 * Usage: tsx scripts/fetch-climate.ts [--force] [trail-id]
 *   - With no arguments: processes trails that don't have climate.json
 *   - With --force: re-fetches data even if climate.json already exists
 *   - With trail-id: processes only that trail
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var fs = require("fs");
var path = require("path");
// Handle both Windows and Unix paths from import.meta.url
var SCRIPTS_DIR = path.dirname(process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname);
var PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
var DATA_DIR = path.join(PROJECT_ROOT, 'data/trails');
var GENERATED_DIR = path.join(PROJECT_ROOT, 'public/data/generated');
var CLIMATE_FILENAME = 'climate.json';
var OPEN_METEO_ENDPOINT = 'https://archive-api.open-meteo.com/v1/archive';
var DELAY_BETWEEN_QUERIES_MS = 1000; // Rate limiting
var RATE_LIMIT_RETRY_DELAY_MS = 61000; // Wait 61 seconds on 429 errors
var MAX_RETRIES = 3;
var DATA_START_YEAR = 1994;
var DATA_END_YEAR = 2023;
var RateLimitError = /** @class */ (function (_super) {
    __extends(RateLimitError, _super);
    function RateLimitError(message) {
        var _this = _super.call(this, message) || this;
        _this.name = 'RateLimitError';
        return _this;
    }
    return RateLimitError;
}(Error));
function sleep(ms) {
    return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}
/**
 * Fetch historical climate data from Open-Meteo for a single location.
 * Throws RateLimitError on 429 responses so callers can handle retry logic.
 */
function fetchHistoricalClimate(lat, lon) {
    return __awaiter(this, void 0, void 0, function () {
        var params, url, response, errorText;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    params = new URLSearchParams({
                        latitude: lat.toString(),
                        longitude: lon.toString(),
                        start_date: "".concat(DATA_START_YEAR, "-01-01"),
                        end_date: "".concat(DATA_END_YEAR, "-12-31"),
                        daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
                        timezone: 'auto',
                    });
                    url = "".concat(OPEN_METEO_ENDPOINT, "?").concat(params);
                    return [4 /*yield*/, fetch(url)];
                case 1:
                    response = _a.sent();
                    if (!!response.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, response.text()];
                case 2:
                    errorText = _a.sent();
                    if (response.status === 429) {
                        throw new RateLimitError("Rate limit exceeded: ".concat(errorText.slice(0, 200)));
                    }
                    throw new Error("Open-Meteo API error: ".concat(response.status, " - ").concat(errorText.slice(0, 200)));
                case 3: return [2 /*return*/, response.json()];
            }
        });
    });
}
/**
 * Fetch climate data with automatic retry on rate limit errors.
 */
function fetchWithRetry(lat, lon) {
    return __awaiter(this, void 0, void 0, function () {
        var attempt, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    attempt = 1;
                    _a.label = 1;
                case 1:
                    if (!(attempt <= MAX_RETRIES)) return [3 /*break*/, 7];
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 6]);
                    return [4 /*yield*/, fetchHistoricalClimate(lat, lon)];
                case 3: return [2 /*return*/, _a.sent()];
                case 4:
                    error_1 = _a.sent();
                    if (!(error_1 instanceof RateLimitError)) {
                        throw error_1; // Non-rate-limit errors should propagate immediately
                    }
                    if (attempt === MAX_RETRIES) {
                        throw error_1; // Final attempt failed, propagate the rate limit error
                    }
                    console.log(" rate limited, waiting 60s (attempt ".concat(attempt, "/").concat(MAX_RETRIES, ")..."));
                    return [4 /*yield*/, sleep(RATE_LIMIT_RETRY_DELAY_MS)];
                case 5:
                    _a.sent();
                    process.stdout.write("  Retrying...");
                    return [3 /*break*/, 6];
                case 6:
                    attempt++;
                    return [3 /*break*/, 1];
                case 7: 
                // TypeScript satisfaction - unreachable due to throw in loop
                throw new Error('Max retries exceeded');
            }
        });
    });
}
/**
 * Aggregate daily data into monthly averages.
 */
function aggregateToMonthly(data) {
    var _a = data.daily, time = _a.time, temperature_2m_max = _a.temperature_2m_max, temperature_2m_min = _a.temperature_2m_min, precipitation_sum = _a.precipitation_sum;
    // Group data by month
    var monthlyData = new Map();
    for (var i = 0; i < time.length; i++) {
        var date = new Date(time[i]);
        var month = date.getMonth() + 1; // 1-12
        var year = date.getFullYear();
        if (!monthlyData.has(month)) {
            monthlyData.set(month, {
                tempMaxSum: 0,
                tempMinSum: 0,
                precipSum: 0,
                rainyDays: 0,
                count: 0,
                yearCount: new Set(),
            });
        }
        var entry = monthlyData.get(month);
        var tempMax = temperature_2m_max[i];
        var tempMin = temperature_2m_min[i];
        var precip = precipitation_sum[i];
        // Skip null/undefined values
        if (tempMax != null && tempMin != null) {
            entry.tempMaxSum += tempMax;
            entry.tempMinSum += tempMin;
            entry.count++;
            entry.yearCount.add(year);
        }
        if (precip != null) {
            entry.precipSum += precip;
            if (precip > 1) {
                entry.rainyDays++;
            }
        }
    }
    // Calculate averages
    var monthly = [];
    for (var month = 1; month <= 12; month++) {
        var entry = monthlyData.get(month);
        if (!entry || entry.count === 0) {
            // No data for this month
            monthly.push({
                month: month,
                avgTempMin: 0,
                avgTempMax: 0,
                avgPrecipitation: 0,
                avgRainyDays: 0,
            });
            continue;
        }
        var numYears = entry.yearCount.size;
        monthly.push({
            month: month,
            avgTempMin: Math.round(entry.tempMinSum / entry.count * 10) / 10,
            avgTempMax: Math.round(entry.tempMaxSum / entry.count * 10) / 10,
            avgPrecipitation: Math.round(entry.precipSum / numYears * 10) / 10,
            avgRainyDays: Math.round(entry.rainyDays / numYears * 10) / 10,
        });
    }
    return monthly;
}
/**
 * Find distance along trail for a waypoint by name.
 */
function findWaypointDistance(waypointName, waypoints) {
    var wp = waypoints.find(function (w) {
        return w.name.toLowerCase() === waypointName.toLowerCase();
    });
    if (wp && wp.totalDistance != null) {
        return {
            distance: wp.totalDistance,
            elevation: wp.elevation || 0,
        };
    }
    return null;
}
/**
 * Process a single trail directory - fetch climate data for all configured locations.
 * Saves climate data to data/trails/{trail}/climate.json
 */
function processTrail(trailDir, force) {
    return __awaiter(this, void 0, void 0, function () {
        var trailName, configPath, climatePath, config, waypoints, generatedPath, generated, locations, i, loc, response, monthly, locationData, wpData, error_2, climate;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    trailName = path.basename(trailDir);
                    configPath = path.join(trailDir, 'trail.json');
                    climatePath = path.join(trailDir, CLIMATE_FILENAME);
                    console.log("\nProcessing: ".concat(trailName));
                    // Check if trail.json exists
                    if (!fs.existsSync(configPath)) {
                        console.log('  No trail.json config found. Skipping.');
                        return [2 /*return*/, false];
                    }
                    // Check if climate.json already exists (unless --force is used)
                    if (fs.existsSync(climatePath) && !force) {
                        console.log('  climate.json already exists. Skipping (use --force to re-fetch).');
                        return [2 /*return*/, false];
                    }
                    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                    if (!config.climateLocations || config.climateLocations.length === 0) {
                        console.log('  No climateLocations configured. Skipping.');
                        return [2 /*return*/, false];
                    }
                    console.log("  Found ".concat(config.climateLocations.length, " climate location(s)"));
                    waypoints = [];
                    generatedPath = path.join(GENERATED_DIR, "".concat(config.id, ".json"));
                    if (fs.existsSync(generatedPath)) {
                        try {
                            generated = JSON.parse(fs.readFileSync(generatedPath, 'utf-8'));
                            waypoints = generated.waypoints || [];
                        }
                        catch (_b) {
                            // Ignore errors reading generated file
                        }
                    }
                    locations = [];
                    i = 0;
                    _a.label = 1;
                case 1:
                    if (!(i < config.climateLocations.length)) return [3 /*break*/, 8];
                    loc = config.climateLocations[i];
                    process.stdout.write("  Fetching ".concat(loc.name, "..."));
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, fetchWithRetry(loc.lat, loc.lon)];
                case 3:
                    response = _a.sent();
                    monthly = aggregateToMonthly(response);
                    locationData = {
                        name: loc.name,
                        lat: loc.lat,
                        lon: loc.lon,
                        elevation: response.elevation,
                        monthly: monthly,
                    };
                    // Add distance along trail if waypoint reference exists
                    if (loc.waypointName && waypoints.length > 0) {
                        wpData = findWaypointDistance(loc.waypointName, waypoints);
                        if (wpData) {
                            locationData.distanceAlongTrail = wpData.distance;
                            // Use waypoint elevation if API elevation seems off
                            if (wpData.elevation && Math.abs(wpData.elevation - response.elevation) > 200) {
                                locationData.elevation = wpData.elevation;
                            }
                        }
                    }
                    locations.push(locationData);
                    console.log(' done');
                    return [3 /*break*/, 5];
                case 4:
                    error_2 = _a.sent();
                    console.log(" FAILED: ".concat(error_2 instanceof Error ? error_2.message : 'Unknown error'));
                    return [3 /*break*/, 5];
                case 5:
                    if (!(i < config.climateLocations.length - 1)) return [3 /*break*/, 7];
                    return [4 /*yield*/, sleep(DELAY_BETWEEN_QUERIES_MS)];
                case 6:
                    _a.sent();
                    _a.label = 7;
                case 7:
                    i++;
                    return [3 /*break*/, 1];
                case 8:
                    if (locations.length === 0) {
                        console.log('  No climate data fetched.');
                        return [2 /*return*/, false];
                    }
                    // Sort locations by distance along trail (if available)
                    locations.sort(function (a, b) { return (a.distanceAlongTrail || 0) - (b.distanceAlongTrail || 0); });
                    climate = {
                        generatedAt: new Date().toISOString(),
                        dataYears: { start: DATA_START_YEAR, end: DATA_END_YEAR },
                        locations: locations,
                    };
                    // Save climate data to separate file
                    fs.writeFileSync(climatePath, JSON.stringify(climate, null, 2));
                    console.log("  Saved ".concat(climatePath));
                    // Update trail.json to reference climate file if not already set
                    if (config.climateFile !== CLIMATE_FILENAME) {
                        config.climateFile = CLIMATE_FILENAME;
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                        console.log("  Updated trail.json with climateFile reference");
                    }
                    console.log("  Locations: ".concat(locations.length));
                    return [2 /*return*/, true];
            }
        });
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var args, force, trailArgs, specificTrail, trailDirs, allDirs, matchingDir, updatedCount, i, trailDir, updated, error_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log('Climate Fetch Script');
                    console.log('====================');
                    console.log("Data range: ".concat(DATA_START_YEAR, "-").concat(DATA_END_YEAR));
                    args = process.argv.slice(2);
                    force = args.includes('--force');
                    trailArgs = args.filter(function (arg) { return arg !== '--force'; });
                    specificTrail = trailArgs[0];
                    if (force) {
                        console.log('Force mode: will re-fetch existing climate data');
                    }
                    if (!fs.existsSync(DATA_DIR)) {
                        console.error("\nError: Data directory not found: ".concat(DATA_DIR));
                        process.exit(1);
                    }
                    if (specificTrail) {
                        allDirs = fs.readdirSync(DATA_DIR)
                            .map(function (name) { return path.join(DATA_DIR, name); })
                            .filter(function (p) { return fs.statSync(p).isDirectory(); });
                        matchingDir = allDirs.find(function (dir) {
                            var configPath = path.join(dir, 'trail.json');
                            if (!fs.existsSync(configPath))
                                return false;
                            try {
                                var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                                return config.id === specificTrail;
                            }
                            catch (_a) {
                                return false;
                            }
                        });
                        if (!matchingDir) {
                            console.error("\nError: Trail not found: ".concat(specificTrail));
                            console.error("No trail.json with id=\"".concat(specificTrail, "\" found in ").concat(DATA_DIR));
                            process.exit(1);
                        }
                        trailDirs = [matchingDir];
                    }
                    else {
                        trailDirs = fs.readdirSync(DATA_DIR)
                            .map(function (name) { return path.join(DATA_DIR, name); })
                            .filter(function (p) { return fs.statSync(p).isDirectory(); });
                    }
                    if (trailDirs.length === 0) {
                        console.log('\nNo trail directories found to process.');
                        return [2 /*return*/];
                    }
                    console.log("\nFound ".concat(trailDirs.length, " trail(s) to process."));
                    updatedCount = 0;
                    i = 0;
                    _a.label = 1;
                case 1:
                    if (!(i < trailDirs.length)) return [3 /*break*/, 8];
                    trailDir = trailDirs[i];
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, processTrail(trailDir, force)];
                case 3:
                    updated = _a.sent();
                    if (updated)
                        updatedCount++;
                    return [3 /*break*/, 5];
                case 4:
                    error_3 = _a.sent();
                    console.error("  Error: ".concat(error_3 instanceof Error ? error_3.message : 'Unknown error'));
                    return [3 /*break*/, 5];
                case 5:
                    if (!(i < trailDirs.length - 1)) return [3 /*break*/, 7];
                    return [4 /*yield*/, sleep(DELAY_BETWEEN_QUERIES_MS)];
                case 6:
                    _a.sent();
                    _a.label = 7;
                case 7:
                    i++;
                    return [3 /*break*/, 1];
                case 8:
                    console.log("\n====================");
                    console.log("Done. Updated ".concat(updatedCount, " trail(s) with climate data."));
                    return [2 /*return*/];
            }
        });
    });
}
main().catch(function (error) {
    console.error('Fatal error:', error);
    process.exit(1);
});

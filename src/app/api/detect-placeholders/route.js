import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// ── Helper: sort placeholders in logical display order ─────────────────────
// Title/Heading (no number) → Point 1 → Description 1 → Point 2 → Description 2 …
// Works for any template naming convention.
function sortPlaceholders(placeholders) {
  return [...(placeholders || [])].sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    // Extract trailing number (0 = no number = goes first like Title)
    const numA = parseInt(a.match(/(\d+)/)?.[1] ?? '0', 10);
    const numB = parseInt(b.match(/(\d+)/)?.[1] ?? '0', 10);

    // Items with no number (e.g. {{Title}}, {{Heading}}) always go first
    const aHasNum = /\d/.test(a);
    const bHasNum = /\d/.test(b);

    if (!aHasNum && bHasNum) return -1;
    if (aHasNum && !bHasNum) return 1;

    // Both have numbers — sort by number first
    if (numA !== numB) return numA - numB;

    // Same number — determine which comes first within the pair.
    // "Main" fields (point / option / heading / title / feature / step / name / label)
    // come BEFORE "detail" fields (description / detail / text / subtitle / body / content / sub)
    const isDetail = (ph) => /description|detail|text|subtitle|body|content|sub/i.test(ph);

    const aIsDetail = isDetail(a);
    const bIsDetail = isDetail(b);

    if (!aIsDetail && bIsDetail) return -1;  // a is main, b is detail → a first
    if (aIsDetail && !bIsDetail) return 1;   // a is detail, b is main → b first

    // Both same type — alphabetical fallback
    return a.localeCompare(b);
  });
}

// ── Helper: decide whether a cached entry is actually usable ────────────────
// A cache entry is only trustworthy if:
//   1. It has a non-empty placeholders array, AND
//   2. placeholderMappings exists and has an entry for EVERY placeholder.
// If placeholders and mappings ever diverge (e.g. a half-written cache file,
// or a stale file from a previous version of the detector that built the
// two lists differently), we treat the whole entry as invalid and re-detect
// rather than silently serving a broken result forever.
function isCacheUsable(cachedData) {
  const placeholders = cachedData?.placeholders;
  const mappings      = cachedData?.placeholderMappings;

  const hasPlaceholders = Array.isArray(placeholders) && placeholders.length > 0;
  if (!hasPlaceholders) return false;

  const hasMappings = mappings && typeof mappings === 'object';
  if (!hasMappings) return false;

  // Every placeholder must have a corresponding mapping entry.
  const allMapped = placeholders.every((ph) => Object.prototype.hasOwnProperty.call(mappings, ph));
  return allMapped;
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { templateUrl } = body;

    console.log('🔍 detect-placeholders called with URL:', templateUrl);

    if (!templateUrl) {
      return NextResponse.json({ error: 'Template URL is required' }, { status: 400 });
    }

    try {
      new URL(templateUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid template URL' }, { status: 400 });
    }

    // ── Cache ──────────────────────────────────────────────────────────
    const cacheDir = path.join(process.cwd(), 'public', 'cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    // Bump this whenever detect_placeholders.py's matching/extraction logic
    // changes, so any cache files written before the fix are automatically
    // ignored (rather than silently served forever) and get regenerated once.
    const DETECTOR_VERSION = 'v2-run-merge-fix';

    const cacheKey = crypto
      .createHash('md5')
      .update(templateUrl + DETECTOR_VERSION)
      .digest('hex');
    const cacheFilePath = path.join(cacheDir, `${cacheKey}_detect.json`);

    if (fs.existsSync(cacheFilePath)) {
      try {
        const cachedData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));

        // Reject stale/empty/incomplete cache entries — both "no placeholders"
        // and "placeholders exist but mappings are missing/incomplete" are
        // treated as invalid, so a half-broken cache self-heals instead of
        // being served forever.
        if (!isCacheUsable(cachedData)) {
          console.log('⚠️ Cache invalid (empty or placeholders/mappings mismatch) — deleting and re-detecting');
          fs.unlinkSync(cacheFilePath);
        } else {
          console.log('✅ Returning cached data:', cachedData.placeholders.length, 'placeholders');
          return NextResponse.json({
            ...cachedData,
            placeholders: sortPlaceholders(cachedData.placeholders),
          });
        }
      } catch (err) {
        console.error('Failed to read cache, re-detecting...', err);
        try { fs.unlinkSync(cacheFilePath); } catch {}
      }
    }

    // ── Spawn Python ───────────────────────────────────────────────────
    const scriptPath = path.join(process.cwd(), 'scripts', 'detect_placeholders.py');
    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json({ error: 'Python script not found' }, { status: 500 });
    }

    console.log('🐍 Spawning Python script:', scriptPath);

    // Try python3 first, fall back to python
    const pythonBin = await new Promise((resolve) => {
      const check = spawn('python3', ['--version']);
      check.on('close', (code) => resolve(code === 0 ? 'python3' : 'python'));
      check.on('error', () => resolve('python'));
    });

    console.log('🐍 Using Python binary:', pythonBin);
    const pythonProcess = spawn(pythonBin, [scriptPath]);

    let outputData = '';
    let errorData  = '';

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pythonProcess.kill();
        reject(new Error('Python script timed out after 30 seconds'));
      }, 30000);

      pythonProcess.stdout.on('data', (data) => { outputData += data.toString(); });
      pythonProcess.stderr.on('data', (data) => {
        errorData += data.toString();
        console.log('Python stderr:', data.toString());
      });

      pythonProcess.on('close', (code) => {
        clearTimeout(timeout);
        console.log('🐍 Python exited with code:', code);
        console.log('🐍 Python stdout:', outputData.slice(0, 500));
        if (errorData) console.log('🐍 Python stderr:', errorData.slice(0, 500));

        if (code !== 0) {
          reject(new Error(`Python script exited with code ${code}: ${errorData}`));
        } else {
          try {
            // Find the JSON output even if Python printed extra lines
            const jsonStart = outputData.indexOf('{');
            if (jsonStart === -1) {
              reject(new Error(`No JSON in python output: ${outputData}`));
              return;
            }
            const jsonStr = outputData.substring(jsonStart);
            resolve(JSON.parse(jsonStr));
          } catch (e) {
            reject(new Error(`Failed to parse python output: ${outputData}`));
          }
        }
      });

      pythonProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn python (tried "${pythonBin}"): ${err.message}`));
      });
    });

    pythonProcess.stdin.write(JSON.stringify({ templateUrl }));
    pythonProcess.stdin.end();

    const result = await promise;

    // Surface Python-level errors clearly
    if (!result.success) {
      console.error('❌ Python script returned error:', result.error);
      throw new Error(result.error);
    }

    console.log('✅ Detected placeholders:', result.placeholders);

    // ── Build response ─────────────────────────────────────────────────
    const responseData = {
      fileType:            result.file_type,
      placeholders:        sortPlaceholders(result.placeholders),
      placeholderMappings: result.placeholder_mappings,
      slideWidth:          result.slide_width,
      slideHeight:         result.slide_height,
    };

    // ── Only cache if placeholders AND mappings are both complete ───────
    // Never cache an empty result, and never cache a result where the
    // mappings don't fully cover the placeholders list — either case
    // would permanently (or semi-permanently) break the template's preview.
    if (isCacheUsable(responseData)) {
      try {
        fs.writeFileSync(cacheFilePath, JSON.stringify(responseData), 'utf8');
        console.log('💾 Cached', responseData.placeholders.length, 'placeholders');
      } catch (err) {
        console.error('Failed to write cache:', err);
      }
    } else {
      console.warn('⚠️ No placeholders found, or mappings incomplete — skipping cache write');
    }

    return NextResponse.json(responseData);

  } catch (error) {
    console.error('❌ API Error:', error.message);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
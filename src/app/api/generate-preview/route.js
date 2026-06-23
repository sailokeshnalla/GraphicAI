import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export async function POST(req) {
  try {
    const body = await req.json();
    const { templateUrl, replacements } = body;

    if (!templateUrl) {
      return NextResponse.json({ error: 'Template URL is required' }, { status: 400 });
    }

    const outputDir = path.join(process.cwd(), 'public', 'temp');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const cacheKey      = crypto.createHash('md5').update(templateUrl + JSON.stringify(replacements || {})).digest('hex');
    // Check if slide 1 is already cached — if so, collect all cached slides
    const cachedSlide1  = path.join(outputDir, `${cacheKey}_slide1.jpg`);

    if (fs.existsSync(cachedSlide1)) {
      // Collect however many slides are cached
      const previewUrls = [];
      let i = 1;
      while (fs.existsSync(path.join(outputDir, `${cacheKey}_slide${i}.jpg`))) {
        previewUrls.push(`/api/get-preview-image?id=${cacheKey}_slide${i}.jpg`);
        i++;
      }
      return NextResponse.json({
        previewUrls,
        previewUrl:  previewUrls[0],   // backward compat
        downloadId:  `${cacheKey}.pptx`,
      });
    }

    body.outputDir = outputDir;

    const scriptPath    = path.join(process.cwd(), 'scripts', 'generate_preview.py');
    const pythonProcess = spawn('python', [scriptPath]);

    let outputData = '';
    let errorData  = '';

    const promise = new Promise((resolve, reject) => {
      pythonProcess.stdout.on('data', (data) => { outputData += data.toString(); });
      pythonProcess.stderr.on('data', (data) => { errorData  += data.toString(); });
      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Python script exited with code ${code}: ${errorData}`));
        } else {
          try {
            const jsonStr = outputData.substring(outputData.indexOf('{'));
            resolve(JSON.parse(jsonStr));
          } catch (e) {
            reject(new Error(`Failed to parse python output: ${outputData}\nError: ${errorData}`));
          }
        }
      });
    });

    pythonProcess.stdin.write(JSON.stringify(body));
    pythonProcess.stdin.end();

    const result = await promise;
    if (!result.success) throw new Error(result.error);

    // ── Rename all slide images + pptx to cache keys ─────────────────────
    const previewUrls = [];

    const imgFiles = result.img_files || (result.img_file ? [result.img_file] : []);
    imgFiles.forEach((imgFile, idx) => {
      const slideNum      = idx + 1;
      const originalPath  = path.join(outputDir, imgFile);
      const cachedName    = `${cacheKey}_slide${slideNum}.jpg`;
      const cachedPath    = path.join(outputDir, cachedName);
      try {
        if (fs.existsSync(originalPath)) fs.renameSync(originalPath, cachedPath);
      } catch (err) {
        console.error(`Failed to rename slide ${slideNum}:`, err);
      }
      previewUrls.push(`/api/get-preview-image?id=${cachedName}`);
    });

    // Rename pptx
    try {
      const originalPptxPath = path.join(outputDir, result.pptx_file);
      const newPptxPath      = path.join(outputDir, `${cacheKey}.pptx`);
      if (fs.existsSync(originalPptxPath)) fs.renameSync(originalPptxPath, newPptxPath);
    } catch (err) {
      console.error('Failed to rename pptx:', err);
    }

    return NextResponse.json({
      previewUrls,
      previewUrl:  previewUrls[0] || '',   // backward compat
      downloadId:  `${cacheKey}.pptx`,
    });

  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
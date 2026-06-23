// src/app/api/generate-template/route.js
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// Map each output format to the right MIME type + file extension for the response.
const FORMAT_META = {
  pptx:  { contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  pdf:   { contentType: 'application/pdf', ext: 'pdf' },
  image: { contentType: 'image/jpeg', ext: 'jpg' },
};

export async function POST(request) {
  let result = null;
  try {
    const body = await request.json();
    const { templateUrl, replacements, styling, format } = body;

    if (!templateUrl) {
      return NextResponse.json({ error: 'templateUrl is required' }, { status: 400 });
    }

    // Default to pptx if no format (or an unrecognized one) was supplied.
    const requestedFormat = FORMAT_META[format] ? format : 'pptx';

    const payload = JSON.stringify({
      templateUrl,
      replacements: replacements || {},
      styling:      styling || {},
      format:       requestedFormat,
    });

    result = await new Promise((resolve, reject) => {
      const py = spawn('python', [path.join(process.cwd(), 'scripts', 'replace_pptx.py')]);
      let stdout = '';
      let stderr = '';

      py.stdout.on('data', (d) => { stdout += d.toString(); });
      py.stderr.on('data', (d) => { stderr += d.toString(); });
      py.on('close', (code) => {
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Python parse error: ${stdout} | stderr: ${stderr}`));
        }
      });
      py.on('error', reject);
      py.stdin.write(payload);
      py.stdin.end();
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    const meta = FORMAT_META[result.format] || FORMAT_META.pptx;
    const fileBuffer = fs.readFileSync(result.output_path);

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': meta.contentType,
        'Content-Disposition': `attachment; filename="template.${meta.ext}"`,
      },
    });

  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    // ── Cleanup — remove both the final output file and, when a PDF/Image
    // conversion produced a separate file, the intermediate pptx too. ──────
    if (result?.output_path) {
      try {
        if (fs.existsSync(result.output_path)) {
          fs.unlinkSync(result.output_path);
        }
      } catch (e) {
        console.error('Cleanup error (output_path)', e);
      }
    }
    if (result?.pptx_path && result.pptx_path !== result.output_path) {
      try {
        if (fs.existsSync(result.pptx_path)) {
          fs.unlinkSync(result.pptx_path);
        }
      } catch (e) {
        console.error('Cleanup error (pptx_path)', e);
      }
    }
  }
}
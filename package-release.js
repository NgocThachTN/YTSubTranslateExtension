/**
 * YT ViSub - Local Packaging Script for GitHub Releases
 * Packages the Chrome extension into a clean .zip file in the dist/ folder.
 * Run with: node package-release.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getManifestVersion() {
  const manifestPath = path.join(__dirname, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return manifest.version || '1.0.0';
}

function packageExtension() {
  const version = getManifestVersion();
  const distDir = path.join(__dirname, 'dist');
  const zipFileName = `YTSubTranslateExtension-v${version}.zip`;
  const zipFilePath = path.join(distDir, zipFileName);

  console.log(`[YT ViSub Release] Packaging version v${version}...`);

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  if (fs.existsSync(zipFilePath)) {
    fs.unlinkSync(zipFilePath);
  }

  // Files and directories to include
  const includeItems = [
    'manifest.json',
    'background.js',
    'content.js',
    'content.css',
    'inject.js',
    'popup',
    'icons',
    'README.md',
  ];

  // Temporary staging folder
  const stageDir = path.join(distDir, `staging_v${version}`);
  if (fs.existsSync(stageDir)) {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stageDir, { recursive: true });

  // Copy files to staging
  for (const item of includeItems) {
    const src = path.join(__dirname, item);
    const dest = path.join(stageDir, item);
    if (!fs.existsSync(src)) {
      console.warn(`[YT ViSub Release] Warning: Item not found: ${item}`);
      continue;
    }
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  try {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const psCommand = `powershell -NoProfile -Command "Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipFilePath}' -Force"`;
      execSync(psCommand, { stdio: 'inherit' });
    } else {
      execSync(`cd "${stageDir}" && zip -r "${zipFilePath}" .`, { stdio: 'inherit' });
    }

    // Clean up staging directory
    fs.rmSync(stageDir, { recursive: true, force: true });

    const stats = fs.statSync(zipFilePath);
    const sizeKb = (stats.size / 1024).toFixed(1);
    console.log(`\n========================================`);
    console.log(` SUCCESS: Package created successfully!`);
    console.log(` File: dist/${zipFileName} (${sizeKb} KB)`);
    console.log(` Ready to upload to GitHub Releases:`);
    console.log(` https://github.com/NgocThachTN/YTSubTranslateExtension/releases/new`);
    console.log(`========================================\n`);
  } catch (err) {
    console.error(`[YT ViSub Release] Failed to create zip archive:`, err);
    process.exit(1);
  }
}

packageExtension();

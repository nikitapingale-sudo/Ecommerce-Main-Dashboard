#!/usr/bin/env node
// ============================================================
//  PW Orders Intelligence Hub — MIRROR (Code Backup)
//  File: scripts/mirror.js
//
//  PURPOSE:
//    Creates a complete timestamped mirror/backup of the
//    project source code. Useful before deployments, major
//    changes, or as a scheduled nightly backup.
//
//  USAGE:
//    node scripts/mirror.js                    # backup to ./backups/
//    node scripts/mirror.js --dest /mnt/drive  # custom destination
//    node scripts/mirror.js --tag v1.2.0       # named tag
//    node scripts/mirror.js --clean            # delete backups >30 days
//    node scripts/mirror.js --list             # list existing backups
//
//  SCHEDULE (cron — nightly at midnight):
//    0 0 * * * cd /app && node scripts/mirror.js --clean >> logs/mirror.log 2>&1
// ============================================================

import fs   from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

// ── CLI Args ─────────────────────────────────────────────────
const args    = process.argv.slice(2);
const destArg = args.find(a => a.startsWith('--dest='))?.split('=')[1];
const tagArg  = args.find(a => a.startsWith('--tag='))?.split('=')[1];
const doClean = args.includes('--clean');
const doList  = args.includes('--list');
const verbose = args.includes('--verbose');

const BACKUP_DIR    = path.resolve(destArg || path.join(ROOT, 'backups'));
const KEEP_DAYS     = 30;
const TIMESTAMP     = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BACKUP_NAME   = tagArg
  ? `pw-dashboard_${tagArg}_${TIMESTAMP}`
  : `pw-dashboard_${TIMESTAMP}`;
const BACKUP_PATH   = path.join(BACKUP_DIR, BACKUP_NAME);

// ── Files/Dirs to include in mirror ──────────────────────────
const INCLUDE = [
  'src',
  'public',
  'index.html',
  'vite.config.js',
  'package.json',
  'vercel.json',
  '.env.example',
  '.gitignore',
  'README.md',
  'scripts',
];

// ── Files/Dirs to always EXCLUDE ─────────────────────────────
const EXCLUDE = [
  'node_modules',
  'dist',
  'build',
  '.env',
  '.env.development',
  '.env.production',
  '.env.local',
  'backups',
  'src/data.backup.js',
  'logs',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
];

// ── Logger ───────────────────────────────────────────────────
const log = (msg) => console.log(`[MIRROR ${new Date().toISOString()}] ${msg}`);

// ── Copy helpers ─────────────────────────────────────────────
function shouldExclude(filePath) {
  const rel = path.relative(ROOT, filePath);
  return EXCLUDE.some(excl => {
    if (excl.startsWith('*')) {
      return rel.endsWith(excl.slice(1));
    }
    return rel === excl || rel.startsWith(excl + path.sep) || rel.startsWith(excl + '/');
  });
}

function copyRecursive(src, dest) {
  if (shouldExclude(src)) {
    if (verbose) log(`  ⏭ Skipping: ${path.relative(ROOT, src)}`);
    return { files: 0, bytes: 0 };
  }

  const stat = fs.statSync(src);
  let totalFiles = 0, totalBytes = 0;

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const r = copyRecursive(path.join(src, entry), path.join(dest, entry));
      totalFiles += r.files;
      totalBytes += r.bytes;
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    if (verbose) log(`  ✓ ${path.relative(ROOT, src)}`);
    totalFiles++;
    totalBytes += stat.size;
  }

  return { files: totalFiles, bytes: totalBytes };
}

// ── Write manifest ────────────────────────────────────────────
function writeManifest(backupPath, stats) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let gitHash = 'N/A', gitBranch = 'N/A';
  try {
    gitHash   = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    gitBranch = execSync('git branch --show-current', { cwd: ROOT }).toString().trim();
  } catch {}

  const manifest = {
    name:       BACKUP_NAME,
    createdAt:  new Date().toISOString(),
    tag:        tagArg || null,
    appVersion: pkg.version,
    gitHash,
    gitBranch,
    totalFiles: stats.files,
    totalBytes: stats.bytes,
    totalKB:    (stats.bytes / 1024).toFixed(1),
    source:     ROOT,
    destination: backupPath,
    included:   INCLUDE,
    excluded:   EXCLUDE,
  };

  fs.writeFileSync(
    path.join(backupPath, 'MIRROR_MANIFEST.json'),
    JSON.stringify(manifest, null, 2)
  );
  return manifest;
}

// ── List backups ──────────────────────────────────────────────
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) {
    log('No backups directory found.');
    return;
  }
  const entries = fs.readdirSync(BACKUP_DIR)
    .filter(e => fs.statSync(path.join(BACKUP_DIR, e)).isDirectory())
    .map(e => {
      const manifestPath = path.join(BACKUP_DIR, e, 'MIRROR_MANIFEST.json');
      if (!fs.existsSync(manifestPath)) return { name: e, size: '?' };
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return { name: e, size: m.totalKB + ' KB', files: m.totalFiles, created: m.createdAt, tag: m.tag };
    });

  log(`📋 Backups in ${BACKUP_DIR} (${entries.length} total):`);
  entries.forEach(e => log(`  ${e.name}  [${e.size}, ${e.files} files, ${e.created}]`));
}

// ── Clean old backups ─────────────────────────────────────────
function cleanOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
  const dirs = fs.readdirSync(BACKUP_DIR).filter(e => fs.statSync(path.join(BACKUP_DIR, e)).isDirectory());
  let removed = 0;
  dirs.forEach(dir => {
    const mPath = path.join(BACKUP_DIR, dir, 'MIRROR_MANIFEST.json');
    if (!fs.existsSync(mPath)) return;
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    if (new Date(m.createdAt).getTime() < cutoff) {
      fs.rmSync(path.join(BACKUP_DIR, dir), { recursive: true });
      log(`🗑 Removed old backup: ${dir}`);
      removed++;
    }
  });
  log(`🧹 Cleaned ${removed} old backup(s) older than ${KEEP_DAYS} days.`);
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  if (doList)  { listBackups();  return; }
  if (doClean) cleanOldBackups();

  log(`🪞 Mirror starting → ${BACKUP_PATH}`);
  fs.mkdirSync(BACKUP_PATH, { recursive: true });

  let totalFiles = 0, totalBytes = 0;

  for (const item of INCLUDE) {
    const srcPath = path.join(ROOT, item);
    if (!fs.existsSync(srcPath)) {
      log(`⚠ Not found, skipping: ${item}`);
      continue;
    }
    const destPath = path.join(BACKUP_PATH, item);
    log(`📂 Copying: ${item}`);
    const r = copyRecursive(srcPath, destPath);
    totalFiles += r.files;
    totalBytes += r.bytes;
  }

  const manifest = writeManifest(BACKUP_PATH, { files: totalFiles, bytes: totalBytes });
  log(`📋 Manifest written: MIRROR_MANIFEST.json`);
  log(`✅ Mirror complete!`);
  log(`   Files:  ${totalFiles}`);
  log(`   Size:   ${(totalBytes / 1024).toFixed(1)} KB`);
  log(`   Dest:   ${BACKUP_PATH}`);
  log(`   Git:    ${manifest.gitBranch}@${manifest.gitHash}`);
}

main().catch(err => {
  console.error(`[MIRROR] ❌ Fatal: ${err.message}`);
  process.exit(1);
});

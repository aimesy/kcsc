#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";

const GIB = 1024 * 1024 * 1024;
const DEFAULT_REPO = "aimesy/nysc-data";
const DEFAULT_MAX_ARCHIVE_BYTES = GIB;

function valueAfter(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= argv.length) throw new Error(`${name} requires a value`);
  return argv[index + 1];
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function utcId(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function usage() {
  console.log(`Usage:
  node scripts/archive_raw_release.mjs --source-root DIR --include-root RELATIVE [options]

Creates an immutable, checksum-verified GitHub Release backup. Source files are
never modified or deleted.

Options:
  --source-root DIR        Root used for archive paths
  --include-root RELATIVE  File subtree below source root to archive
  --repo OWNER/REPO        Release repository, default ${DEFAULT_REPO}
  --github-token-file FILE GitHub token file
  --snapshot-prefix NAME   Prefix for snapshot IDs and default release tag
  --tag TAG                Release tag, default raw-webcivil-YYYY-MM-DD
  --state-file FILE        Incremental backup state; unchanged files are skipped
  --staging-dir DIR        Temporary archive directory
  --vault-dir DIR          Retain verified compressed archives locally in DIR
  --metadata-dir DIR       Write compact release metadata here after verification
  --min-age-ms N           Skip files newer than N milliseconds, default 1800000
  --max-archive-bytes N    Refuse a single archive larger than N bytes, default ${DEFAULT_MAX_ARCHIVE_BYTES}
  --keep-staging           Retain compressed local staging files after verification
  --dry-run                Inventory candidates without writing or uploading
`);
}

function resolveInside(root, relative, label) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative || ".");
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`${label} escapes source root: ${relative}`);
  }
  return target;
}

function parseArgs(argv) {
  if (hasFlag(argv, "-h") || hasFlag(argv, "--help")) {
    usage();
    process.exit(0);
  }
  const sourceRoot = valueAfter(argv, "--source-root");
  const includeRoot = valueAfter(argv, "--include-root");
  if (!sourceRoot || !includeRoot) {
    usage();
    throw new Error("--source-root and --include-root are required");
  }
  const now = new Date();
  const snapshotPrefix = valueAfter(argv, "--snapshot-prefix", "raw-webcivil").replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!snapshotPrefix) throw new Error("--snapshot-prefix must contain letters or numbers");
  const stagingDir = path.resolve(valueAfter(argv, "--staging-dir", path.join(os.tmpdir(), "nysc-raw-release-staging")));
  const maxArchiveBytes = Number(valueAfter(argv, "--max-archive-bytes", String(DEFAULT_MAX_ARCHIVE_BYTES)));
  const minAgeMs = Number(valueAfter(argv, "--min-age-ms", "1800000"));
  if (!Number.isFinite(maxArchiveBytes) || maxArchiveBytes <= 0) throw new Error("--max-archive-bytes must be positive");
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) throw new Error("--min-age-ms must be nonnegative");
  const args = {
    sourceRoot: path.resolve(sourceRoot),
    includeRoot: includeRoot.replace(/^[/\\]+/, "").replace(/\\/g, "/"),
    repo: valueAfter(argv, "--repo", DEFAULT_REPO),
    tokenFile: valueAfter(argv, "--github-token-file", process.env.NYSC_GITHUB_TOKEN_FILE || ""),
    tag: valueAfter(argv, "--tag", `${snapshotPrefix}-${utcDay(now)}`),
    stateFile: valueAfter(argv, "--state-file", ""),
    stagingDir,
    vaultDir: valueAfter(argv, "--vault-dir", ""),
    metadataDir: valueAfter(argv, "--metadata-dir", ""),
    minAgeMs,
    maxArchiveBytes,
    keepStaging: hasFlag(argv, "--keep-staging"),
    dryRun: hasFlag(argv, "--dry-run"),
    snapshotId: `${snapshotPrefix}-${utcId(now)}`,
  };
  args.selectionRoot = resolveInside(args.sourceRoot, args.includeRoot, "include root");
  if (!fs.existsSync(args.selectionRoot)) throw new Error(`include root does not exist: ${args.selectionRoot}`);
  if (!args.dryRun && !args.tokenFile) throw new Error("--github-token-file or NYSC_GITHUB_TOKEN_FILE is required");
  return args;
}

function log(message) {
  process.stdout.write(`[nysc-raw-release] ${message}\n`);
}

function readState(file) {
  if (!file || !fs.existsSync(file)) return { schema: "nysc-raw-release-state/v1", files: {} };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || parsed.schema !== "nysc-raw-release-state/v1" || typeof parsed.files !== "object") {
    throw new Error(`invalid release state: ${file}`);
  }
  return parsed;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files.sort();
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  let bytesLen = 0;
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) {
    hash.update(chunk);
    bytesLen += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytesLen };
}

async function collectCandidates(args, state) {
  const now = Date.now();
  const candidates = [];
  let skippedYoung = 0;
  let skippedKnown = 0;
  for (const file of walkFiles(args.selectionRoot)) {
    const stat = fs.statSync(file);
    if (args.minAgeMs && now - stat.mtimeMs < args.minAgeMs) {
      skippedYoung += 1;
      continue;
    }
    const relative = path.relative(args.sourceRoot, file).replace(/\\/g, "/");
    const known = state.files[relative];
    if (known && known.bytes_len === stat.size && known.mtime_ms === stat.mtimeMs) {
      skippedKnown += 1;
      continue;
    }
    const digest = await sha256File(file);
    if (digest.bytesLen !== stat.size) throw new Error(`source changed while hashing: ${relative}`);
    candidates.push({
      file,
      relative,
      bytes_len: digest.bytesLen,
      sha256: digest.sha256,
      mtime_ms: stat.mtimeMs,
    });
  }
  return { candidates, skippedYoung, skippedKnown };
}

function verifyCandidatesUnchanged(candidates) {
  for (const candidate of candidates) {
    const stat = fs.statSync(candidate.file);
    if (stat.size !== candidate.bytes_len || stat.mtimeMs !== candidate.mtime_ms) {
      throw new Error(`source changed after inventory: ${candidate.relative}`);
    }
  }
}

function waitForProcess(child, name, capture = false) {
  let stderr = "";
  let stdout = "";
  if (capture) {
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
  }
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${name} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function tarZstd(args, listFile, outputFile = "") {
  const tar = spawn("tar", [
    "--directory", args.sourceRoot,
    "--hard-dereference",
    "--no-recursion",
    "--null",
    "--verbatim-files-from",
    "--files-from", listFile,
    "--create",
    "--file", "-",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const zstd = spawn("zstd", ["-q", "-T1", "-3", "-c"], { stdio: ["pipe", "pipe", "pipe"] });
  tar.stdout.pipe(zstd.stdin);
  if (!outputFile) {
    let bytes = 0;
    zstd.stdout.on("data", (chunk) => { bytes += chunk.length; });
    zstd.stdout.resume();
    await Promise.all([waitForProcess(tar, "tar"), waitForProcess(zstd, "zstd")]);
    return bytes;
  }
  const output = fs.createWriteStream(outputFile, { flags: "wx" });
  zstd.stdout.pipe(output);
  await Promise.all([waitForProcess(tar, "tar"), waitForProcess(zstd, "zstd"), finished(output)]);
  return fs.statSync(outputFile).size;
}

async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ["ignore", options.capture ? "pipe" : "ignore", "pipe"],
  });
  return waitForProcess(child, command, Boolean(options.capture));
}

async function ensureRelease(args, token) {
  const env = { ...process.env, GH_TOKEN: token };
  try {
    await runCommand("gh", ["release", "view", args.tag, "--repo", args.repo, "--json", "tagName"], { env, capture: true });
    return;
  } catch (error) {
    if (!/not found|HTTP 404|release not found/i.test(error.message || "")) throw error;
  }
  await runCommand("gh", [
    "release", "create", args.tag,
    "--repo", args.repo,
    "--title", args.tag,
    "--notes", "Immutable, checksum-verified NYSC raw WebCivil capture archive. Source files remain retained locally.",
  ], { env, capture: true });
}

async function releaseAssets(args, token) {
  const env = { ...process.env, GH_TOKEN: token };
  const result = await runCommand("gh", ["release", "view", args.tag, "--repo", args.repo, "--json", "assets"], { env, capture: true });
  const parsed = JSON.parse(result.stdout || "{}");
  return Array.isArray(parsed.assets) ? parsed.assets : [];
}

async function uploadAssets(args, token, files) {
  const env = { ...process.env, GH_TOKEN: token };
  await runCommand("gh", ["release", "upload", args.tag, ...files, "--repo", args.repo], { env, capture: true });
}

async function hashUrl(url) {
  const response = await fetch(url, { headers: { "User-Agent": "nysc-raw-release" } });
  if (!response.ok) throw new Error(`release download failed: HTTP ${response.status}`);
  const hash = crypto.createHash("sha256");
  let bytesLen = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    hash.update(buffer);
    bytesLen += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytesLen };
}

async function verifyArchiveContents(archiveFile, candidates) {
  const tar = spawn("tar", [
    "--use-compress-program=zstd",
    "--extract",
    "--to-stdout",
    "--file", archiveFile,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let index = 0;
  let bytesRead = 0;
  let hash = crypto.createHash("sha256");
  let failure = "";
  const finishEmpty = () => {
    while (index < candidates.length && candidates[index].bytes_len === 0) {
      const digest = hash.digest("hex");
      if (digest !== candidates[index].sha256) {
        failure = `archive checksum mismatch for ${candidates[index].relative}`;
        return;
      }
      index += 1;
      bytesRead = 0;
      hash = crypto.createHash("sha256");
    }
  };
  finishEmpty();
  tar.stdout.on("data", (chunk) => {
    let offset = 0;
    while (!failure && offset < chunk.length) {
      if (index >= candidates.length) {
        failure = "archive contains bytes beyond the manifest";
        return;
      }
      const candidate = candidates[index];
      const remaining = candidate.bytes_len - bytesRead;
      const take = Math.min(remaining, chunk.length - offset);
      if (take) {
        hash.update(chunk.subarray(offset, offset + take));
        bytesRead += take;
        offset += take;
      }
      if (bytesRead === candidate.bytes_len) {
        const digest = hash.digest("hex");
        if (digest !== candidate.sha256) {
          failure = `archive checksum mismatch for ${candidate.relative}`;
          return;
        }
        index += 1;
        bytesRead = 0;
        hash = crypto.createHash("sha256");
        finishEmpty();
      }
    }
  });
  await waitForProcess(tar, "tar");
  if (failure) throw new Error(failure);
  if (index !== candidates.length || bytesRead !== 0) {
    throw new Error(`archive ended before manifest entry ${index + 1}`);
  }
}

function retainVerifiedAssets(args, workDir, archiveFile, manifestCompressed, verification) {
  if (!args.vaultDir) return "";
  const vaultDir = path.resolve(args.vaultDir, args.snapshotId);
  fs.mkdirSync(vaultDir, { recursive: true });
  for (const source of [archiveFile, manifestCompressed]) {
    const destination = path.join(vaultDir, path.basename(source));
    if (fs.existsSync(destination)) throw new Error(`local vault asset already exists: ${destination}`);
    fs.renameSync(source, destination);
  }
  writeJsonAtomic(path.join(vaultDir, "verification.json"), verification);
  fs.rmSync(workDir, { recursive: true, force: true });
  return vaultDir;
}

function availableBytes(dir) {
  const stat = fs.statfsSync(dir);
  return Number(stat.bavail) * Number(stat.bsize);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = readState(args.stateFile);
  const inventory = await collectCandidates(args, state);
  const candidateBytes = inventory.candidates.reduce((sum, row) => sum + row.bytes_len, 0);
  const summary = {
    schema: "nysc-raw-release-summary/v1",
    snapshot_id: args.snapshotId,
    source_root: args.sourceRoot,
    include_root: args.includeRoot,
    candidates: inventory.candidates.length,
    candidate_bytes: candidateBytes,
    candidate_gib: Number((candidateBytes / GIB).toFixed(3)),
    skipped_young: inventory.skippedYoung,
    skipped_known: inventory.skippedKnown,
    dry_run: args.dryRun,
  };
  if (!inventory.candidates.length || args.dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const token = fs.readFileSync(args.tokenFile, "utf8").trim();
  if (!token) throw new Error(`empty GitHub token file: ${args.tokenFile}`);
  const workDir = path.join(args.stagingDir, args.snapshotId);
  fs.mkdirSync(workDir, { recursive: true });
  const listFile = path.join(workDir, "files.list");
  const manifestFile = path.join(workDir, `${args.snapshotId}.manifest.ndjson`);
  const manifestAsset = `${args.snapshotId}.manifest.ndjson.zst`;
  const archiveAsset = `${args.snapshotId}.tar.zst`;
  const archiveFile = path.join(workDir, archiveAsset);
  const manifestCompressed = path.join(workDir, manifestAsset);
  fs.writeFileSync(listFile, inventory.candidates.map((row) => row.relative).join("\0") + "\0", "utf8");
  const archivedAt = new Date().toISOString();
  fs.writeFileSync(manifestFile, inventory.candidates.map((row) => JSON.stringify({
    schema: "nysc-raw-release-file/v1",
    snapshot_id: args.snapshotId,
    archived_at: archivedAt,
    archive_path: row.relative,
    bytes_len: row.bytes_len,
    sha256: row.sha256,
    mtime_ms: row.mtime_ms,
  })).join("\n") + "\n", "utf8");

  log(`estimating compressed archive for ${inventory.candidates.length} files`);
  verifyCandidatesUnchanged(inventory.candidates);
  const estimatedBytes = await tarZstd(args, listFile);
  summary.estimated_archive_bytes = estimatedBytes;
  if (estimatedBytes > args.maxArchiveBytes) {
    throw new Error(`estimated archive ${estimatedBytes} exceeds configured limit ${args.maxArchiveBytes}`);
  }
  if (estimatedBytes + GIB > availableBytes(args.stagingDir)) {
    throw new Error("insufficient staging capacity for the verified archive");
  }

  log(`creating ${archiveAsset}`);
  verifyCandidatesUnchanged(inventory.candidates);
  const archiveBytes = await tarZstd(args, listFile, archiveFile);
  if (archiveBytes !== estimatedBytes) throw new Error(`archive size changed during creation: ${estimatedBytes} -> ${archiveBytes}`);
  await runCommand("zstd", ["-q", "-t", "--", archiveFile]);
  await runCommand("tar", ["--use-compress-program=zstd", "--list", "--file", archiveFile]);
  await verifyArchiveContents(archiveFile, inventory.candidates);
  await runCommand("zstd", ["-q", "-3", "-f", "-o", manifestCompressed, "--", manifestFile]);
  const archiveHash = await sha256File(archiveFile);
  const manifestHash = await sha256File(manifestCompressed);

  await ensureRelease(args, token);
  await uploadAssets(args, token, [archiveFile, manifestCompressed]);
  const assets = await releaseAssets(args, token);
  const verified = {};
  for (const expected of [
    { name: archiveAsset, hash: archiveHash },
    { name: manifestAsset, hash: manifestHash },
  ]) {
    const asset = assets.find((row) => row.name === expected.name);
    if (!asset || Number(asset.size) !== expected.hash.bytesLen || !asset.url) {
      throw new Error(`release asset verification failed for ${expected.name}`);
    }
    const remote = await hashUrl(asset.url);
    if (remote.bytesLen !== expected.hash.bytesLen || remote.sha256 !== expected.hash.sha256) {
      throw new Error(`remote hash mismatch for ${expected.name}`);
    }
    verified[expected.name] = { bytes_len: remote.bytesLen, sha256: remote.sha256, url: asset.url };
  }

  if (args.metadataDir) {
    const metadata = {
      schema: "nysc-raw-release-snapshot/v1",
      snapshot_id: args.snapshotId,
      archived_at: archivedAt,
      github_repo: args.repo,
      release_tag: args.tag,
      source_root: args.sourceRoot,
      include_root: args.includeRoot,
      source_file_count: inventory.candidates.length,
      source_bytes_len: candidateBytes,
      compression: "zstd",
      archive: { asset_name: archiveAsset, ...verified[archiveAsset] },
      manifest: { asset_name: manifestAsset, ...verified[manifestAsset] },
      restore_command: `gh release download ${args.tag} --repo ${args.repo} --pattern ${archiveAsset} --dir <destination> && zstd -d <destination>/${archiveAsset} -c | tar -xf - -C <restore-root>`,
    };
    writeJsonAtomic(path.join(args.metadataDir, `${args.snapshotId}.json`), metadata);
  }

  const vaultDir = retainVerifiedAssets(args, workDir, archiveFile, manifestCompressed, {
    schema: "nysc-raw-release-vault/v1",
    snapshot_id: args.snapshotId,
    release_tag: args.tag,
    verified_at: new Date().toISOString(),
    source_file_count: inventory.candidates.length,
    source_bytes_len: candidateBytes,
    archive: { asset_name: archiveAsset, ...verified[archiveAsset] },
    manifest: { asset_name: manifestAsset, ...verified[manifestAsset] },
    archive_contents_verified: true,
  });

  if (args.stateFile) {
    for (const row of inventory.candidates) {
      state.files[row.relative] = {
        bytes_len: row.bytes_len,
        sha256: row.sha256,
        mtime_ms: row.mtime_ms,
        archived_at: archivedAt,
        snapshot_id: args.snapshotId,
        release_tag: args.tag,
        archive_asset: archiveAsset,
        manifest_asset: manifestAsset,
        vault_dir: vaultDir,
      };
    }
    state.updated_at = archivedAt;
    writeJsonAtomic(args.stateFile, state);
  }
  summary.release_tag = args.tag;
  summary.archive = verified[archiveAsset];
  summary.manifest = verified[manifestAsset];
  summary.verified = true;
  summary.vault_dir = vaultDir;
  if (!vaultDir && !args.keepStaging) fs.rmSync(workDir, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

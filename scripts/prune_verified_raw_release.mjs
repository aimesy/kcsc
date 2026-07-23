#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function valueAfter(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= argv.length) throw new Error(`${name} requires a value`);
  return argv[index + 1];
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function resolveInside(root, relative, label) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative || ".");
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`${label} escapes source root: ${relative}`);
  return target;
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
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    bytesLen += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytesLen };
}

async function hashUrl(url) {
  const response = await fetch(url, { headers: { "User-Agent": "nysc-raw-release-pruner" } });
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

function usage() {
  console.log(`Usage:
  node scripts/prune_verified_raw_release.mjs --source-root DIR --include-root RELATIVE --state-file FILE [options]

Only removes a file when its current bytes match a locally retained, manifest-
verified release asset and that GitHub asset can be downloaded with the same hash.

Options:
  --min-age-ms N       Minimum source age before pruning, default 604800000
  --apply              Actually delete eligible source files; default is dry-run
  --record-dir DIR     Write a compressed deletion audit record
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) return usage();
  const sourceRoot = path.resolve(valueAfter(argv, "--source-root"));
  const includeRoot = valueAfter(argv, "--include-root");
  const stateFile = valueAfter(argv, "--state-file");
  const minAgeMs = Number(valueAfter(argv, "--min-age-ms", "604800000"));
  const apply = hasFlag(argv, "--apply");
  const recordDir = valueAfter(argv, "--record-dir");
  if (!sourceRoot || !includeRoot || !stateFile || !Number.isFinite(minAgeMs) || minAgeMs < 0) {
    usage();
    throw new Error("--source-root, --include-root, and --state-file are required");
  }
  const selectionRoot = resolveInside(sourceRoot, includeRoot, "include root");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (!state || typeof state.files !== "object") throw new Error(`invalid release state: ${stateFile}`);
  const vaults = new Map();
  for (const entry of Object.values(state.files)) {
    if (!entry || !entry.vault_dir || !entry.archive_asset || !entry.manifest_asset) continue;
    const key = `${entry.vault_dir}\u0000${entry.archive_asset}`;
    if (!vaults.has(key)) vaults.set(key, entry);
  }
  for (const entry of vaults.values()) {
    const verificationPath = path.join(entry.vault_dir, "verification.json");
    const verification = JSON.parse(fs.readFileSync(verificationPath, "utf8"));
    if (!verification.archive_contents_verified || verification.archive.asset_name !== entry.archive_asset) {
      throw new Error(`invalid local vault verification: ${verificationPath}`);
    }
    for (const asset of [verification.archive, verification.manifest]) {
      const local = await sha256File(path.join(entry.vault_dir, asset.asset_name));
      if (local.sha256 !== asset.sha256 || local.bytesLen !== asset.bytes_len) {
        throw new Error(`local vault hash mismatch: ${path.join(entry.vault_dir, asset.asset_name)}`);
      }
      const remote = await hashUrl(asset.url);
      if (remote.sha256 !== asset.sha256 || remote.bytesLen !== asset.bytes_len) {
        throw new Error(`GitHub release hash mismatch: ${asset.asset_name}`);
      }
    }
  }

  const now = Date.now();
  const removed = [];
  let skippedYoung = 0;
  let skippedUnarchived = 0;
  let skippedChanged = 0;
  for (const file of walkFiles(selectionRoot)) {
    const stat = fs.statSync(file);
    if (now - stat.mtimeMs < minAgeMs) {
      skippedYoung += 1;
      continue;
    }
    const relative = path.relative(sourceRoot, file).replace(/\\/g, "/");
    const entry = state.files[relative];
    if (!entry || !entry.vault_dir) {
      skippedUnarchived += 1;
      continue;
    }
    if (entry.bytes_len !== stat.size || entry.mtime_ms !== stat.mtimeMs) {
      skippedChanged += 1;
      continue;
    }
    const current = await sha256File(file);
    if (current.sha256 !== entry.sha256 || current.bytesLen !== entry.bytes_len) {
      skippedChanged += 1;
      continue;
    }
    removed.push({ path: relative, bytes_len: current.bytesLen, sha256: current.sha256, snapshot_id: entry.snapshot_id, archive_asset: entry.archive_asset });
    if (apply) fs.unlinkSync(file);
  }
  if (apply) {
    const directories = [];
    const stack = [selectionRoot];
    while (stack.length) {
      const dir = stack.pop();
      directories.push(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
    for (const dir of directories.sort((a, b) => b.length - a.length)) {
      if (dir === selectionRoot) continue;
      try {
        fs.rmdirSync(dir);
      } catch (error) {
        if (error && error.code !== "ENOTEMPTY") throw error;
      }
    }
  }
  const summary = {
    schema: "nysc-raw-release-prune/v1",
    applied: apply,
    at: new Date().toISOString(),
    source_root: sourceRoot,
    include_root: includeRoot,
    eligible: removed.length,
    eligible_bytes_len: removed.reduce((sum, row) => sum + row.bytes_len, 0),
    skipped_young: skippedYoung,
    skipped_unarchived: skippedUnarchived,
    skipped_changed: skippedChanged,
  };
  if (recordDir) {
    fs.mkdirSync(recordDir, { recursive: true });
    const id = summary.at.replace(/[-:.]/g, "").replace("Z", "Z");
    const record = path.join(recordDir, `raw-release-prune-${id}.ndjson`);
    fs.writeFileSync(record, removed.map((row) => JSON.stringify(row)).join("\n") + (removed.length ? "\n" : ""));
    const { spawnSync } = await import("node:child_process");
    const compressed = `${record}.zst`;
    const proc = spawnSync("zstd", ["-q", "-3", "-f", "-o", compressed, "--", record]);
    if (proc.status !== 0) throw new Error("could not compress prune audit record");
    fs.rmSync(record);
    fs.writeFileSync(path.join(recordDir, `raw-release-prune-${id}.json`), JSON.stringify({ ...summary, audit_record: compressed }, null, 2) + "\n");
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

/**
 * Schema security tests — validates that every table in schema.sql has RLS enabled.
 *
 * Motivation: CVE-2025-48757 and the Supabase RLS misconfiguration wave (2025-2026)
 * showed that forgetting to enable RLS on even one table can expose all its data
 * via the public anon key. This test catches that at CI time.
 *
 * Usage:
 *   node tests/test_schema_security.js
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

// ═══════════════════════════════════════════════════════════════════════
// RLS Coverage — every CREATE TABLE must have a matching ENABLE RLS
// ═══════════════════════════════════════════════════════════════════════

section('Row Level Security coverage');

const schemaPath = path.join(__dirname, '..', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf-8');

// Extract all table names from CREATE TABLE statements
const createTableRegex = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g;
const tables = [];
let match;
while ((match = createTableRegex.exec(schema)) !== null) {
  tables.push(match[1]);
}

// Extract all table names from ENABLE ROW LEVEL SECURITY statements
const rlsRegex = /ALTER TABLE (\w+)\s+ENABLE ROW LEVEL SECURITY/g;
const rlsTables = new Set();
while ((match = rlsRegex.exec(schema)) !== null) {
  rlsTables.add(match[1]);
}

console.log(`  Found ${tables.length} tables, ${rlsTables.size} with RLS enabled`);

assert(tables.length > 0, 'Schema should contain at least one table');
assert(tables.length === rlsTables.size,
  `Every table should have RLS enabled: ${tables.length} tables vs ${rlsTables.size} RLS statements`);

// Check each table individually for clear error messages
for (const table of tables) {
  assert(rlsTables.has(table),
    `Table '${table}' is missing ENABLE ROW LEVEL SECURITY — data exposed via anon key!`);
}

// ═══════════════════════════════════════════════════════════════════════
// JWT algorithm restriction — verify all jwt.verify calls specify algorithms
// ═══════════════════════════════════════════════════════════════════════

section('JWT algorithm confusion protection (CVE-2026-22817)');

const appServerDir = path.join(__dirname, '..', '..', 'peerzero-app', 'packages', 'server', 'src');

if (fs.existsSync(appServerDir)) {
  function findTsFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '__tests__') {
        results.push(...findTsFiles(fullPath));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const tsFiles = findTsFiles(appServerDir);
  const jwtVerifyRegex = /jwt\.verify\([^)]+\)/g;
  const algorithmRegex = /algorithms\s*:/;
  let totalCalls = 0;
  let unsafeCalls = [];

  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('jwt.verify(')) {
        totalCalls++;
        // Check this line and the next few for algorithms option
        const context = lines.slice(i, i + 3).join(' ');
        if (!algorithmRegex.test(context)) {
          const relPath = path.relative(path.join(__dirname, '..', '..'), file);
          unsafeCalls.push(`${relPath}:${i + 1}`);
        }
      }
    }
  }

  if (totalCalls > 0) {
    console.log(`  Found ${totalCalls} jwt.verify() calls in app server`);
    assert(unsafeCalls.length === 0,
      `jwt.verify() without algorithms restriction at: ${unsafeCalls.join(', ')}`);
  } else {
    console.log('  No jwt.verify() calls found (skipping)');
  }
} else {
  console.log('  peerzero-app not found (skipping JWT check)');
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);

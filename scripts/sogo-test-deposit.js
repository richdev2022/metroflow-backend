#!/usr/bin/env node
/* TEST-ONLY script — Sogo sandbox deposit simulator.
 *
 * The owner directive: POST /v1/crypto/test-deposit is a SANDBOX testing tool.
 * It must NEVER be an app surface. Use this script against sandbox keys
 * (sogo_sk_test_...) to exercise the webhook matching + customer
 * reconciliation pipeline end-to-end.
 *
 * Usage:
 *   SOGO_SECRET_KEY=sogo_sk_test_xxx node scripts/sogo-test-deposit.js \
 *     --asset usdt --network trc20 --amount 100 --ref SANDBOX-TEST-1234
 *
 * Outcome control (last 4 chars of --ref):
 *   *0000 → held for compliance review (stays pending, no webhook)
 *   *9999 → stuck pending (no webhook)
 *   other → completed (transaction.completed webhook fired)
 * NOTE: returns 403 on live keys — that is expected and correct.
 */
const path = require('path');
const fs = require('fs');

// Load .env without dependencies.
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = (process.argv[i] || '').replace(/^--/, '');
  args[key] = process.argv[i + 1];
}

const base = (process.env.SOGO_BASE_URL || (String(process.env.SOGO_SECRET_KEY || '').startsWith('sogo_sk_test_') ? 'https://sandbox.sogo.africa/v1' : 'https://api.sogo.africa/v1'));
const asset = args.asset || 'usdt';
const network = args.network || 'trc20';
const amount = Number(args.amount || 100);
const testRef = args.ref || `SANDBOX-TEST-${Date.now()}`;

(async () => {
  if (String(process.env.SOGO_SECRET_KEY || '').startsWith('sogo_sk_live_') && !base.includes('sandbox')) {
    console.error('REFUSING: this simulator is sandbox-only (403 on live keys). Point SOGO_BASE_URL at the sandbox or use sandbox keys.');
    process.exit(1);
  }
  const https = require('https');
  const body = JSON.stringify({ asset, network, crypto_amount: amount, test_reference: testRef });
  const url = new URL(base.replace(/\/+$/, '') + '/crypto/test-deposit');
  const req = https.request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SOGO_SECRET_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 30000,
  }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      console.log(`HTTP ${res.statusCode}`);
      try { console.log(JSON.stringify(JSON.parse(data), null, 2)); } catch { console.log(data); }
    });
  });
  req.on('error', (e) => { console.error('REQUEST FAILED:', e.message); process.exit(1); });
  req.write(body);
  req.end();
})();

import pg from "pg";

// NEVER hardcode credentials — pass the connection string via env:
//   DATABASE_URL="postgresql://..." node scripts/forensic_403_transaction_limits.mjs
const cs = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
if (!cs) {
  console.error(
    "Missing DATABASE_URL env var. Usage:\n" +
      '  DATABASE_URL="postgresql://..." node scripts/forensic_403_transaction_limits.mjs'
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: cs, connectionTimeoutMillis: 30000 });
await client.connect();

const q = async (sql, params = []) => {
  const r = await client.query(sql, params);
  return r.rows;
};

// 1. Who hit transaction-limits recently?
const hits = await q(
  `SELECT created_at, method, path, status_code, user_type, user_id, ip, user_agent
     FROM api_request_logs
    WHERE path ILIKE '%transaction-limits%'
    ORDER BY created_at DESC
    LIMIT 15`
);
console.log("=== /transaction-limits hits (last 15) ===");
for (const h of hits) {
  console.log(
    `${h.created_at?.toISOString?.() || h.created_at} | ${h.method} ${h.status_code} | ${h.user_type}/${h.user_id || "-"} | ip=${h.ip} | ua=${(h.user_agent || "").slice(0, 90)}`
  );
}
if (!hits.length) console.log("(no rows — retention or path mismatch)");

// 2. Identity of the admin(s) involved, if any
const adminIds = [...new Set(hits.filter((h) => h.user_id).map((h) => h.user_id))];
if (adminIds.length) {
  const admins = await q(
    `SELECT a.id, a.email, r.name AS role, r.is_super_admin
       FROM platform_admins a LEFT JOIN admin_roles r ON a.role_id = r.id
      WHERE a.id = ANY($1::uuid[])`,
    [adminIds]
  );
  console.log("\n=== involved admins ===");
  for (const a of admins)
    console.log(`${a.id} | ${a.email} | role=${a.role} | super=${a.is_super_admin}`);

  // 3. Does that role have manage_businesses?
  const perms = await q(
    `SELECT a.id AS admin_id, COALESCE(array_agg(p.slug) FILTER (WHERE p.slug IS NOT NULL), '{}') AS perms
       FROM platform_admins a
       LEFT JOIN admin_roles r ON a.role_id = r.id
       LEFT JOIN admin_role_permissions arp ON r.id = arp.role_id
       LEFT JOIN admin_permissions p ON arp.permission_id = p.id
      WHERE a.id = ANY($1::uuid[])
      GROUP BY a.id`,
    [adminIds]
  );
  console.log("\n=== admin permissions ===");
  for (const p of perms)
    console.log(`${p.admin_id} | manage_businesses=${p.perms.includes("manage_businesses")} | all=[${p.perms.join(",")}]`);
}

// 4. Context: other recent 4xx from the same IP(s) — scanner or human?
const ips = [...new Set(hits.map((h) => h.ip).filter(Boolean))].slice(0, 5);
if (ips.length) {
  const ctx = await q(
    `SELECT ip, status_code, method, path, user_agent, COUNT(*) AS n, MAX(created_at) AS last
       FROM api_request_logs
      WHERE ip = ANY($1::text[]) AND status_code >= 400
        AND created_at > NOW() - INTERVAL '48 hours'
      GROUP BY ip, status_code, method, path, user_agent
      ORDER BY n DESC LIMIT 25`,
    [ips]
  );
  console.log("\n=== recent 4xx activity from the same IP(s) (48h) ===");
  for (const c of ctx)
    console.log(`${c.ip} | ${c.n}x ${c.method} ${c.status_code} ${c.path} | ua=${(c.user_agent || "").slice(0, 60)} | last=${c.last?.toISOString?.() || c.last}`);
}

await client.end();

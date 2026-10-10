import pg from "pg";

const cs = process.env.DATABASE_URL;
if (!cs) { console.error("Missing DATABASE_URL"); process.exit(1); }
const client = new pg.Client({ connectionString: cs, connectionTimeoutMillis: 30000 });
await client.connect();

const userId = process.argv[2] || "2db7ce81-d8da-41f6-8a82-dfecb213f36b";

const { rows } = await client.query(
  `SELECT cc.id, cc.type, cc.name, cc.created_at,
          (SELECT COUNT(*) FROM chat_participants cp WHERE cp.conversation_id = cc.id) AS participant_rows,
          (SELECT COUNT(*) FROM chat_participants cp WHERE cp.conversation_id = cc.id AND cp.user_id IS NULL) AS null_user_rows,
          (SELECT COUNT(*) FROM chat_messages cm WHERE cm.conversation_id = cc.id) AS message_count,
          (SELECT BOOL_OR(cp.hidden_at IS NOT NULL) FROM chat_participants cp WHERE cp.conversation_id = cc.id AND cp.user_id = $1) AS i_am_hidden
   FROM chat_conversations cc
   WHERE EXISTS (SELECT 1 FROM chat_participants cp WHERE cp.conversation_id = cc.id AND cp.user_id = $1)
   ORDER BY cc.updated_at DESC
   LIMIT 40`,
  [userId],
);

console.log(`conversations for user ${userId}: ${rows.length}`);
for (const r of rows) {
  console.log(
    `${r.type || "direct"} | parts=${r.participant_rows} (nullUser=${r.null_user_rows}) | msgs=${r.message_count} | iAmHidden=${r.i_am_hidden} | ${String(r.name || "").slice(0, 24)} | ${r.created_at?.toISOString?.().slice(0, 10)}`,
  );
}

// How many direct conversations of this user have <2 participant rows (the filter's victims)?
const { rows: filtered } = await client.query(
  `SELECT cc.id, cc.name,
          (SELECT COUNT(*) FROM chat_participants cp WHERE cp.conversation_id = cc.id) AS participant_rows,
          (SELECT COUNT(*) FROM chat_messages cm WHERE cm.conversation_id = cc.id) AS message_count
   FROM chat_conversations cc
   WHERE EXISTS (SELECT 1 FROM chat_participants cp WHERE cp.conversation_id = cc.id AND cp.user_id = $1)
     AND COALESCE(cc.type, 'direct') = 'direct'
     AND (SELECT COUNT(*) FROM chat_participants cp WHERE cp.conversation_id = cc.id) < 2
   ORDER BY cc.updated_at DESC
   LIMIT 20`,
  [userId],
);
console.log(`\nDIRECT conversations that the <2-participant filter hides: ${filtered.length}`);
for (const r of filtered) console.log(`- parts=${r.participant_rows} msgs=${r.message_count} ${String(r.name || "").slice(0, 30)} ${r.id}`);

await client.end();

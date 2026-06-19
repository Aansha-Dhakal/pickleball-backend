const express  = require('express');
const sqlite3  = require('sqlite3').verbose();
const cors     = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── DATABASE ──────────────────────────────────────────────────────
const db = new sqlite3.Database('./pickleball.db', (err) => {
  if (err) console.error('❌ DB error:', err.message);
  else console.log('✅ Connected to pickleball.db');
});

db.serialize(() => {
  // Create table with user_id column
  db.run(`
    CREATE TABLE IF NOT EXISTS pickleball_telemetry (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             TEXT    NOT NULL DEFAULT 'anonymous',
      match_id            TEXT    NOT NULL,
      timestamp           TEXT    NOT NULL,
      difficulty          TEXT    NOT NULL,
      event_type          TEXT    NOT NULL,
      striker_or_culprit  TEXT    NOT NULL DEFAULT 'NONE',
      shot_type           TEXT    NOT NULL DEFAULT 'NONE',
      fault_reason        TEXT    NOT NULL DEFAULT 'NONE',
      pos_x               REAL,
      pos_y               REAL,
      pos_z               REAL,
      ball_speed          REAL,
      reaction_time_ms    INTEGER
    )
  `, (err) => {
    if (err) console.error('❌ Table error:', err.message);
    else {
      console.log('✅ Table ready: pickleball_telemetry');
      // Add user_id column if upgrading existing db
      db.run(`ALTER TABLE pickleball_telemetry ADD COLUMN user_id TEXT NOT NULL DEFAULT 'anonymous'`,
        () => {} // ignore error if column already exists
      );
    }
  });
});

// ── ROUTES ────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: '🏓 Pickleball Data Server running' });
});

// POST /api/log-telemetry
app.post('/api/log-telemetry', (req, res) => {
  const { user_id = 'anonymous', match_id, difficulty, telemetry_events } = req.body;

  if (!match_id || !difficulty || !Array.isArray(telemetry_events) || !telemetry_events.length) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const timestamp = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO pickleball_telemetry (
      user_id, match_id, timestamp, difficulty,
      event_type, striker_or_culprit, shot_type, fault_reason,
      pos_x, pos_y, pos_z, ball_speed, reaction_time_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    telemetry_events.forEach((e) => {
      const v = e.ball_speed ?? (e.vx !== undefined
        ? Math.sqrt((e.vx||0)**2 + (e.vy||0)**2 + (e.vz||0)**2)
        : null);
      stmt.run(
        user_id, match_id, timestamp, difficulty,
        e.event_type || 'UNKNOWN',
        e.striker_or_culprit || 'NONE',
        e.shot_type  || 'NONE',
        e.fault_reason || 'NONE',
        e.pos_x ?? null, e.pos_y ?? null, e.pos_z ?? null,
        v, e.reaction_time_ms ?? null
      );
    });
    db.run('COMMIT', (err) => {
      if (err) return res.status(500).json({ error: 'Failed to save' });
      stmt.finalize();
      console.log(`✅ Saved ${telemetry_events.length} events for ${user_id}/${match_id}`);
      res.json({ message: `Logged ${telemetry_events.length} events`, match_id, user_id });
    });
  });
});

// GET /api/matches?user_id=xxx  — list matches for a specific user
app.get('/api/matches', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  db.all(`
    SELECT
      user_id, match_id, difficulty,
      MIN(timestamp) AS played_at,
      COUNT(*) AS total_events,
      SUM(CASE WHEN event_type='SHOT'  THEN 1 ELSE 0 END) AS total_shots,
      SUM(CASE WHEN event_type='FAULT' THEN 1 ELSE 0 END) AS total_faults,
      AVG(CASE WHEN reaction_time_ms IS NOT NULL THEN reaction_time_ms END) AS avg_reaction_ms
    FROM pickleball_telemetry
    WHERE user_id = ?
    GROUP BY match_id
    ORDER BY played_at DESC
  `, [user_id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// GET /api/match/:match_id?user_id=xxx
app.get('/api/match/:match_id', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  db.all(
    'SELECT * FROM pickleball_telemetry WHERE match_id=? AND user_id=? ORDER BY id ASC',
    [req.params.match_id, user_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!rows.length) return res.status(404).json({ error: 'Match not found' });
      res.json(rows);
    }
  );
});

// GET /api/export-csv?user_id=xxx&match_id=xxx (match_id optional)
app.get('/api/export-csv', (req, res) => {
  const { user_id, match_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  let query = 'SELECT * FROM pickleball_telemetry WHERE user_id=?';
  const params = [user_id];
  if (match_id) { query += ' AND match_id=?'; params.push(match_id); }
  query += ' ORDER BY id ASC';

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows?.length) return res.status(404).send('No data found');

    const headers = Object.keys(rows[0]).join(',');
    const lines   = rows.map(row =>
      Object.values(row).map(v => {
        if (v == null) return '';
        if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
        return v;
      }).join(',')
    );

    const filename = match_id
      ? `pkl_${user_id}_${match_id}.csv`
      : `pkl_${user_id}_all.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send([headers, ...lines].join('\n'));
  });
});

// ── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🏓 Server running on http://localhost:${PORT}`);
  console.log('  POST /api/log-telemetry');
  console.log('  GET  /api/matches?user_id=xxx');
  console.log('  GET  /api/match/:id?user_id=xxx');
  console.log('  GET  /api/export-csv?user_id=xxx\n');
});

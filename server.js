const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// DATABASE SETUP
// ─────────────────────────────────────────────

const db = new sqlite3.Database('./pickleball.db', (err) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
  } else {
    console.log('✅ Connected to SQLite database: pickleball.db');
  }
});

// Create the flat telemetry table on startup
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS pickleball_telemetry (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
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
    if (err) {
      console.error('❌ Table creation error:', err.message);
    } else {
      console.log('✅ Table ready: pickleball_telemetry');
    }
  });
});

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Pickleball Data Server is running 🏓' });
});

// POST /api/log-telemetry
// Receives the full match telemetry array at game-over and saves every event
app.post('/api/log-telemetry', (req, res) => {
  const { match_id, difficulty, telemetry_events } = req.body;

  if (!match_id || !difficulty || !Array.isArray(telemetry_events) || telemetry_events.length === 0) {
    return res.status(400).json({ error: 'Invalid payload. Required: match_id, difficulty, telemetry_events[]' });
  }

  const timestamp = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO pickleball_telemetry (
      match_id, timestamp, difficulty,
      event_type, striker_or_culprit, shot_type, fault_reason,
      pos_x, pos_y, pos_z, ball_speed, reaction_time_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    telemetry_events.forEach((event) => {
      // Calculate ball speed from velocity vector if not already provided
      const speed = event.ball_speed !== undefined
        ? event.ball_speed
        : (event.vx !== undefined
            ? Math.sqrt(
                Math.pow(event.vx || 0, 2) +
                Math.pow(event.vy || 0, 2) +
                Math.pow(event.vz || 0, 2)
              )
            : null);

      stmt.run(
        match_id,
        timestamp,
        difficulty,
        event.event_type          || 'UNKNOWN',
        event.striker_or_culprit  || 'NONE',
        event.shot_type           || 'NONE',
        event.fault_reason        || 'NONE',
        event.pos_x               ?? null,
        event.pos_y               ?? null,
        event.pos_z               ?? null,
        speed,
        event.reaction_time_ms    ?? null
      );
    });

    db.run('COMMIT', (err) => {
      if (err) {
        console.error('❌ Transaction error:', err.message);
        return res.status(500).json({ error: 'Failed to save telemetry data.' });
      }
      stmt.finalize();
      console.log(`✅ Saved ${telemetry_events.length} events for match: ${match_id}`);
      res.json({
        message: `Successfully logged ${telemetry_events.length} events.`,
        match_id,
      });
    });
  });
});

// GET /api/export-csv
// Exports the full telemetry table as a downloadable CSV file
app.get('/api/export-csv', (req, res) => {
  const { match_id } = req.query;

  let query = 'SELECT * FROM pickleball_telemetry';
  const params = [];

  // Optional: filter by a specific match
  if (match_id) {
    query += ' WHERE match_id = ?';
    params.push(match_id);
  }

  query += ' ORDER BY id ASC';

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!rows || rows.length === 0) {
      return res.status(404).send('No telemetry data found.');
    }

    // Build CSV headers from column names
    const headers = Object.keys(rows[0]).join(',');

    // Build CSV rows — wrap strings containing commas in quotes
    const csvLines = rows.map((row) =>
      Object.values(row).map((val) => {
        if (val === null || val === undefined) return '';
        if (typeof val === 'string' && val.includes(',')) return `"${val}"`;
        return val;
      }).join(',')
    );

    const csvContent = [headers, ...csvLines].join('\n');

    const filename = match_id
      ? `pickleball_match_${match_id}.csv`
      : 'pickleball_all_matches.csv';

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.status(200).send(csvContent);
    console.log(`✅ CSV exported: ${rows.length} rows`);
  });
});

// GET /api/matches
// Returns a list of all unique match IDs and their summary stats
app.get('/api/matches', (req, res) => {
  db.all(`
    SELECT
      match_id,
      difficulty,
      MIN(timestamp) AS played_at,
      COUNT(*) AS total_events,
      SUM(CASE WHEN event_type = 'SHOT' THEN 1 ELSE 0 END) AS total_shots,
      SUM(CASE WHEN event_type = 'FAULT' THEN 1 ELSE 0 END) AS total_faults,
      AVG(CASE WHEN reaction_time_ms IS NOT NULL THEN reaction_time_ms END) AS avg_reaction_ms
    FROM pickleball_telemetry
    GROUP BY match_id
    ORDER BY played_at DESC
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// GET /api/match/:match_id
// Returns all telemetry events for one specific match
app.get('/api/match/:match_id', (req, res) => {
  db.all(
    'SELECT * FROM pickleball_telemetry WHERE match_id = ? ORDER BY id ASC',
    [req.params.match_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!rows.length) return res.status(404).json({ error: 'Match not found.' });
      res.json(rows);
    }
  );
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🏓 Pickleball Data Server running on http://localhost:${PORT}`);
  console.log(`   POST /api/log-telemetry  → save match events`);
  console.log(`   GET  /api/export-csv     → download full CSV`);
  console.log(`   GET  /api/matches        → list all matches`);
  console.log(`   GET  /api/match/:id      → get one match's events\n`);
});

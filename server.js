const express = require('express');
const https = require('https');
const Database = require('better-sqlite3');

const app = express();
const db = new Database('mydata.db');

app.use(express.static('public'));
app.use(express.json());

// ── Database setup ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    points INTEGER NOT NULL,
    language TEXT NOT NULL,
    total_questions INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// ── Items ────────────────────────────────────────────────────────
app.get('/api/items', (req, res) => {
  const items = db.prepare('SELECT * FROM items').all();
  res.json(items);
});

app.post('/api/items', (req, res) => {
  const { name } = req.body;
  const result = db.prepare('INSERT INTO items (name) VALUES (?)').run(name);
  res.json({ id: result.lastInsertRowid, name });
});

// ── Users ────────────────────────────────────────────────────────
app.post('/api/users', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const clean = name.trim();

  let user = db.prepare('SELECT * FROM users WHERE name = ?').get(clean);
  if (!user) {
    const result = db.prepare('INSERT INTO users (name) VALUES (?)').run(clean);
    user = { id: result.lastInsertRowid, name: clean };
  }
  res.json(user);
});

// ── Scores ───────────────────────────────────────────────────────
app.post('/api/scores', (req, res) => {
  const { user_id, points, language, total_questions } = req.body;
  if (!user_id || points == null || !language || !total_questions) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const result = db.prepare(
    'INSERT INTO scores (user_id, points, language, total_questions) VALUES (?, ?, ?, ?)'
  ).run(user_id, points, language, total_questions);
  res.json({ id: result.lastInsertRowid });
});

// ── Leaderboard ──────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const lang = req.query.language || 'spanish';
  const rows = db.prepare(`
    SELECT u.name, MAX(s.points) as best_score, s.total_questions,
           COUNT(s.id) as games_played
    FROM scores s
    JOIN users u ON u.id = s.user_id
    WHERE s.language = ?
    GROUP BY s.user_id
    ORDER BY best_score DESC, games_played ASC
    LIMIT 10
  `).all(lang);
  res.json(rows);
});

// ── Words ────────────────────────────────────────────────────────

// Large pool of common English words — shuffled each request so
// every game feels different. Free Dictionary API validates them,
// MyMemory translates with strict checks.
const WORD_POOL = [
  'apple','bread','water','house','chair','table','river','cloud','stone','light',
  'flower','paper','glass','clock','sugar','music','dream','smile','voice',
  'forest','beach','mountain','garden','bridge','window','mirror','candle','letter',
  'market','coffee','butter','cheese','orange','lemon','grape','peach','cherry',
  'rabbit','horse','eagle','shark','tiger','dolphin','parrot','turtle','spider',
  'summer','winter','spring','morning','evening','shadow','thunder','silver','golden',
  'simple','gentle','strong','silent','ancient','modern','narrow','hollow','frozen',
  'travel','return','follow','gather','listen','whisper','discover','remember','wonder',
  'friend','family','village','teacher','student','doctor','artist','sailor','hunter',
  'purple','yellow','crimson','copper','wooden','cotton','velvet','marble'
];

const LANG_CODES = {
  spanish: 'es',
  french:  'fr',
  italian: 'it',
};

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Confirm the word exists in the Free Dictionary API
async function isValidWord(word) {
  try {
    const data = await fetchJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

// Translate via MyMemory with strict validation
async function translateWord(word, langCode) {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|${langCode}`;
    const data = await fetchJSON(url);
    const result = data?.responseData?.translatedText;

    if (!result) return null;

    const cleaned = result.trim();

    // Reject if any of these are true:
    if (cleaned.toLowerCase() === word.toLowerCase()) return null; // not translated
    if (cleaned === cleaned.toUpperCase()) return null;            // ALL CAPS = error
    if (cleaned.includes('MYMEMORY')) return null;                 // error string
    if (cleaned.includes(' ')) return null;                        // phrase not word
    if (!/^[a-zA-ZÀ-ÿ'-]+$/.test(cleaned)) return null;          // junk characters

    return cleaned.toLowerCase();
  } catch {
    return null;
  }
}

app.get('/api/words', async (req, res) => {
  const { language } = req.query;
  const langCode = LANG_CODES[language];
  if (!langCode) return res.status(400).json({ error: 'Unsupported language' });

  // Shuffle the pool and work through it until we have 10 good pairs
  const shuffled = [...WORD_POOL].sort(() => Math.random() - 0.5);
  const pairs = [];

  for (const word of shuffled) {
    if (pairs.length >= 10) break;

    const valid = await isValidWord(word);
    if (!valid) continue;

    const translation = await translateWord(word, langCode);
    if (!translation) continue;

    pairs.push({ word, translation });
  }

  if (pairs.length < 4) {
    return res.status(500).json({ error: 'Could not fetch enough words, please try again.' });
  }

  res.json(pairs);
});

// ── Start ────────────────────────────────────────────────────────
app.listen(3000, () => console.log('Server running on http://localhost:3000'));
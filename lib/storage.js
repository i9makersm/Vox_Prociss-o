import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

export function createStorage({ dataDir, databaseUrl }) {
  if (databaseUrl) return createPostgresStorage(databaseUrl);
  return createFileStorage(dataDir);
}

function createFileStorage(dataDir) {
  const eventsFile = `${dataDir}/events.json`;

  return {
    description: eventsFile,
    async init() {
      fs.mkdirSync(dataDir, { recursive: true });
      if (!fs.existsSync(eventsFile)) {
        fs.writeFileSync(eventsFile, '[]');
      }
    },
    async loadEvents() {
      if (!fs.existsSync(eventsFile)) return [];
      return JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
    },
    async saveEvent(event) {
      const events = await this.loadEvents();
      const index = events.findIndex(item => item.id === event.id);
      if (index >= 0) events[index] = event;
      else events.push(event);
      fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));
    }
  };
}

function createPostgresStorage(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
  });

  return {
    description: 'postgres',
    async init() {
      await pool.query(`
        create table if not exists events (
          id text primary key,
          payload jsonb not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `);
    },
    async loadEvents() {
      const result = await pool.query('select payload from events order by created_at asc');
      return result.rows.map(row => row.payload);
    },
    async saveEvent(event) {
      await pool.query(
        `
          insert into events (id, payload, updated_at)
          values ($1, $2, now())
          on conflict (id)
          do update set payload = excluded.payload, updated_at = now()
        `,
        [event.id, event]
      );
    }
  };
}

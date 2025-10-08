import pkg from "pg";
import "dotenv/config";

const { Pool } = pkg;

// Create a new pool using the DATABASE_URL from .env
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // required for Supabase/AWS/Render
  },
  max: 10,                   // max connections in pool
  idleTimeoutMillis: 30000,  // close idle clients after 30s
  connectionTimeoutMillis: 10000, // fail if connection not established in 10s
  keepAlive: true,           // keep TCP connection alive
});

// Optional: test connection when server starts
pool.connect()
  .then(client => {
    console.log("✅ Connected to PostgreSQL (Supabase)");
    client.release();
  })
  .catch(err => {
    console.error("❌ DB connection error:", err.message);
  });

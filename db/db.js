// db/db.js
import pkg from "pg";
import "dotenv/config";

const { Pool } = pkg;

// Create a new pool using the DATABASE_URL from .env
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // required for Supabase/AWS
  },
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

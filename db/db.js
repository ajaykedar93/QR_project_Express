// db/db.js
import pkg from "pg";
import "dotenv/config";

const { Pool } = pkg;


export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, 
  },
});


pool.connect()
  .then(client => {
    console.log("✅ Connected to PostgreSQL (Supabase)");
    client.release();
  })
  .catch(err => {
    console.error("❌ DB connection error:", err.message);
  });

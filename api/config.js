/* Public runtime config. The anon key is safe to expose: row level security
   is what protects the data. When these are unset the page runs in local mode. */
'use strict';
const { json } = require('./_lib');

module.exports = async (req, res) => {
  json(res, 200, {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    serverAI: !!process.env.ANTHROPIC_API_KEY
  });
};

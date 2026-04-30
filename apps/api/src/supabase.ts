import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { isSupabaseConfigured } from './config';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }

  if (!_client) {
    const { supabaseUrl, supabaseServiceRoleKey } = require('./config').config;
    _client = createClient(supabaseUrl, supabaseServiceRoleKey);
  }

  return _client;
}

export async function testSupabaseConnection(): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  try {
    const { error } = await client.from('research_runs').select('id').limit(1);
    return !error || error.code === 'PGRST116'; // PGRST116 = empty result, which is fine
  } catch {
    return false;
  }
}

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const BUCKET = 'wedding-ar';

export const configError =
  !url || !key || url.includes('YOUR-PROJECT') || key.includes('YOUR-ANON')
    ? 'Supabase is not configured. Copy .env.example to .env.local and fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart.'
    : null;

export const supabase = configError ? null : createClient(url, key);

export const publicUrl = (path) => supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

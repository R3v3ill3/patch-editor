import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

// Allow build to succeed with empty env vars (static pages).
// At runtime in the browser, the env vars must be set.
export const supabase: SupabaseClient = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : (new Proxy({} as SupabaseClient, {
      get(_, prop) {
        if (prop === 'auth') {
          return {
            getUser: async () => ({ data: { user: null }, error: null }),
            signInWithPassword: async () => ({ data: null, error: new Error('Supabase not configured') }),
            signOut: async () => ({ error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
          };
        }
        if (prop === 'from') {
          return () => ({
            select: () => ({ eq: () => ({ eq: () => ({ data: [], error: null }), is: () => ({ data: [], error: null }), single: () => ({ data: null, error: null }), data: [], error: null }), data: [], error: null }),
            insert: async () => ({ error: new Error('Supabase not configured') }),
            update: () => ({ eq: async () => ({ error: new Error('Supabase not configured') }) }),
            delete: () => ({ eq: async () => ({ error: new Error('Supabase not configured') }) }),
          });
        }
        if (prop === 'rpc') {
          return async () => ({ data: null, error: new Error('Supabase not configured') });
        }
        return undefined;
      },
    }));

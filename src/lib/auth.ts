import { supabase } from './supabase';
import type { AppUser } from '@/types';

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentUser(): Promise<AppUser | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // Fetch profile for role and name
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role')
    .eq('id', user.id)
    .single();

  return {
    id: user.id,
    email: user.email ?? '',
    fullName: profile?.full_name ?? null,
    role: profile?.role ?? null,
  };
}

export function isAdmin(user: AppUser | null): boolean {
  return user?.role === 'admin';
}

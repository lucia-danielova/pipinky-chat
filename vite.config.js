import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ command, mode }) => {
  if (command === 'build') {
    const env = loadEnv(mode, process.cwd(), 'VITE_');
    if (!env.VITE_SUPABASE_URL?.trim() || !env.VITE_SUPABASE_ANON_KEY?.trim() ||
      env.VITE_SUPABASE_ANON_KEY.trim() === 'replace-with-supabase-publishable-key') {
      throw new Error('Doplň VITE_SUPABASE_URL a VITE_SUPABASE_ANON_KEY v .env.local pred zostavením.');
    }
  }
  return { base: './' };
});

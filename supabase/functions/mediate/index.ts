import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization) {
    return jsonResponse({ error: 'Prihlás sa do chatu.' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !geminiApiKey) {
    console.error('Required Edge Function configuration is missing.');
    return jsonResponse({ error: 'Mediátor nie je nakonfigurovaný.' }, 500);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const accessToken = authorization.replace(/^Bearer\s+/i, '');
  const { data: userData, error: authError } = await userClient.auth.getUser(accessToken);
  if (authError || !userData.user) {
    return jsonResponse({ error: 'Prihlás sa do chatu.' }, 401);
  }

  const { data: messages, error: messagesError } = await userClient
    .from('chat_messages')
    .select('sender_name, message')
    .order('id', { ascending: false })
    .limit(40);

  if (messagesError || !messages?.length) {
    return jsonResponse({ error: 'V chate zatiaľ nie sú žiadne správy.' }, 400);
  }

  try {
    const history = messages.reverse()
      .map((item) => `${item.sender_name}: ${item.message}`)
      .join('\n');
    const geminiResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiApiKey,
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Si neutrálny a empatický mediátor v slovenskom jazyku. Stručne poraď, ako môžu účastníci komunikovať konštruktívne a bez hádok. Nepredstieraj, že poznáš celý kontext.\n\nKonverzácia:\n${history}`,
            }],
          }],
          generationConfig: { maxOutputTokens: 1024 },
        }),
      },
    );

    if (!geminiResponse.ok) {
      console.error('Gemini request failed with status', geminiResponse.status);
      return jsonResponse({ error: 'Mediátor momentálne neodpovedá. Skús neskôr.' }, 502);
    }

    const payload = await geminiResponse.json();
    const answer = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof answer !== 'string' || !answer.trim()) {
      return jsonResponse({ error: 'Mediátor nevrátil odpoveď. Skús neskôr.' }, 502);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: insertError } = await adminClient.from('chat_messages').insert({
      sender_id: null,
      sender_name: 'Mediátor',
      message: answer.trim(),
      is_mediator: true,
    });
    if (insertError) {
      console.error('Could not store mediator response:', insertError.message);
      return jsonResponse({ error: 'Odpoveď mediátora sa nepodarilo uložiť.' }, 500);
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    console.error('Mediator request failed:', error);
    return jsonResponse({ error: 'Mediátor momentálne neodpovedá. Skús neskôr.' }, 502);
  }
});

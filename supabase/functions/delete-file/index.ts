// ---------------------------------------------------------------------------
// delete-file — the ONLY destructive operation in the app.
// Calls the transactional delete_logical_file() RPC, which decrements the
// blob's ref_count through a trigger and removes the blob row once it reaches
// zero. The stored object is removed from Supabase Storage only when the blob
// was actually freed. Shared blobs (ref_count > 0) keep their bytes.
// ---------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const BUCKET = "files";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: "unauthorized" }, 401);

    const { fileId } = await req.json();
    if (!fileId || typeof fileId !== "string") {
      return json({ error: "missing fileId" }, 400);
    }

    const { data, error } = await supabase.rpc("delete_logical_file", {
      p_file_id: fileId,
    });
    if (error) return json({ error: error.message }, 500);

    const result = data as {
      deleted: boolean;
      blob_deleted: boolean;
      storage_path: string | null;
    };

    if (result.blob_deleted && result.storage_path) {
      const { error: removeError } = await supabase.storage
        .from(BUCKET)
        .remove([result.storage_path]);
      if (removeError) {
        // The logical rows are already gone; surface the storage problem but
        // do not fail the whole request.
        return json({ ...result, storage_warning: removeError.message });
      }
    }

    return json(result);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});

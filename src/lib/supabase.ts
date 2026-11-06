/**
 * The connection to the online account service (Supabase). The key below is the public
 * "publishable" key: it's meant to be in the page. What each person can see is enforced by the
 * database itself (row-level security), so they only ever reach their own charts.
 */
import { createClient } from "@supabase/supabase-js";

const URL = "https://fnykcgmqrpwxrvdngccj.supabase.co";
const KEY = "sb_publishable_zYr4xOMO3XilKpr5Y_M_dQ_b36t9OUe";

export const supabase = createClient(URL, KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

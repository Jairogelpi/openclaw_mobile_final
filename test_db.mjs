import supabase from './config/supabase.mjs';
async function test() {
    const { data: souls, error } = await supabase.from('user_souls').select('soul_json').order('last_updated', { ascending: false }).limit(3);
    console.log(JSON.stringify(souls, null, 2));
}
test();

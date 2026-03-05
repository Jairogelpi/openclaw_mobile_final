const fs = require('fs');
fs.writeFileSync('pm2_env_dump.txt', 
  'SUPABASE_URL: ' + process.env.SUPABASE_URL + '\n' +
  'SUPABASE_SERVICE_ROLE_KEY: ' + (process.env.SUPABASE_SERVICE_ROLE_KEY ? process.env.SUPABASE_SERVICE_ROLE_KEY.substring(0, 10) : 'none')
);
console.log("Env dumped to pm2_env_dump.txt");

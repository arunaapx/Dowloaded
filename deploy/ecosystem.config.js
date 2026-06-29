// PM2 process config for the Velox VPS.
//
//   pm2 start deploy/ecosystem.config.js
//   pm2 save && pm2 startup        # restart on reboot
//
// The license + extraction server is the one the Windows thin client needs.
// The web PWA is optional (an all-device, full-server-side fallback).

module.exports = {
  apps: [
    {
      name: 'velox-license',
      cwd: __dirname + '/../server',
      script: 'server.js',
      instances: 1,            // single instance: usage caps + JWT secret are in-process
      autorestart: true,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        PORT: '4000',
        // Everything else (ADMIN_PASS, JWT_SECRET, caps…) comes from server/.env
      },
    },
    {
      name: 'velox-web',       // optional PWA — remove this block if you only ship the Windows app
      cwd: __dirname + '/../web',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        WEB_PORT: '8080',
        VELOX_MAX_CONCURRENT: '3',
      },
    },
  ],
};

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
      // The Rust licence server. Started only by deploy/cutover-to-rust.sh, which
      // stops the Node one first: both want port 4010, and pm2 starting this
      // while Node is up would leave a process that cannot bind.
      //
      // Localhost on purpose. nginx proxies from 127.0.0.1, and the port being
      // open to the internet means the licence API is reachable in the clear,
      // around nginx and its limits.
      name: 'velox-license-rs',
      // The server directory, because that is where .env is: the binary reads it
      // from the working directory the same way the Node server does, and the
      // admin password, the internal token and the caps all live in that one
      // file. Nothing else here depends on the working directory - the paths
      // below are absolute.
      cwd: __dirname + '/../server',
      script: __dirname + '/../server-rs/target/release/velox-license',
      interpreter: 'none',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: '4010',
        BIND_ADDR: '127.0.0.1',
        // The same directory the Node server uses: the same token secret, so a
        // token minted before the cutover is still good after it, and the JSON
        // ledger stays beside the database as what a rollback returns to.
        DATA_DIR: __dirname + '/../server/data',
        PUBLIC_DIR: __dirname + '/../server/public',
        // Everything else (ADMIN_PASS, caps, the internal token…) comes from
        // server/.env, which the binary reads the same way the Node server does.
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

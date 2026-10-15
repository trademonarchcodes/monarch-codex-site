#!/usr/bin/env node
'use strict';

// Safe deployment preflight. Never prints passwords, session secrets, or encryption keys.
const mysql = require('mysql2/promise');

const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missing = required.filter((name) => !process.env[name] || !String(process.env[name]).trim());

if (missing.length) {
  console.error('[DB CHECK] FAIL: missing required environment variable(s): ' + missing.join(', '));
  console.error('[DB CHECK] Set these in the hosting environment. Do not put credentials in Git or chat.');
  process.exit(2);
}

const config = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectTimeout: 10000,
  charset: 'utf8mb4',
  multipleStatements: false
};

function explain(error) {
  const code = error && error.code;
  switch (code) {
    case 'ER_ACCESS_DENIED_ERROR':
      return 'MySQL rejected the username/password or the user is not permitted from this host. In hPanel, copy the exact database username and password, confirm the user is assigned to this database with the required privileges, then restart the Node.js app.';
    case 'ER_BAD_DB_ERROR':
      return 'The database name does not exist or is not the exact Hostinger database name. Copy it from hPanel.';
    case 'ECONNREFUSED':
      return 'The database host/port refused the connection. Confirm the database host and port in hPanel; do not assume localhost.';
    case 'ETIMEDOUT':
    case 'PROTOCOL_CONNECTION_LOST':
      return 'The database connection timed out or was interrupted. Verify the database host, port, and hosting/network restrictions.';
    case 'ENOTFOUND':
      return 'The database hostname could not be resolved. Check DB_HOST for a typo.';
    default:
      return 'Check the database host, port, database/user assignment, privileges, and hosting logs. Use the error code above; do not share secrets.';
  }
}

(async () => {
  let connection;
  try {
    connection = await mysql.createConnection(config);
    const [rows] = await connection.query('SELECT 1 AS ok, DATABASE() AS database_name, CURRENT_USER() AS authenticated_as');
    console.log('[DB CHECK] PASS: connected to MySQL.');
    console.log('[DB CHECK] Host: ' + config.host + ':' + config.port);
    console.log('[DB CHECK] Database selected: ' + String(rows[0].database_name || '(none)'));
    console.log('[DB CHECK] Authenticated MySQL account: ' + String(rows[0].authenticated_as || '(unknown)'));
    console.log('[DB CHECK] Credentials were not printed.');
  } catch (error) {
    console.error('[DB CHECK] FAIL: MySQL connection was not established.');
    console.error('[DB CHECK] Error code: ' + String(error && error.code || 'UNKNOWN'));
    console.error('[DB CHECK] ' + explain(error));
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end().catch(() => {});
  }
})();

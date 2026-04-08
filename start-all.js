/**
 * Vision by Indefine — Launch Script
 * Starts both the Vision server and TallyVision (VCFO) server concurrently.
 *
 * Usage:  node start-all.js
 */

const { spawn } = require('child_process');
const path = require('path');

const VISION_DIR = path.join(__dirname, 'server');
const VCFO_DIR = path.join(__dirname, 'vcfo');

function startProcess(name, dir, command, args, env = {}) {
    const proc = spawn(command, args, {
        cwd: dir,
        stdio: 'pipe',
        shell: true,
        env: { ...process.env, ...env },
    });

    proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => console.log(`[${name}] ${line}`));
    });

    proc.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => console.error(`[${name}] ${line}`));
    });

    proc.on('close', (code) => {
        console.log(`[${name}] Process exited with code ${code}`);
    });

    proc.on('error', (err) => {
        console.error(`[${name}] Failed to start: ${err.message}`);
    });

    return proc;
}

console.log('=== Vision by Indefine — Starting All Services ===\n');

// Start Vision backend (TypeScript, port 3000)
const vision = startProcess('Vision', VISION_DIR, 'npm', ['start']);

// Start TallyVision VCFO server (port 3456)
const vcfo = startProcess('VCFO', VCFO_DIR, 'node', ['server.js']);

// Graceful shutdown
function shutdown() {
    console.log('\n=== Shutting down all services ===');
    vision.kill('SIGTERM');
    vcfo.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('Vision server starting on http://localhost:3000');
console.log('TallyVision (VCFO) starting on http://localhost:3456');
console.log('Press Ctrl+C to stop all services.\n');

#!/usr/bin/env node

/**
 * esbuild configuration for bundling the CLI into a single executable file
 */

const esbuild = require('esbuild');
const { chmod } = require('fs/promises');
const path = require('path');

const isDev = process.argv.includes('--dev');

async function build() {
  try {
    await esbuild.build({
      entryPoints: ['index.ts'],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile: 'dist/ff-cli.js',
      banner: {
        js: '#!/usr/bin/env node',
      },
      minify: !isDev,
      sourcemap: isDev ? 'inline' : false,
      // Native keyring bindings cannot be inlined. npm installs resolve this
      // normally; release archives copy the current platform's @napi-rs tree
      // beside the bundle so Node can load the OS credential backend.
      external: ['@napi-rs/keyring'],
      logLevel: 'info',
      // Remove shebangs from source files during bundling
      loader: {
        '.ts': 'ts',
      },
    });

    // Make the output file executable
    const { readFile, writeFile } = require('fs/promises');
    const outfile = path.join(__dirname, 'dist', 'ff-cli.js');

    // Remove any duplicate shebangs that may have been bundled from source
    const content = await readFile(outfile, 'utf8');
    const lines = content.split('\n');
    const filteredLines = lines.filter((line, index) => {
      // Keep the first shebang, remove any others
      if (line.startsWith('#!')) {
        return index === 0;
      }
      return true;
    });

    await writeFile(outfile, filteredLines.join('\n'));
    await chmod(outfile, 0o755);

    console.log('\nBuild complete. Single executable: dist/ff-cli.js');
    console.log('   Run with: ./dist/ff-cli.js or node dist/ff-cli.js\n');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();

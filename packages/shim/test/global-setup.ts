// Builds the shim bundle before any test runs, so integration tests spawn the
// exact artifact the plugin ships.
export default async function setup(): Promise<void> {
  // @ts-expect-error: plain .mjs build script without type declarations.
  const { buildShim } = (await import('../scripts/build.mjs')) as {
    buildShim: (o?: { quiet?: boolean }) => Promise<{ outfile: string; bytes: number }>;
  };
  const started = Date.now();
  process.stderr.write('[global-setup] building dist/shim.cjs for integration tests ...\n');
  const { bytes } = await buildShim({ quiet: true });
  process.stderr.write(`[global-setup] built in ${Date.now() - started} ms (${Math.round(bytes / 1024)} KiB)\n`);
}

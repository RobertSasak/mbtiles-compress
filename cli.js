#!/usr/bin/env node

import { run } from './index.js'
import { existsSync, statSync, mkdirSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { program } from 'commander'

program
  .name('mbtiles-compress')
  .description('Compress MBTiles files using WebP compression')
  .argument('<source>', 'Path to source MBTiles file')
  .argument('<destination>', 'Path to output compressed MBTiles file')
  .option('-q, --quality <number>', 'WebP compression quality (0-100)', '75')
  .option(
    '-a, --alpha-quality <number>',
    'WebP alpha quality (0-100, default: 100)',
    '100'
  )
  .option(
    '-m, --method <number>',
    'WebP compression method (0-6, default: 4)',
    '4'
  )
  .option(
    '-c, --concurrency <number>',
    'Number of parallel compression operations',
    '20'
  )
  .option('-f, --force', 'Overwrite destination if it exists', false)
  .option('-s, --skip-count', 'Skip counting rows before compression', false)
  .action(async (source, destination, options) => {
    const quality = parseInt(options.quality)
    const alphaQuality = parseInt(options.alphaQuality)
    const method = parseInt(options.method)
    const concurrency = parseInt(options.concurrency)
    const force = !!options.force
    const skipCount = !!options.skipCount

    if (isNaN(quality) || quality < 0 || quality > 100) {
      throw new Error('Quality must be a number between 0 and 100')
    }
    if (isNaN(alphaQuality) || alphaQuality < 0 || alphaQuality > 100) {
      throw new Error('Alpha quality must be a number between 0 and 100')
    }
    if (isNaN(method) || method < 0 || method > 6) {
      throw new Error('Method must be a number between 0 and 6')
    }
    if (isNaN(concurrency) || concurrency < 1 || concurrency > 100) {
      throw new Error('Concurrency must be a number between 1 and 100')
    }
    if (!existsSync(source)) {
      throw new Error(`Source file does not exist: ${source}`)
    }
    if (!statSync(source).isFile()) {
      throw new Error(`Source path is not a file: ${source}`)
    }
    const destDir = dirname(destination)
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true })
    }
    if (existsSync(destination)) {
      if (!force) {
        throw new Error(
          `Destination already exists: ${destination}. Use --force to overwrite.`
        )
      }
      unlinkSync(destination)
    }

    await run(
      source,
      destination,
      quality,
      alphaQuality,
      method,
      concurrency,
      skipCount
    )
  })

try {
  program.parse()
} catch (err) {
  console.error('\x1b[31m%s\x1b[0m', 'Error:', err.message)
  process.exit(1)
}

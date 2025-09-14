#!/usr/bin/env node

import { program } from 'commander'
import { existsSync, statSync, mkdirSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import imagemin from 'imagemin'
import imageminWebp from 'imagemin-webp'

/**
 * Compute MD5 hex digest of a Buffer
 * @param {Buffer} buffer - Image buffer
 * @returns {string} md5 hex string
 */
function md5_hex(buffer) {
  return createHash('md5').update(buffer).digest('hex')
}

/**
 * Compress a single tile's raw data buffer
 * @param {Buffer} tileData - Raw image tile buffer
 * @param {number} quality - WebP compression quality (0-100)r\
 * @param {number} alphaQuality - WebP alpha quality (0-100)
 * @param {number} method - WebP compression method (0-6)
 * @returns {Promise<Buffer>} Compressed tile data
 */
async function compressTile(tileData, quality, alphaQuality, method) {
  return await imagemin.buffer(tileData, {
    plugins: [imageminWebp({ quality, alphaQuality, method })],
  })
}

async function main() {
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
    .action(async (source, destination, options) => {
      try {
        const quality = parseInt(options.quality)
        const alphaQuality = parseInt(options.alphaQuality)
        const method = parseInt(options.method)
        const concurrency = parseInt(options.concurrency)
        const force = !!options.force

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

        const sourceDb = new Database(source, { readonly: true })
        const destDb = new Database(destination)

        try {
          destDb.pragma('journal_mode = WAL')

          console.log('Copying MBTiles structure')
          const objects = sourceDb
            .prepare(`SELECT name, type, sql FROM sqlite_master`)
            .all()

          // Create all tables
          for (const { sql, type } of objects) {
            if (type == 'table' && sql) {
              destDb.exec(sql)
            }
          }

          // Attach and copy all tables except images and map
          destDb.exec(`ATTACH DATABASE '${source}' AS source`)
          for (const { name, type } of objects) {
            if (type === 'table' && name !== 'images' && name !== 'map') {
              destDb.exec(`INSERT INTO ${name} SELECT * FROM source.${name}`)
            }
          }
          destDb.exec(`DETACH DATABASE source`)

          console.log('Creating indexes and view')
          for (const { sql, type } of objects) {
            if (type !== 'table' && sql) {
              destDb.exec(sql)
            }
          }

          console.log('Compressing image tiles')
          const totalCount = sourceDb
            .prepare(`SELECT COUNT(*) as count FROM tiles`)
            .get().count
          console.log(`Found ${totalCount} image tiles to compress`)

          let processed = 0
          let failed = 0
          const activePromises = new Set()

          const insertTile = destDb.prepare(
            `INSERT OR IGNORE INTO images (tile_id, tile_data) VALUES (?, ?)`
          )
          const insertMap = destDb.prepare(
            `INSERT INTO map (zoom_level, tile_column, tile_row, tile_id, grid_id) VALUES (?, ?, ?, ?, null)`
          )
          const tiles = sourceDb
            .prepare(
              `SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles`
            )
            .iterate()

          for (const {
            zoom_level,
            tile_column,
            tile_row,
            tile_data,
          } of tiles) {
            if (activePromises.size >= concurrency) {
              await Promise.race(activePromises)
            }

            const compressionPromise = compressTile(
              tile_data,
              quality,
              alphaQuality,
              method
            )
              .then(async (compressedData) => {
                const newTileId = md5_hex(compressedData)
                await Promise.all([
                  insertTile.run(newTileId, compressedData),
                  insertMap.run(zoom_level, tile_column, tile_row, newTileId),
                ])
              })
              .catch(({ message }) => {
                console.warn(
                  `Failed to compress tile ${zoom_level}, ${tile_column}, ${tile_row}: ${message}`
                )
                failed++
              })
              .finally(() => {
                processed++
                if (processed % 100 === 0) {
                  console.log(
                    `Processed ${processed}/${totalCount} image tiles`
                  )
                }
                activePromises.delete(compressionPromise)
              })
            activePromises.add(compressionPromise)
          }
          await Promise.all(activePromises)

          console.log(`Successfully processed ${processed} image tiles.`)
          if (failed > 0) {
            console.log(
              '\x1b[33m%s\x1b[0m',
              `Warning: ${failed} tiles failed to compress and were skipped.`
            )
          }

          console.log('Optimizing destination database')
          destDb.exec('PRAGMA optimize')
          destDb.exec('ANALYZE')
          destDb.exec('VACUUM')
        } finally {
          sourceDb.close()
          destDb.close()
        }

        console.log('Compression completed successfully!')
      } catch ({ message }) {
        console.error('\x1b[31m%s\x1b[0m', 'Error:', message)
        process.exit(1)
      }
    })

  program.parse()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}

export { compressTile, md5_hex }

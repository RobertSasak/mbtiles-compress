import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import sharp from 'sharp'

const LOG_FREQUENCY = 100

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
 * @param {number} quality - WebP compression quality (0-100)
 * @param {number} alphaQuality - WebP alpha quality (0-100)
 * @param {number} method - WebP compression method (0-6)
 * @returns {Promise<Buffer>} Compressed tile data
 */
async function compressTile(tileData, quality, alphaQuality, method) {
  return await sharp(tileData)
    .webp({ quality, alphaQuality, effort: method })
    .toBuffer()
}

/**
 * Compresses an MBTiles file using WebP compression.
 *
 * @param {string} source - Path to source MBTiles file
 * @param {string} destination - Path to output compressed MBTiles file
 * @param {number} quality - WebP compression quality (0-100)
 * @param {number} alphaQuality - WebP alpha quality (0-100)
 * @param {number} method - WebP compression method (0-6)
 * @param {number} concurrency - Number of parallel compression operations
 * @param {boolean} [skipCount=false] - If true, skip counting rows and progress reporting
 * @returns {Promise<void>} Resolves when compression is complete
 */
async function run(
  source,
  destination,
  quality,
  alphaQuality,
  method,
  concurrency,
  skipCount = false
) {
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

    // Attach and copy all tables except images
    destDb.exec(`ATTACH DATABASE '${source}' AS source`)
    for (const { name, type } of objects) {
      if (type === 'table' && name !== 'images') {
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

    // Create a temporary index to speed up map lookups
    destDb.exec('CREATE INDEX map_tile_id ON map (tile_id)')

    let totalCount = undefined
    if (!skipCount) {
      totalCount = sourceDb
        .prepare(`SELECT COUNT(*) as count FROM images`)
        .get().count
      console.log(`Found ${totalCount} image tiles to compress`)
    }

    let processed = 0
    let failed = 0
    const activePromises = new Set()

    const insertImage = destDb.prepare(
      `INSERT OR IGNORE INTO images (tile_id, tile_data) VALUES (?, ?)`
    )
    const updateMap = destDb.prepare(
      `UPDATE map SET tile_id = ? WHERE tile_id = ?`
    )
    const tiles = sourceDb
      .prepare(`SELECT tile_id, tile_data FROM images`)
      .raw()
      .iterate()

    console.log('Compressing image tiles')

    const start = performance.now()
    for (const [tile_id, tile_data] of tiles) {
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
          await destDb.transaction(() => {
            insertImage.run(newTileId, compressedData)
            updateMap.run(newTileId, tile_id)
          })()
        })
        .catch(({ message }) => {
          console.warn(`Failed to compress tile ${tile_id}: ${message}`)
          failed++
        })
        .finally(() => {
          processed++
          if (processed % LOG_FREQUENCY === 0) {
            const elapsed = performance.now() - start
            const perSecond = (1000 * processed) / elapsed
            const eta = new Intl.DurationFormat('en', {
              style: 'short',
            }).format({
              seconds: Math.round((totalCount - processed) / perSecond),
            })

            process.stdout.write(
              `\rProcessed ${processed}${
                totalCount ? '/' + totalCount : ''
              } image tiles ~ ${perSecond.toFixed(0)} tiles/s  ETA: ${eta}`
            )
          }
          activePromises.delete(compressionPromise)
        })
      activePromises.add(compressionPromise)
    }
    await Promise.all(activePromises)

    console.log(`\nSuccessfully processed ${processed} image tiles.`)
    if (failed > 0) {
      console.log(
        '\x1b[33m%s\x1b[0m',
        `Warning: ${failed} tiles failed to compress and were skipped.`
      )
    }

    console.log('Optimizing database')
    await destDb.exec('DROP INDEX map_tile_id') // Drop temporary index
    await destDb.exec('PRAGMA optimize')
    await destDb.exec('ANALYZE')
    await destDb.exec('VACUUM')
    console.log('Compression completed successfully!')
  } finally {
    sourceDb.close()
    destDb.close()
  }
}

export { compressTile, md5_hex, run }
